import { queryD1, executeD1 } from './_lib/db.js';
import { requireAuth, sendSuccess, sendError, validateBody } from './_lib/middleware.js';
import { getPlan } from './_lib/plans.js';

export default async function handler(req, res) {
  const user = requireAuth(req, res);
  if (!user) return;

  // GET: List all instances for the user
  if (req.method === 'GET') {
    try {
      const instances = await queryD1(
        'SELECT * FROM instances WHERE username = ? ORDER BY created_at DESC',
        [user.username]
      );
      return sendSuccess(res, { instances: instances || [] });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  // POST: Create a new instance
  if (req.method === 'POST') {
    const valid = validateBody(req, res, {
      servername: {
        required: true,
        type: 'string',
        minLength: 2,
        maxLength: 32,
        pattern: /^[a-z0-9-]+$/,
      },
      game: { required: true, type: 'string' },
      software: { required: true, type: 'string' },
      version: { required: true, type: 'string' },
    });
    if (!valid) return;

    const { servername, game, software, version } = req.body;
    const plan = getPlan(user.plan);

    try {
      // Enforce slot limit
      const existing = await queryD1(
        'SELECT COUNT(*) as count FROM instances WHERE username = ?',
        [user.username]
      );
      const currentCount = existing?.[0]?.count || 0;

      if (currentCount >= plan.slots) {
        return sendError(res, 403, `Your ${plan.label} plan allows ${plan.slots} instance(s). Upgrade to create more.`);
      }

      await executeD1(
        'INSERT INTO instances (username, servername, game, software, version, ram) VALUES (?, ?, ?, ?, ?, ?)',
        [user.username, servername, game, software, version, plan.ram]
      );

      return sendSuccess(res, { message: 'Server instance created' });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  // DELETE: Remove an instance
  if (req.method === 'DELETE') {
    const valid = validateBody(req, res, {
      instance_id: { required: true },
    });
    if (!valid) return;

    const { instance_id } = req.body;

    try {
      // Also clean up any sessions for this instance
      await executeD1(
        'DELETE FROM sessions WHERE instance_id = ? AND username = ?',
        [instance_id, user.username]
      );

      await executeD1(
        'DELETE FROM instances WHERE instance_id = ? AND username = ?',
        [instance_id, user.username]
      );

      return sendSuccess(res, { message: 'Server deleted' });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  // PATCH: Update instance software and version
  if (req.method === 'PATCH') {
    const valid = validateBody(req, res, {
      instance_id: { required: true },
      software: { required: true, type: 'string' },
      version: { required: true, type: 'string' },
    });
    if (!valid) return;

    const { instance_id, software, version } = req.body;

    try {
      await executeD1(
        'UPDATE instances SET software = ?, version = ? WHERE instance_id = ? AND username = ?',
        [software, version, instance_id, user.username]
      );
      return sendSuccess(res, { message: 'Server software updated. Restart server to apply changes.' });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  return sendError(res, 405, 'Method not allowed');
}
