import { queryD1, executeD1 } from './_lib/db.js';
import { requireWorkerAuth, sendSuccess, sendError, validateBody } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
  if (!requireWorkerAuth(req, res)) return;

  const valid = validateBody(req, res, {
    op: { required: true, type: 'string' },
    vm_id: { required: true, type: 'string' }
  });
  if (!valid) return;

  const { op, vm_id, worker_url, used_ram, used_cpu } = req.body;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (op === 'register_vm') {
      if (!worker_url) return sendError(res, 400, 'worker_url required');
      
      // Upsert VM record
      const existing = await queryD1('SELECT vm_id FROM vms WHERE vm_id = ?', [vm_id]);
      if (existing && existing.length > 0) {
        await executeD1(
          'UPDATE vms SET worker_url = ?, used_ram = ?, used_cpu = ?, last_heartbeat = ? WHERE vm_id = ?',
          [worker_url, used_ram || 0, used_cpu || 0, now, vm_id]
        );
      } else {
        await executeD1(
          'INSERT INTO vms (vm_id, worker_url, used_ram, used_cpu, last_heartbeat) VALUES (?, ?, ?, ?, ?)',
          [vm_id, worker_url, used_ram || 0, used_cpu || 0, now]
        );
      }
      return sendSuccess(res, { message: 'VM registered', vm_id });
    }

    if (op === 'vm_heartbeat') {
      const result = await executeD1(
        'UPDATE vms SET used_ram = ?, used_cpu = ?, last_heartbeat = ? WHERE vm_id = ?',
        [used_ram || 0, used_cpu || 0, now, vm_id]
      );
      
      if (result.changes === 0) {
        return sendError(res, 404, 'VM not found'); // Tells daemon to re-register
      }

      // Find expired sessions for this VM
      const expired = await queryD1(
        "SELECT session_id FROM sessions WHERE vm_id = ? AND status IN ('assigned', 'running') AND expires_at < ?",
        [vm_id, now]
      );
      
      const kill_sessions = expired ? expired.map(s => s.session_id) : [];

      // Update sessions that are expired in DB
      if (kill_sessions.length > 0) {
        const placeholders = kill_sessions.map(() => '?').join(',');
        await executeD1(
          `UPDATE sessions SET status = 'expired' WHERE session_id IN (${placeholders})`,
          kill_sessions
        );
      }

      return sendSuccess(res, { kill_sessions });
    }

    if (op === 'deregister_vm') {
      await executeD1('DELETE FROM vms WHERE vm_id = ?', [vm_id]);
      // Also cleanup sessions
      await executeD1("UPDATE sessions SET status = 'stopped' WHERE vm_id = ? AND status IN ('assigned', 'running')", [vm_id]);
      return sendSuccess(res, { message: 'VM deregistered' });
    }

    if (op === 'session_stopped') {
        const { session_id } = req.body;
        if(session_id) {
            await executeD1("UPDATE sessions SET status = 'stopped' WHERE session_id = ?", [session_id]);
        }
        return sendSuccess(res, { message: 'Session stopped' });
    }

    return sendError(res, 400, 'Invalid operation');
  } catch (error) {
    console.error('Worker API error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}
