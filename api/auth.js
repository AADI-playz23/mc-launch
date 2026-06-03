import { queryD1, executeD1 } from './db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { serialize } from 'cookie';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-key-123';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const { op, username, password, invite } = req.body;

  if (!username || !password) {
    return res.status(400).json({ status: "error", message: "Username and password required" });
  }

  try {
    if (op === 'register') {
      // Check if user exists
      const existingUser = await queryD1("SELECT id FROM users WHERE username = ?", [username]);
      if (existingUser && existingUser.length > 0) {
        return res.status(400).json({ status: "error", message: "Username already exists" });
      }

      // Hash password and insert
      const hashedPassword = await bcrypt.hash(password, 10);
      await executeD1(
        "INSERT INTO users (username, password, plan) VALUES (?, ?, ?)",
        [username, hashedPassword, 'free']
      );

      return res.status(200).json({ status: "success", message: "User registered" });
    } 
    
    if (op === 'login') {
      // Find user
      const users = await queryD1("SELECT * FROM users WHERE username = ?", [username]);
      if (!users || users.length === 0) {
        return res.status(401).json({ status: "error", message: "Invalid credentials" });
      }

      const user = users[0];
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ status: "error", message: "Invalid credentials" });
      }

      if (user.banned === 1) {
        return res.status(403).json({ status: "error", message: "Account banned" });
      }

      // Issue JWT
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
        path: '/'
      }));

      return res.status(200).json({ 
        status: "success", 
        message: "Logged in",
        user: { username: user.username, plan: user.plan, is_admin: user.is_admin }
      });
    }

    return res.status(400).json({ status: "error", message: "Invalid operation" });

  } catch (error) {
    console.error("Auth error:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}
