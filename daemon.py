import os
import time
import json
import threading
import subprocess
import select
import asyncio
import websockets
import re
import sys
import shutil
import requests
import pty

BASE_URL = os.environ.get("BASE_URL", "https://absoracloud-v2.vercel.app")
API_URL = BASE_URL + "/api/worker_api"
POLL_URL = BASE_URL + "/api/worker_poll"
RUNNER_ID = os.environ.get("RUNNER_ID", f"runner_{os.urandom(4).hex()}")
PORT = 8080

CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
CF_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")

# Total Runner Capacity (GitHub Actions: 4 CPU, 16GB RAM)
TOTAL_CPU = 4
TOTAL_RAM_GB = 16

active_sessions = {}
worker_url = None
registered_vm_id = RUNNER_ID

used_cpu = 0
used_ram = 0

def api_call(url, payload):
    try:
        resp = requests.post(url, json=payload, timeout=10)
        return resp.json()
    except Exception as e:
        print(f"API Error ({url}): {e}")
        return {"status": "error"}

def heartbeat_and_poll_loop():
    global registered_vm_id, used_cpu, used_ram
    print("Started heartbeat & poll loop")
    
    zero_users_start_time = time.time()
    
    while True:
        num_users = len(active_sessions)
        
        # Idle termination logic
        if num_users == 0:
            if time.time() - zero_users_start_time > 300: # 5 mins idle
                print("No active users for 5 minutes. Terminating runner to save resources.")
                os._exit(0)
        else:
            zero_users_start_time = time.time()
            
        try:
            # 1. Heartbeat
            res = api_call(API_URL, {
                "op": "vm_heartbeat",
                "vm_id": registered_vm_id,
                "used_ram": used_ram,
                "used_cpu": used_cpu
            })
            
            if res.get("status") == "error" and worker_url:
                print("VM not found, re-registering...")
                reg = api_call(API_URL, {
                    "op": "register_vm",
                    "vm_id": registered_vm_id,
                    "worker_url": worker_url,
                    "used_ram": used_ram,
                    "used_cpu": used_cpu
                })
                registered_vm_id = reg.get("vm_id", registered_vm_id)

            if res.get("status") == "success" and "kill_sessions" in res:
                for s_id in res["kill_sessions"]:
                    if s_id in active_sessions:
                        print(f"[{s_id}] Session expired. Terminating...")
                        sess = active_sessions[s_id]
                        sess["proc"].terminate()
                        sess["bore_proc"].terminate()
                        del active_sessions[s_id]
                        # Free up capacity
                        used_ram -= int(sess.get("ram", "4G").replace("G", ""))
                        used_cpu -= sess.get("cpu", 1)

            # 2. Poll for new tasks
            poll_res = api_call(POLL_URL, {"vm_id": registered_vm_id})
            if poll_res.get("status") == "success" and poll_res.get("task"):
                task = poll_res["task"]
                if isinstance(task, str):
                    task = json.loads(task)
                
                print(f"Received new task: {task['session_id']}")
                threading.Thread(target=start_game_server, args=(task,)).start()

        except Exception as e:
            print(f"Heartbeat/Poll loop exception: {e}")
            
        time.sleep(10)

def start_tunnel():
    global worker_url, registered_vm_id
    print("Starting cloudflared tunnel for WebSockets...")
    tunnel_proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True
    )
    for line in tunnel_proc.stdout:
        print(f"[TUNNEL] {line.strip()}")
        match = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
        if match:
            url = match.group(0)
            worker_url = url.replace("https://", "wss://")
            print(f"Cloudflare tunnel established: {worker_url}")
            
            # Register VM
            reg = api_call(API_URL, {
                "op": "register_vm",
                "vm_id": registered_vm_id,
                "worker_url": worker_url,
                "used_ram": used_ram,
                "used_cpu": used_cpu
            })
            registered_vm_id = reg.get("vm_id", registered_vm_id)
            print(f"Registered as VM: {registered_vm_id}")
            
            threading.Thread(target=heartbeat_and_poll_loop, daemon=True).start()
            break

def start_game_server(task):
    global used_cpu, used_ram
    
    session_id = task["session_id"]
    username = task["username"]
    game = task["game"]
    requested_ram_str = task["ram"] # e.g. "4G"
    requested_cpu = task["cpu"]
    
    # 1. Update Capacity Tracking (Note: We track nominal requested capacity)
    requested_ram_gb = int(requested_ram_str.replace('G', ''))
    used_cpu += requested_cpu
    used_ram += requested_ram_gb
    
    # 2. Free Penalty Buffer Logic (Cut ~500MB from actual process limit)
    # E.g. 4GB requested -> 3.5GB actual limit (3584 MB -> ~3670016000 bytes)
    actual_limit_mb = (requested_ram_gb * 1024) - 500
    actual_limit_bytes = actual_limit_mb * 1024 * 1024
    
    print(f"[{session_id}] Starting {game} for {username}. Nominal RAM: {requested_ram_gb}GB, Actual Limit: {actual_limit_mb}MB")
    
    server_dir = f"/home/runner/servers/{session_id}"
    os.makedirs(server_dir, exist_ok=True)
    
    # 3. Find Free Internal Port
    import socket
    s = socket.socket()
    s.bind(('', 0))
    internal_port = s.getsockname()[1]
    s.close()
    
    # 4. Start Bore Tunnel
    bore_proc = subprocess.Popen(
        ["bore", "local", str(internal_port), "--to", "bore.pub"],
        stdout=subprocess.PIPE,
        text=True
    )
    
    remote_port = None
    for line in bore_proc.stdout:
        match = re.search(r'listening at bore\.pub:(\d+)', line)
        if match:
            remote_port = match.group(1)
            print(f"[{session_id}] Bore tunnel active: bore.pub:{remote_port}")
            break
            
    # Optional: Update Cloudflare SRV record here if API keys provided
    if CF_API_TOKEN and CF_ZONE_ID and remote_port:
        print(f"[{session_id}] (Mock) Updating Cloudflare SRV record _minecraft._tcp.{username}.absoracloud.com -> bore.pub:{remote_port}")
        
    # 5. Start Game Process with prlimit
    # Using nice + prlimit to strictly enforce the "free penalty" cut
    cmd = [
        "prlimit", f"--as={actual_limit_bytes}",
        "java", f"-Xmx{actual_limit_mb}M", f"-Xms{actual_limit_mb}M", "-jar", "server.jar", "nogui"
    ]
    # (Assuming you download server.jar here)
    with open(f"{server_dir}/eula.txt", "w") as f:
        f.write("eula=true")

    master_fd, slave_fd = pty.openpty()
    
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=server_dir,
            text=True,
            bufsize=1
        )
        os.close(slave_fd)
        
        active_sessions[session_id] = {
            "proc": proc,
            "master_fd": master_fd,
            "bore_proc": bore_proc,
            "username": username,
            "game": game,
            "ram": requested_ram_str,
            "cpu": requested_cpu
        }
        
        print(f"[{session_id}] Server started successfully.")
    except Exception as e:
        print(f"[{session_id}] Failed to start: {e}")

async def handle_client(websocket):
    # This multiplexes the console streams back to Vercel/Frontend
    # Expects client to send {"session_id": "..."} to connect to a specific console
    try:
        auth_msg = await websocket.recv()
        auth_data = json.loads(auth_msg)
        session_id = auth_data.get('session_id')
        
        if session_id not in active_sessions:
            await websocket.send(json.dumps({"type": "error", "message": "Session not active on this runner."}))
            return
            
        sess = active_sessions[session_id]
        master_fd = sess["master_fd"]
        proc = sess["proc"]
        
        async def read_stdout():
            try:
                while proc.poll() is None:
                    rlist, _, _ = select.select([master_fd], [], [], 0.1)
                    if rlist:
                        chunk = os.read(master_fd, 4096).decode('utf-8', errors='replace')
                        if chunk:
                            await websocket.send(json.dumps({"type": "message", "data": chunk}))
                    await asyncio.sleep(0.01)
            except Exception:
                pass
                
        asyncio.create_task(read_stdout())
        
        async for message in websocket:
            data = json.loads(message)
            if data.get("type") == "command":
                cmd = data.get("command", "") + "\n"
                proc.stdin.write(cmd)
                proc.stdin.flush()
                
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")

async def main_loop():
    server = await websockets.serve(handle_client, "0.0.0.0", PORT)
    print(f"Console WebSocket server started on port {PORT}")
    await asyncio.Future()

if __name__ == "__main__":
    print("AbsoraCloud Python Daemon Booting...")
    threading.Thread(target=start_tunnel, daemon=True).start()
    asyncio.run(main_loop())
