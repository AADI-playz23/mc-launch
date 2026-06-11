import { getPublicPlans } from '../_lib/plans.js';
import { sendSuccess, sendError } from '../_lib/middleware.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return sendError(res, 405, 'Method not allowed');
  }

  try {
    const plans = getPublicPlans();
    return sendSuccess(res, { plans });
  } catch (error) {
    console.error('Plans API error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}
