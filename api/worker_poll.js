import { queryD1, executeD1 } from './_lib/db.js';
import { requireWorkerAuth, sendSuccess, sendError, validateBody } from './_lib/middleware.js';
import { getCpu, getRamGb } from './_lib/plans.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
  if (!requireWorkerAuth(req, res)) return;

  const valid = validateBody(req, res, {
    vm_id: { required: true, type: 'string' }
  });
  if (!valid) return;

  const { vm_id } = req.body;

  try {
    // 1. Check for tasks already explicitly assigned to this VM by dispatch
    const assignedSessions = await queryD1(
      `SELECT s.*, i.servername, i.game, i.software, i.version, i.ram, u.plan 
       FROM sessions s 
       JOIN instances i ON s.instance_id = i.instance_id 
       JOIN users u ON s.username = u.username
       WHERE s.vm_id = ? AND s.status = 'assigned' 
       ORDER BY s.started_at ASC LIMIT 1`,
      [vm_id]
    );

    let task = assignedSessions?.[0];

    // 2. If no assigned task, try to pick up a queued task if we have capacity
    if (!task) {
      const vmRecs = await queryD1('SELECT used_ram, used_cpu FROM vms WHERE vm_id = ?', [vm_id]);
      if (vmRecs && vmRecs.length > 0) {
        const vm = vmRecs[0];
        const free_ram = 16 - (vm.used_ram || 0); // MAX 16GB
        const free_cpu = 4 - (vm.used_cpu || 0);  // MAX 4 Cores

        const queuedSessions = await queryD1(
          `SELECT s.*, i.servername, i.game, i.software, i.version, i.ram, u.plan 
           FROM sessions s 
           JOIN instances i ON s.instance_id = i.instance_id 
           JOIN users u ON s.username = u.username
           WHERE s.status = 'queued' AND s.vm_id IS NULL
           ORDER BY s.started_at ASC`
        );

        for (const q of (queuedSessions || [])) {
          const req_ram = getRamGb(q.plan);
          const req_cpu = getCpu(q.plan);
          
          if (free_ram >= req_ram && free_cpu >= req_cpu) {
            // Found a fit! Atomic update to claim it.
            const claimResult = await executeD1(
              `UPDATE sessions SET vm_id = ?, status = 'assigned' WHERE session_id = ? AND status = 'queued'`,
              [vm_id, q.session_id]
            );
            
            if (claimResult.changes > 0) {
              // Also update VM capacity in DB immediately to prevent double-booking
              await executeD1(
                `UPDATE vms SET used_ram = used_ram + ?, used_cpu = used_cpu + ? WHERE vm_id = ?`,
                [req_ram, req_cpu, vm_id]
              );
              task = q;
              task.status = 'assigned';
              task.vm_id = vm_id;
              break;
            }
          }
        }
      }
    }

    if (!task) {
      return sendSuccess(res, { task: null });
    }

    // Mark as running so it isn't picked up again
    await executeD1(
      "UPDATE sessions SET status = 'running' WHERE session_id = ?",
      [task.session_id]
    );

    return sendSuccess(res, { task });
  } catch (error) {
    console.error('Worker poll error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}
