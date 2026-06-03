import { queryD1, executeD1 } from './db.js';
import { getAuthUser } from './auth_utils.js';

export default async function handler(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  // GET: List all instances for the user
  if (req.method === 'GET') {
    try {
      const instances = await queryD1(
        "SELECT * FROM instances WHERE username = ? ORDER BY created_at DESC", 
        [user.username]
      );
      return res.status(200).json({ status: "success", instances: instances || [] });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  }

  // POST: Create a new instance
  if (req.method === 'POST') {
    const { servername, game, software, version } = req.body;
    
    if (!servername || !game || !software || !version) {
      return res.status(400).json({ status: "error", message: "Missing required fields" });
    }

    // Determine RAM based on user plan
    const ram = user.plan === 'pro' ? '6G' : (user.plan === 'developer' ? '8G' : '4G');

    try {
      await executeD1(
        "INSERT INTO instances (username, servername, game, software, version, ram) VALUES (?, ?, ?, ?, ?, ?)",
        [user.username, servername, game, software, version, ram]
      );
      return res.status(200).json({ status: "success", message: "Server instance created" });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  }

  // DELETE: Remove an instance
  if (req.method === 'DELETE') {
    const { instance_id } = req.body;
    
    if (!instance_id) {
      return res.status(400).json({ status: "error", message: "instance_id required" });
    }

    try {
      await executeD1(
        "DELETE FROM instances WHERE instance_id = ? AND username = ?",
        [instance_id, user.username]
      );
      return res.status(200).json({ status: "success", message: "Server deleted" });
    } catch (error) {
      return res.status(500).json({ status: "error", message: error.message });
    }
  }

  return res.status(405).json({ status: "error", message: "Method not allowed" });
}
