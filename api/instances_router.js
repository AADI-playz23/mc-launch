import instancesHandler from './_routes/instances.js';
import dispatchHandler from './_routes/dispatch.js';
import statusHandler from './_routes/status.js';
import renewHandler from './_routes/renew.js';
import { sendError } from './_lib/middleware.js';

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/api/instances') return instancesHandler(req, res);
  if (path === '/api/dispatch') return dispatchHandler(req, res);
  if (path === '/api/status') return statusHandler(req, res);
  if (path === '/api/renew') return renewHandler(req, res);
  return sendError(res, 404, 'API endpoint not found');
}