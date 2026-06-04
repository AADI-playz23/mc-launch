import fs from 'fs';

// Load .env file
const envRaw = fs.readFileSync('.env', 'utf-8');
envRaw.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim().replace(/^"|"$/g, '');
});

// Set a JWT_SECRET for local execution
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'local-init-key';

import { executeD1 } from './api/_lib/db.js';

async function initSchema() {
    console.log("Initializing Cloudflare D1 schema...");

    try {
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
        console.log("✓ users table");

        await executeD1(`
          CREATE TABLE IF NOT EXISTS instances (
            instance_id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            servername TEXT NOT NULL,
            game TEXT DEFAULT 'minecraft',
            software TEXT,
            version TEXT,
            java_version TEXT DEFAULT '21',
            ram TEXT DEFAULT '4G',
            status TEXT DEFAULT 'offline',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log("✓ instances table");
        
        try {
            await executeD1(`ALTER TABLE instances ADD COLUMN java_version TEXT DEFAULT '21'`);
            console.log("✓ added java_version to existing instances table");
        } catch(e) {}

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
        console.log("✓ vms table");

        await executeD1(`
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            instance_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            vm_id TEXT,
            status TEXT DEFAULT 'queued',
            assigned_port INTEGER,
            started_at INTEGER,
            expires_at INTEGER,
            terminated_at INTEGER,
            termination_reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        console.log("✓ sessions table");

        await executeD1(`
          CREATE INDEX IF NOT EXISTS idx_sessions_status_vm ON sessions(status, vm_id)
        `);
        console.log("✓ sessions index");

        await executeD1(`
          CREATE TABLE IF NOT EXISTS backups (
            backup_id TEXT PRIMARY KEY,
            instance_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            filename TEXT NOT NULL,
            size_bytes INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
          )
        `);
        console.log("✓ backups table");

        await executeD1(`
          CREATE TABLE IF NOT EXISTS schedules (
            schedule_id TEXT PRIMARY KEY,
            instance_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            type TEXT NOT NULL,
            interval_hours INTEGER NOT NULL,
            last_run INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (instance_id) REFERENCES instances(instance_id)
          )
        `);
        console.log("✓ schedules table");

        console.log("\nSchema initialized successfully!");
    } catch (error) {
        console.error("Schema init failed:", error.message);
        process.exit(1);
    }
}

await initSchema();
