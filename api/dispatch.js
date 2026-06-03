import { queryD1, executeD1 } from './db.js';
import { getAuthUser } from './auth_utils.js';
import { kv } from '@vercel/kv';

const MAX_VM_RAM_GB = 16;
const MAX_VM_CPU = 4;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const user = getAuthUser(req);
  if (!user) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }

  const { instance_id } = req.body;
  if (!instance_id) {
    return res.status(400).json({ status: "error", message: "instance_id required" });
  }

  try {
    // 1. Get instance details
    const instances = await queryD1("SELECT * FROM instances WHERE instance_id = ? AND username = ?", [instance_id, user.username]);
    if (!instances || instances.length === 0) {
      return res.status(404).json({ status: "error", message: "Instance not found" });
    }
    const instance = instances[0];

    // Determine required resources (e.g. '4G' -> 4)
    const required_ram = parseInt(instance.ram.replace('G', '')) || 4;
    const required_cpu = user.plan === 'paid' || user.plan === 'pro' ? 2 : 1;

    // 2. Find an active VM with available capacity
    const now = Math.floor(Date.now() / 1000);
    const activeVms = await queryD1("SELECT * FROM vms WHERE last_heartbeat > ?", [now - 90]);
    
    let assigned_vm = null;
    
    for (const vm of activeVms) {
      const free_ram = MAX_VM_RAM_GB - vm.used_ram;
      const free_cpu = MAX_VM_CPU - vm.used_cpu;
      
      if (free_ram >= required_ram && free_cpu >= required_cpu) {
        assigned_vm = vm;
        break;
      }
    }

    // Determine expiry time
    let addSeconds = 2 * 3600; // 2 hours default
    if (user.plan === 'starter') addSeconds = 6 * 3600;
    else if (user.plan === 'advanced') addSeconds = 12 * 3600;
    else if (user.plan === 'nexus' || user.plan === 'quantum') addSeconds = 24 * 3600;
    
    const expires_at = now + addSeconds;

    const session_id = `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // 3. If VM found, assign immediately
    if (assigned_vm) {
      // Update D1 sessions
      await executeD1(
        "INSERT INTO sessions (session_id, instance_id, username, vm_id, status, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [session_id, instance.instance_id, user.username, assigned_vm.vm_id, 'assigned', now, expires_at]
      );
      
      // Tell the daemon via KV (the daemon polls this list)
      await kv.rpush(`vm_tasks:${assigned_vm.vm_id}`, JSON.stringify({
        session_id,
        instance_id: instance.instance_id,
        game: instance.game,
        ram: instance.ram,
        cpu: required_cpu,
        username: user.username
      }));

      return res.status(200).json({ 
        status: "success", 
        message: "Server assigned to active runner", 
        session_id,
        worker_url: assigned_vm.worker_url 
      });
    }

    // 4. No VM available: Add to Queue
    await kv.rpush('server_queue', JSON.stringify({
      session_id,
      instance_id: instance.instance_id,
      username: user.username,
      game: instance.game,
      ram: instance.ram,
      cpu: required_cpu,
      queued_at: now,
      plan: user.plan
    }));

    // Trigger new GitHub Runner ONLY if we have less than 5 active VMs
    if (activeVms.length < 5) {
      const triggerRes = await triggerGitHubAction();
      
      if (triggerRes.ok) {
        return res.status(200).json({ status: "queued", message: "Runner is starting. You are in the queue.", session_id });
      } else {
        return res.status(500).json({ status: "error", message: "Added to queue, but failed to trigger runner." });
      }
    } else {
      return res.status(200).json({ status: "queued", message: "System is at maximum capacity (5 runners active). You are in the queue.", session_id });
    }

  } catch (error) {
    console.error("Dispatch error:", error);
    return res.status(500).json({ status: "error", message: "Internal server error" });
  }
}

async function triggerGitHubAction() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. "absoracloud/game-runners"
  
  if (!token || !repo) return { ok: false };

  const url = `https://api.github.com/repos/${repo}/actions/workflows/host.yml/dispatches`;
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          runner_type: 'multi-tenant'
        }
      })
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false };
  }
}
