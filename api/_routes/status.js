import { queryD1, executeD1 } from '../_lib/db.js';
import { requireAuth, sendSuccess, sendError } from '../_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const { session_id } = req.query;
  if (!session_id) {
    return sendError(res, 400, 'session_id required');
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const VM_HEARTBEAT_STALE_SECS = 8;

    // --- SELF HEALING: Clean up dead VMs ---
    await executeD1(`
      UPDATE sessions SET status = 'stopped' 
      WHERE vm_id IN (SELECT vm_id FROM vms WHERE last_heartbeat < ?) 
      AND status IN ('assigned', 'booting', 'running')`, 
      [now - VM_HEARTBEAT_STALE_SECS]
    );
    await executeD1("DELETE FROM vms WHERE last_heartbeat < ?", [now - VM_HEARTBEAT_STALE_SECS]);
    // ---------------------------------------

    const sessions = await queryD1(
      'SELECT s.session_id, s.status, s.expires_at, s.started_at, v.worker_url FROM sessions s LEFT JOIN vms v ON s.vm_id = v.vm_id WHERE s.session_id = ? AND s.username = ?',
      [session_id, user.username]
    );

    if (!sessions || sessions.length === 0) {
      return sendError(res, 404, 'Session not found');
    }

    const session = sessions[0];

    let status = session.status;
    if (status === 'running' && session.expires_at && session.expires_at < now) {
      status = 'expired';
    }

    return sendSuccess(res, {
      status: status,
      worker_url: session.worker_url || null,
      expires_at: session.expires_at,
      started_at: session.started_at,
    });

  } catch (error) {
    return sendError(res, 500, error.message);
  }
}
