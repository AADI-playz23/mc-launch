import { queryD1, executeD1 } from '../_lib/db.js';
import { requireAuth, sendSuccess, sendError } from '../_lib/middleware.js';
import { getSessionDurationSecs } from '../_lib/plans.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const user = requireAuth(req, res);
  if (!user) return;

  const { session_id } = req.body;
  if (!session_id) {
    return sendError(res, 400, 'session_id required');
  }

  try {
    const sessions = await queryD1(
      'SELECT * FROM sessions WHERE session_id = ? AND username = ?',
      [session_id, user.username]
    );

    if (!sessions || sessions.length === 0) {
      return sendError(res, 404, 'Session not found');
    }

    const session = sessions[0];

    // Don't renew terminated sessions
    if (session.status === 'terminated' || session.status === 'expired') {
      return sendError(res, 400, 'Cannot renew a stopped session. Start a new one.');
    }

    // Determine renewal duration from plan
    const addSeconds = getSessionDurationSecs(user.plan);
    const now = Math.floor(Date.now() / 1000);

    // If expired or close, renew from now. Otherwise add to existing expiry.
    let currentExpiry = session.expires_at || now;
    if (currentExpiry < now) currentExpiry = now;

    const newExpiry = currentExpiry + addSeconds;

    await executeD1(
      'UPDATE sessions SET expires_at = ? WHERE session_id = ?',
      [newExpiry, session_id]
    );

    return sendSuccess(res, {
      message: 'Server renewed successfully!',
      expires_at: newExpiry,
    });

  } catch (error) {
    console.error('Renew error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}
