import { executeD1 } from './_lib/db.js';
import { requireAdmin, sendSuccess, sendError } from './_lib/middleware.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'Method not allowed');
  
  // You can also add a secret token check here if running from CLI
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const WORKER_SECRET = process.env.WORKER_SECRET || '';
  
  let authorized = false;
  
  // Allow if admin cookie OR worker secret is provided
  const user = await import('./_lib/middleware.js').then(m => m.getAuthUser(req));
  if (user && user.isAdmin) authorized = true;
  if (WORKER_SECRET && token === WORKER_SECRET) authorized = true;
  
  if (!authorized) {
    return sendError(res, 401, 'Unauthorized for DB setup');
  }

  const queries = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      is_admin INTEGER DEFAULT 0,
      banned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS instances (
      instance_id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      servername TEXT NOT NULL,
      game TEXT NOT NULL,
      software TEXT NOT NULL,
      version TEXT NOT NULL,
      java_version TEXT DEFAULT '21',
      ram TEXT NOT NULL,
      status TEXT DEFAULT 'offline',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (username) REFERENCES users(username)
    )`,
    `CREATE TABLE IF NOT EXISTS vms (
      vm_id TEXT PRIMARY KEY,
      worker_url TEXT NOT NULL,
      used_ram INTEGER DEFAULT 0,
      used_cpu INTEGER DEFAULT 0,
      last_heartbeat INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      instance_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      vm_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
    )`,
    `CREATE TABLE IF NOT EXISTS backups (
      backup_id TEXT PRIMARY KEY,
      instance_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
    )`,
    `CREATE TABLE IF NOT EXISTS schedules (
      schedule_id TEXT PRIMARY KEY,
      instance_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      interval_hours INTEGER NOT NULL,
      last_run INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
    )`
  ];

  try {
    for (const sql of queries) {
      await executeD1(sql);
    }
    
    try {
        await executeD1(`ALTER TABLE instances ADD COLUMN java_version TEXT DEFAULT '21'`);
    } catch(e) {}
    
    return sendSuccess(res, { message: 'Database schema created/updated successfully' });
  } catch (error) {
    console.error('Setup DB Error:', error);
    return sendError(res, 500, error.message);
  }
}
