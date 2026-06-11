import { queryD1, executeD1 } from './_lib/db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { serialize } from 'cookie';
import { JWT_SECRET, sendSuccess, sendError, validateBody } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed');
  }

  const valid = validateBody(req, res, {
    op: { required: true, type: 'string' },
    username: {
      required: true,
      type: 'string',
      minLength: 3,
      maxLength: 24,
      pattern: /^[a-z0-9_]+$/,
    },
    password: {
      required: true,
      type: 'string',
      minLength: 6,
      maxLength: 128,
    },
  });
  if (!valid) return;

  const { op, username, password } = req.body;
  const usernameLower = username.toLowerCase();

  try {
    if (op === 'register') {
      const existingUser = await queryD1('SELECT id FROM users WHERE username = ?', [usernameLower]);
      if (existingUser && existingUser.length > 0) {
        return sendError(res, 400, 'Username already exists');
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      await executeD1(
        'INSERT INTO users (username, password, plan) VALUES (?, ?, ?)',
        [usernameLower, hashedPassword, 'free']
      );

      return sendSuccess(res, { message: 'User registered' });
    }

    if (op === 'login') {
      const users = await queryD1('SELECT * FROM users WHERE username = ?', [usernameLower]);
      if (!users || users.length === 0) {
        return sendError(res, 401, 'Invalid credentials');
      }

      const user = users[0];
      const validPass = await bcrypt.compare(password, user.password);
      if (!validPass) {
        return sendError(res, 401, 'Invalid credentials');
      }

      if (user.banned === 1) {
        return sendError(res, 403, 'Account banned');
      }

      const token = jwt.sign(
        { userId: user.id, username: user.username, plan: user.plan, isAdmin: user.is_admin },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.setHeader('Set-Cookie', serialize('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      }));

      return sendSuccess(res, {
        message: 'Logged in',
        user: { username: user.username, plan: user.plan, is_admin: user.is_admin },
      });
    }

    return sendError(res, 400, 'Invalid operation');

  } catch (error) {
    console.error('Auth error:', error);
    return sendError(res, 500, 'Internal server error');
  }
}
