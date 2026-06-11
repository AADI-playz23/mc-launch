import workerApiHandler from './_routes/worker_api.js';
import workerPollHandler from './_routes/worker_poll.js';
import { sendError } from './_lib/middleware.js';

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/api/worker_api') return workerApiHandler(req, res);
  if (path === '/api/worker_poll') return workerPollHandler(req, res);
  return sendError(res, 404, 'API endpoint not found');
}