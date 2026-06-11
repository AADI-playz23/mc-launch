import authHandler from './_routes/auth.js';
import wsAuthHandler from './_routes/ws_auth.js';
import { sendError } from './_lib/middleware.js';

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/api/auth') return authHandler(req, res);
  if (path === '/api/ws_auth') return wsAuthHandler(req, res);
  return sendError(res, 404, 'API endpoint not found');
}