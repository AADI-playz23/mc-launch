import { executeD1 } from './db.js';

export default async function handler(req, res) {
  try {
    // 1. Users Table
    await executeD1(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        plan TEXT DEFAULT 'free',
        is_admin INTEGER DEFAULT 0,
        banned INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Instances Table
    await executeD1(`
      CREATE TABLE IF NOT EXISTS instances (
        instance_id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        servername TEXT NOT NULL,
        game TEXT DEFAULT 'minecraft',
        software TEXT,
        version TEXT,
        ram TEXT DEFAULT '4G',
        status TEXT DEFAULT 'offline',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. VMs Table (Runners)
    await executeD1(`
      CREATE TABLE IF NOT EXISTS vms (
        vm_id TEXT PRIMARY KEY,
        worker_url TEXT NOT NULL,
        used_ram INTEGER DEFAULT 0,
        used_cpu INTEGER DEFAULT 0,
        last_heartbeat INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 4. Active Sessions Table
    await executeD1(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        instance_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        assigned_port INTEGER,
        started_at INTEGER,
        expires_at INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    res.status(200).json({ status: "success", message: "Cloudflare D1 schema initialized successfully!" });
  } catch (error) {
    res.status(500).json({ status: "error", message: error.message });
  }
}
