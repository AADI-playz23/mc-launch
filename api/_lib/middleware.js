import { parse } from 'cookie';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-key-123';
const WORKER_SECRET = process.env.WORKER_SECRET || '';

// ── Standardized Response Helpers ──

export function sendSuccess(res, data = {}, code = 200) {
  return res.status(code).json({ status: 'success', ...data });
}

export function sendError(res, code, message) {
  return res.status(code).json({ status: 'error', message });
}

// ── User Authentication (JWT Cookie) ──

export function getAuthUser(req) {
  try {
    const cookies = parse(req.headers.cookie || '');
    const token = cookies.auth_token;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    sendError(res, 401, 'Unauthorized');
    return null;
  }
  return user;
}

export function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.isAdmin) {
    sendError(res, 403, 'Admin access required');
    return null;
  }
  return user;
}

// ── Worker Authentication (Bearer Token) ──

export function requireWorkerAuth(req, res) {
  if (!WORKER_SECRET) {
    // If no worker secret configured, skip auth (for initial setup)
    return true;
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || !timingSafeEqual(token, WORKER_SECRET)) {
    sendError(res, 401, 'Invalid worker credentials');
    return false;
  }
  return true;
}

// ── Input Validation ──

export function validateBody(req, res, schema) {
  const body = req.body || {};
  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];

    if (rules.required && (value === undefined || value === null || value === '')) {
      sendError(res, 400, `Missing required field: ${field}`);
      return false;
    }

    if (value !== undefined && value !== null) {
      if (rules.type && typeof value !== rules.type) {
        sendError(res, 400, `Invalid type for ${field}: expected ${rules.type}`);
        return false;
      }
      if (rules.pattern && !rules.pattern.test(String(value))) {
        sendError(res, 400, `Invalid format for ${field}`);
        return false;
      }
      if (rules.minLength && String(value).length < rules.minLength) {
        sendError(res, 400, `${field} must be at least ${rules.minLength} characters`);
        return false;
      }
      if (rules.maxLength && String(value).length > rules.maxLength) {
        sendError(res, 400, `${field} must be at most ${rules.maxLength} characters`);
        return false;
      }
    }
  }
  return true;
}

// ── Helpers ──

function timingSafeEqual(a, b) {
  try {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

// Re-export JWT_SECRET for auth.js token signing
export { JWT_SECRET };
