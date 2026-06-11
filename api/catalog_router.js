import softwareHandler from './_routes/software.js';
import pluginsHandler from './_routes/plugins.js';
import plansPublicHandler from './_routes/plans_public.js';
import { sendError } from './_lib/middleware.js';

export default async function handler(req, res) {
  const path = req.url.split('?')[0];
  if (path === '/api/software') return softwareHandler(req, res);
  if (path === '/api/plugins') return pluginsHandler(req, res);
  if (path === '/api/plans_public') return plansPublicHandler(req, res);
  return sendError(res, 404, 'API endpoint not found');
}