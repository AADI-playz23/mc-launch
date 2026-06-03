import { queryD1, executeD1 } from './db.js';
import { getAuthUser } from './auth_utils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { session_id } = req.body;
  if (!session_id) {
    return res.status(400).json({ status: "error", message: "session_id required" });
  }

  try {
    const sessions = await queryD1(
      "SELECT * FROM sessions WHERE session_id = ? AND username = ?", 
      [session_id, user.username]
    );

    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ status: "error", message: "Session not found" });
    }

    const session = sessions[0];
    
    // Determine renewal addition based on plan
    let addSeconds = 2 * 3600; // Free = 2 hours
    if (user.plan === 'starter') addSeconds = 6 * 3600;
    else if (user.plan === 'advanced') addSeconds = 12 * 3600;
    else if (user.plan === 'nexus' || user.plan === 'quantum') addSeconds = 24 * 3600;

    const now = Math.floor(Date.now() / 1000);
    
    // If it's already expired or very close, renew from NOW.
    // If it has plenty of time left, add to the existing expiry.
    let currentExpiry = session.expires_at || now;
    if (currentExpiry < now) currentExpiry = now;
    
    const newExpiry = currentExpiry + addSeconds;

    await executeD1(
      "UPDATE sessions SET expires_at = ? WHERE session_id = ?",
      [newExpiry, session_id]
    );

    return res.status(200).json({ 
      status: "success", 
      message: "Server renewed successfully!", 
      expires_at: newExpiry 
    });

  } catch (error) {
    console.error("Renew error:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}
