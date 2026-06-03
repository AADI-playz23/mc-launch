import { queryD1, executeD1 } from './db.js';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const { op, vm_id, worker_url, used_ram = 0, used_cpu = 0 } = req.body;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (op === 'register_vm') {
      if (!worker_url) return res.status(400).json({ status: "error", message: "Missing worker_url" });
      
      const new_vm_id = vm_id || crypto.randomBytes(8).toString('hex');
      
      // Delete any stale VM record with the same ID
      await executeD1("DELETE FROM vms WHERE vm_id = ?", [new_vm_id]);
      
      // Register new VM
      await executeD1(
        "INSERT INTO vms (vm_id, worker_url, used_ram, used_cpu, last_heartbeat) VALUES (?, ?, ?, ?, ?)",
        [new_vm_id, worker_url, used_ram, used_cpu, now]
      );
      
      return res.status(200).json({ status: "success", vm_id: new_vm_id });
    }

    if (op === 'vm_heartbeat') {
      if (!vm_id) return res.status(400).json({ status: "error", message: "Missing vm_id" });
      
      const result = await executeD1(
        "UPDATE vms SET last_heartbeat = ?, used_ram = ?, used_cpu = ? WHERE vm_id = ?",
        [now, used_ram, used_cpu, vm_id]
      );
      
      if (result.changes === 0) {
        return res.status(404).json({ status: "error", message: "VM not found in DB" });
      }

      // Check for expired sessions assigned to this VM
      const expiredSessions = await queryD1(
        "SELECT session_id FROM sessions WHERE vm_id = ? AND expires_at < ?",
        [vm_id, now]
      );
      
      const kill_sessions = expiredSessions ? expiredSessions.map(s => s.session_id) : [];

      return res.status(200).json({ status: "success", kill_sessions });
    }

    return res.status(400).json({ status: "error", message: "Invalid operation" });

  } catch (error) {
    console.error("Worker API error:", error);
    return res.status(500).json({ status: "error", message: "Database error" });
  }
}
