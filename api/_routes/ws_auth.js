import { requireAuth, sendSuccess, sendError } from '../_lib/middleware.js';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

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
    // Generate a short-lived token specifically for WS auth
    const wsToken = jwt.sign(
      { session_id, username: user.username, type: 'ws_auth' },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    return sendSuccess(res, { ws_token: wsToken });
  } catch (error) {
    return sendError(res, 500, 'Internal server error');
  }
}
