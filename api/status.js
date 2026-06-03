import { queryD1 } from './db.js';
import { getAuthUser } from './auth_utils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).json({ status: "error", message: "session_id required" });
  }

  try {
    const sessions = await queryD1(
      "SELECT s.*, v.worker_url FROM sessions s LEFT JOIN vms v ON s.vm_id = v.vm_id WHERE s.session_id = ? AND s.username = ?", 
      [session_id, user.username]
    );

    if (sessions && sessions.length > 0) {
      return res.status(200).json({ 
        status: "assigned", 
        worker_url: sessions[0].worker_url 
      });
    }

    return res.status(200).json({ status: "queued" });

  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}
