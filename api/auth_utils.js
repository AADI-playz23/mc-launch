import { parse } from 'cookie';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-dev-secret-key-123';

export function getAuthUser(req) {
  try {
    const cookies = parse(req.headers.cookie || '');
    const token = cookies.auth_token;
    
    if (!token) return null;
    
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    return null;
  }
}
