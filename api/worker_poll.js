import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const { vm_id } = req.body;
  if (!vm_id) {
    return res.status(400).json({ status: "error", message: "Missing vm_id" });
  }

  try {
    // Pop a task from the VM's specific queue
    const taskJson = await kv.lpop(`vm_tasks:${vm_id}`);
    
    if (taskJson) {
      // Return the task to the daemon
      return res.status(200).json({ status: "success", task: taskJson });
    } else {
      return res.status(200).json({ status: "success", task: null });
    }
  } catch (error) {
    console.error("Poll error:", error);
    return res.status(500).json({ status: "error", message: "KV error" });
  }
}
