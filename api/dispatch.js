import { queryD1, executeD1 } from './_lib/db.js';
import { requireAuth, sendSuccess, sendError } from './_lib/middleware.js';
import { getRamGb, getCpu, getSessionDurationSecs } from './_lib/plans.js';

const MAX_VM_RAM_GB = 16;
const MAX_VM_CPU = 4;
const MAX_ACTIVE_RUNNERS = 5;
const VM_HEARTBEAT_STALE_SECS = 180;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const { instance_id } = req.body;
  if (!instance_id) {
    return sendError(res, 400, 'instance_id required');
  }

  try {
    // 1. Get instance details (ownership check)
    const instances = await queryD1(
      'SELECT * FROM instances WHERE instance_id = ? AND username = ?',
      [instance_id, user.username]
    );
    if (!instances || instances.length === 0) {
      return sendError(res, 404, 'Instance not found');
    }
    const instance = instances[0];

    // 2. Check if this instance already has an active session
    const activeSessions = await queryD1(
      "SELECT session_id, status FROM sessions WHERE instance_id = ? AND status IN ('queued', 'assigned', 'running')",
      [instance_id]
    );
    if (activeSessions && activeSessions.length > 0) {
      const existing = activeSessions[0];
      return sendError(res, 409, `Instance already has an active session (${existing.session_id}). Stop it first.`);
    }

    // 3. Determine required resources from plan
    const required_ram = getRamGb(user.plan);
    const required_cpu = getCpu(user.plan);
    const sessionDuration = getSessionDurationSecs(user.plan);

    const now = Math.floor(Date.now() / 1000);
    const expires_at = now + sessionDuration;
    const session_id = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // 4. Find an active VM with available capacity
    const activeVms = await queryD1(
      'SELECT * FROM vms WHERE last_heartbeat > ?',
      [now - VM_HEARTBEAT_STALE_SECS]
    );

    let assigned_vm = null;
    for (const vm of activeVms) {
      const free_ram = MAX_VM_RAM_GB - vm.used_ram;
      const free_cpu = MAX_VM_CPU - vm.used_cpu;
      if (free_ram >= required_ram && free_cpu >= required_cpu) {
        assigned_vm = vm;
        break;
      }
    }

    // 5. If VM found, assign with atomic capacity update
    if (assigned_vm) {
      const capacityResult = await executeD1(
        'UPDATE vms SET used_ram = used_ram + ?, used_cpu = used_cpu + ? WHERE vm_id = ? AND (? - used_ram) >= ? AND (? - used_cpu) >= ?',
        [required_ram, required_cpu, assigned_vm.vm_id, MAX_VM_RAM_GB, required_ram, MAX_VM_CPU, required_cpu]
      );

      if (capacityResult.changes === 0) {
        assigned_vm = null;
      } else {
        await executeD1(
          'INSERT INTO sessions (session_id, instance_id, username, vm_id, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [session_id, instance.instance_id, user.username, assigned_vm.vm_id, 'assigned', now, expires_at]
        );

        return sendSuccess(res, {
          message: 'Server assigned to active runner',
          session_id,
          worker_url: assigned_vm.worker_url,
        });
      }
    }

    // 6. No VM available: Queue the session
    await executeD1(
      'INSERT INTO sessions (session_id, instance_id, username, vm_id, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [session_id, instance.instance_id, user.username, null, 'queued', now, expires_at]
    );

    if (activeVms.length < MAX_ACTIVE_RUNNERS) {
      const triggerRes = await triggerGitHubAction();
      if (triggerRes.ok) {
        return sendSuccess(res, { status: 'queued', message: 'Runner is starting. You are in the queue.', session_id });
      } else {
        return sendSuccess(res, { status: 'queued', message: 'Added to queue. Runner trigger failed — an existing runner may pick it up.', session_id });
      }
    } else {
      return sendSuccess(res, { status: 'queued', message: `System at max capacity (${MAX_ACTIVE_RUNNERS} runners). You are in the queue.`, session_id });
    }

  } catch (error) {
    console.error('Dispatch error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}

async function triggerGitHubAction() {
  const token = process.env.ABSORA_PAT;
  const repo = process.env.RUNNER_REPO || 'AADI-playz23/mc-launch';
  if (!token) return { ok: false };

  const url = `https://api.github.com/repos/${repo}/actions/workflows/host.yml/dispatches`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { runner_type: 'multi-tenant' } }),
    });
    return { ok: r.ok };
  } catch {
    return { ok: false };
  }
}
