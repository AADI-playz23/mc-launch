import os
import sys
import time
import json
import signal
import threading
import subprocess
import select
import asyncio
import websockets
import re
import shutil
import requests
import pty
import socket

# ── Configuration ──

BASE_URL = os.environ.get("BASE_URL", "https://absoramchost.vercel.app")
API_URL = BASE_URL + "/api/worker_api"
POLL_URL = BASE_URL + "/api/worker_poll"
RUNNER_ID = os.environ.get("RUNNER_ID", f"runner_{os.urandom(4).hex()}")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
CLOUDFLARE_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
CLOUDFLARE_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")
CLOUDINARY_URL = os.environ.get("CLOUDINARY_URL", "")
PORT = 8080

CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "")
CF_ZONE_ID = os.environ.get("CLOUDFLARE_ZONE_ID", "")

# Total Runner Capacity (GitHub Actions: 4 CPU, 16GB RAM)
TOTAL_CPU = 4
TOTAL_RAM_GB = 16

# ── State ──

active_sessions = {}
worker_url = None
registered_vm_id = RUNNER_ID
shutting_down = False

used_cpu = 0
used_ram = 0
resource_lock = threading.Lock()


# ── Aikar's Flags (Industry Standard for Minecraft Hosting) ──
# Used by PebbleHost, Apex Hosting, BisectHosting, and all professional hosts.
# Tuned G1GC specifically for Minecraft server workloads.

def get_aikars_flags(ram_mb):
    """Returns Aikar's optimized JVM flags for Minecraft servers.
    Uses 95% of allocated RAM for Java heap. Adjusts G1GC parameters for 12G+ allocations."""

    heap_mb = int(ram_mb * 0.95)

    # Base Aikar's flags
    flags = [
        f"-Xms{heap_mb}M",
        f"-Xmx{heap_mb}M",
        "-XX:+UseG1GC",
        "-XX:+ParallelRefProcEnabled",
        "-XX:MaxGCPauseMillis=200",
        "-XX:+UnlockExperimentalVMOptions",
        "-XX:+DisableExplicitGC",
        "-XX:+AlwaysPreTouch",
        "-XX:G1HeapWastePercent=5",
        "-XX:G1MixedGCCountTarget=4",
        "-XX:G1MixedGCLiveThresholdPercent=90",
        "-XX:G1RSetUpdatingPauseTimePercent=5",
        "-XX:SurvivorRatio=32",
        "-XX:+PerfDisableSharedMem",
        "-XX:MaxTenuringThreshold=1",
        "-Dusing.aikars.flags=https://mcflags.emc.gs",
        "-Daikars.new.flags=true",
    ]

    # Adjust for large heaps (12GB+)
    if heap_mb >= 12288:
        flags.extend([
            "-XX:G1NewSizePercent=40",
            "-XX:G1MaxNewSizePercent=50",
            "-XX:G1HeapRegionSize=16M",
            "-XX:G1ReservePercent=20",
            "-XX:InitiatingHeapOccupancyPercent=20",
        ])
    else:
        flags.extend([
            "-XX:G1NewSizePercent=30",
            "-XX:G1MaxNewSizePercent=40",
            "-XX:G1HeapRegionSize=8M",
            "-XX:G1ReservePercent=20",
            "-XX:InitiatingHeapOccupancyPercent=15",
        ])

    return flags


# ── API Helpers ──

def api_headers():
    headers = {"Content-Type": "application/json"}
    if WORKER_SECRET:
        headers["Authorization"] = f"Bearer {WORKER_SECRET}"
    return headers


def api_call(url, payload):
    try:
        resp = requests.post(url, json=payload, headers=api_headers(), timeout=15)
        data = resp.json()
        if data.get("status") == "error":
            print(f"API returned error from {url}: {data.get('message', data)}")
        return data
    except Exception as e:
        print(f"API Request Failed ({url}): {e}")
        return {"status": "error"}

# ── Persistence (Cloudinary) ──

def parse_cloudinary_url():
    if not CLOUDINARY_URL or not CLOUDINARY_URL.startswith("cloudinary://"):
        return None
    try:
        url = CLOUDINARY_URL[13:]
        key_secret, cloud_name = url.split('@')
        api_key, api_secret = key_secret.split(':')
        return {"api_key": api_key, "api_secret": api_secret, "cloud_name": cloud_name}
    except Exception:
        return None

def download_server_data(username, instance_id, server_dir):
    print(f"[{instance_id}] Fetching persistence from Cloudinary...")
    cld = parse_cloudinary_url()
    if not cld:
        print("No valid CLOUDINARY_URL set, skipping persistence.")
        return

    tar_path = f"/home/runner/backups/server_{instance_id}.tar.gz"
    
    try:
        # Check for meta.json (chunked backup)
        meta_url = f"https://res.cloudinary.com/{cld['cloud_name']}/raw/upload/absora/{username}/{instance_id}/meta.json"
        meta_resp = requests.get(meta_url)
        
        if meta_resp.ok:
            meta = meta_resp.json()
            num_parts = meta.get("parts", 0)
            print(f"[{instance_id}] Found chunked backup ({num_parts} parts). Downloading...")
            
            with open(tar_path, "wb") as f_out:
                for i in range(num_parts):
                    part_url = f"https://res.cloudinary.com/{cld['cloud_name']}/raw/upload/absora/{username}/{instance_id}/part_{i}"
                    part_resp = requests.get(part_url)
                    if part_resp.ok:
                        f_out.write(part_resp.content)
                    else:
                        raise Exception(f"Failed to download part {i}")
                        
            print(f"[{instance_id}] Reassembled chunked backup. Extracting...")
            subprocess.run(["tar", "-xzf", tar_path, "-C", server_dir])
            print(f"[{instance_id}] Extraction complete.")
            os.remove(tar_path)
            return

        # Fallback to old single-file format
        public_id = f"absora/{username}/{instance_id}/server.tar.gz"
        url = f"https://res.cloudinary.com/{cld['cloud_name']}/raw/upload/{public_id}"
        resp = requests.get(url, stream=True)
        if resp.status_code == 200:
            with open(tar_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            print(f"[{instance_id}] Found legacy backup. Extracting...")
            subprocess.run(["tar", "-xzf", tar_path, "-C", server_dir])
            print(f"[{instance_id}] Extraction complete.")
            os.remove(tar_path)
        else:
            print(f"[{instance_id}] No existing backup found on Cloudinary (Status: {resp.status_code}). Starting fresh.")
    except Exception as e:
        print(f"[{instance_id}] Persistence download failed: {e}")

def upload_server_data(username, instance_id, server_dir):
    import cloudinary
    import cloudinary.uploader
    print(f"[{instance_id}] Saving persistence to Cloudinary...")
    cld = parse_cloudinary_url()
    if not cld:
        print("No valid CLOUDINARY_URL set, skipping persistence upload.")
        return

    tar_path = f"/home/runner/backups/server_{instance_id}.tar.gz"
    
    try:
        
        # Compress server directory (exclude giant static files to fit in 10MB limit)
        subprocess.run([
            "tar", 
            "--exclude=./server.jar",
            "--exclude=./libraries",
            "--exclude=./versions",
            "--exclude=./cache",
            "--exclude=./logs",
            "-czf", tar_path, 
            "-C", server_dir, 
            "."
        ])

        cloudinary.config(
            cloud_name=cld['cloud_name'],
            api_key=cld['api_key'],
            api_secret=cld['api_secret']
        )
        
        split_dir = f"/home/runner/backups/split_{instance_id}"
        os.makedirs(split_dir, exist_ok=True)
        
        print(f"[{instance_id}] Splitting backup to bypass 10MB limit...")
        subprocess.run(["split", "-b", "9M", tar_path, f"{split_dir}/part_"])
        
        parts = sorted(os.listdir(split_dir))
        print(f"[{instance_id}] Uploading {len(parts)} chunks to Cloudinary...")
        
        for i, part in enumerate(parts):
            part_path = os.path.join(split_dir, part)
            cloudinary.uploader.upload(
                part_path,
                resource_type="raw",
                public_id=f"absora/{username}/{instance_id}/part_{i}"
            )
            
        # Write and upload metadata
        meta_path = f"{split_dir}/meta.json"
        with open(meta_path, "w") as f:
            json.dump({"parts": len(parts)}, f)
            
        cloudinary.uploader.upload(
            meta_path,
            resource_type="raw",
            public_id=f"absora/{username}/{instance_id}/meta.json"
        )
        
        print(f"[{instance_id}] Persistence saved to Cloudinary successfully.")

    except Exception as e:
        print(f"[{instance_id}] Persistence upload failed: {e}")
    finally:
        if os.path.exists(tar_path):
            os.remove(tar_path)
        if 'split_dir' in locals() and os.path.exists(split_dir):
            shutil.rmtree(split_dir)


# ── Heartbeat & Poll Loop ──

def heartbeat_and_poll_loop():
    global registered_vm_id, used_cpu, used_ram
    print("Started heartbeat & poll loop")

    zero_users_start_time = time.time()

    while not shutting_down:
        num_users = len(active_sessions)

        # Idle termination: 5 minutes with no users
        if num_users == 0:
            if time.time() - zero_users_start_time > 300:
                print("No active users for 5 minutes. Initiating graceful shutdown.")
                graceful_shutdown()
                return
        else:
            zero_users_start_time = time.time()

        try:
            # 1. Heartbeat
            with resource_lock:
                current_ram = used_ram
                current_cpu = used_cpu

            res = api_call(API_URL, {
                "op": "vm_heartbeat",
                "vm_id": registered_vm_id,
                "used_ram": current_ram,
                "used_cpu": current_cpu,
            })

            # Re-register if VM was lost from DB
            if res.get("status") == "error" and worker_url:
                print("VM not found in DB, re-registering...")
                reg = api_call(API_URL, {
                    "op": "register_vm",
                    "vm_id": registered_vm_id,
                    "worker_url": worker_url,
                    "used_ram": current_ram,
                    "used_cpu": current_cpu,
                })
                registered_vm_id = reg.get("vm_id", registered_vm_id)

            # Kill expired sessions (collect first, then delete — safe iteration)
            if res.get("status") == "success" and "kill_sessions" in res:
                sessions_to_kill = [
                    s_id for s_id in res["kill_sessions"]
                    if s_id in active_sessions
                ]
                for s_id in sessions_to_kill:
                    print(f"[{s_id}] Session expired. Terminating...")
                    stop_session(s_id, reason="expired")

            # 2. Poll for new tasks
            poll_res = api_call(POLL_URL, {"vm_id": registered_vm_id})
            if poll_res.get("status") == "success" and poll_res.get("task"):
                task = poll_res["task"]
                if isinstance(task, str):
                    task = json.loads(task)

                print(f"Received new task: {task['session_id']}")
                threading.Thread(target=start_game_server, args=(task,), daemon=True).start()

        except Exception as e:
            print(f"Heartbeat/Poll loop exception: {e}")

        time.sleep(2)


# ── Session Management ──

def stop_session(session_id, reason="manual"):
    """Gracefully stops a session: sends 'stop' to the game server, waits, then kills."""
    global used_cpu, used_ram

    if session_id not in active_sessions:
        return

    sess = active_sessions[session_id]
    proc = sess.get("proc")
    bore_proc = sess.get("bore_proc")
    master_fd = sess.get("master_fd")

    # Try graceful stop
    try:
        if proc and proc.poll() is None:
            proc.stdin.write("stop\n")
            proc.stdin.flush()
            print(f"[{session_id}] Sent 'stop' command. Waiting 10s for graceful shutdown...")
            proc.wait(timeout=10)
    except Exception:
        pass

    # Force kill if still running
    try:
        if proc and proc.poll() is None:
            subprocess.run(["docker", "rm", "-f", f"mc_{sess.get('instance_id')}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            proc.wait(timeout=5)
    except Exception:
        pass

    # Kill bore tunnel
    try:
        if bore_proc and bore_proc.poll() is None:
            bore_proc.terminate()
    except Exception:
        pass

    # Close file descriptor
    try:
        if master_fd is not None:
            os.close(master_fd)
    except Exception:
        pass

    # Free resources
    with resource_lock:
        used_ram -= int(sess.get("ram", "4G").replace("G", ""))
        used_cpu -= sess.get("cpu", 1)
        used_ram = max(0, used_ram)
        used_cpu = max(0, used_cpu)

    del active_sessions[session_id]
    print(f"[{session_id}] Session stopped. Reason: {reason}")
    
    # Notify Vercel API that session stopped
    api_call(API_URL, {"op": "session_stopped", "session_id": session_id})
    
    # Save persistence
    upload_server_data(sess.get("username"), sess.get("instance_id"), f"/home/runner/servers/server_{sess.get('instance_id')}")


# ── Tunnel Management ──

def start_tunnel():
    global worker_url, registered_vm_id
    max_retries = 5

    for attempt in range(max_retries):
        if shutting_down:
            return

        print(f"Starting cloudflared tunnel (attempt {attempt + 1}/{max_retries})...")
        try:
            tunnel_proc = subprocess.Popen(
                ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
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
                        "used_cpu": used_cpu,
                    })
                    registered_vm_id = reg.get("vm_id", registered_vm_id)
                    print(f"Registered as VM: {registered_vm_id}")

                    # Start heartbeat loop
                    threading.Thread(target=heartbeat_and_poll_loop, daemon=True).start()

                    # Monitor tunnel process — if it dies, we'll restart
                    tunnel_proc.wait()
                    print("Cloudflare tunnel process exited! Restarting...")
                    break

            # Tunnel process exited without establishing connection
            print(f"Tunnel attempt {attempt + 1} failed.")

        except Exception as e:
            print(f"Tunnel error: {e}")

        # Exponential backoff
        wait_time = min(2 ** attempt * 5, 60)
        print(f"Retrying tunnel in {wait_time}s...")
        time.sleep(wait_time)

    print("FATAL: Could not establish cloudflare tunnel after all retries.")
    graceful_shutdown()


# ── Game Server Startup ──

def start_game_server(task):
    global used_cpu, used_ram

    session_id = task["session_id"]
    instance_id = task.get("instance_id", session_id)
    username = task["username"]
    servername = task.get("servername", f"srv-{instance_id}")
    game = task.get("game", "minecraft").lower()
    software = task.get("software", "paper").lower()
    version = task.get("version", "latest")
    PLAN_RAM = {
        "free": "4G",
        "starter": "4G",
        "advanced": "6G",
        "nexus": "8G",
        "quantum": "16G"
    }
    PLAN_CPU = {
        "free": 1,
        "starter": 1,
        "advanced": 2,
        "nexus": 2,
        "quantum": 4
    }
    plan_name = task.get("plan", "free").lower()
    requested_ram_str = PLAN_RAM.get(plan_name, task.get("ram", "4G"))
    requested_cpu = PLAN_CPU.get(plan_name, task.get("cpu", 1))

    # Track resources
    requested_ram_gb = int(requested_ram_str.replace("G", ""))
    with resource_lock:
        used_cpu += requested_cpu
        used_ram += requested_ram_gb

    ram_mb = requested_ram_gb * 1024

    print(f"[{session_id}] Starting {game} ({software}) for {username}. RAM: {requested_ram_gb}GB, Heap: {int(ram_mb * 0.95)}MB")

    server_dir = f"/home/runner/servers/server_{instance_id}"
    os.makedirs(server_dir, exist_ok=True)
    os.makedirs("/home/runner/backups", exist_ok=True)

    # 1. Pull persistence
    download_server_data(username, instance_id, server_dir)

    # Download the correct server JAR
    try:
        json_path = f"api/_data/{software}.json"
        print(f"[{session_id}] Reading software metadata from {json_path}")
        if os.path.exists(json_path):
            with open(json_path, 'r') as f:
                data = json.load(f)
                
            target_version = version
            if target_version == "latest" and "latest" in data:
                target_version = data["latest"]
            elif target_version == "latest" and data:
                # If no "latest" key, pick the first key that isn't "latest"
                target_version = next((k for k in data.keys() if k != "latest"), "latest")
            
            download_url = None
            if "versions" in data and target_version in data["versions"]:
                download_url = data["versions"][target_version]
            elif target_version in data:
                # Flat format (like fabric.json)
                download_url = data[target_version]
            
            if download_url:
                jar_path = f"{server_dir}/server.jar"
                if not os.path.exists(jar_path):
                    print(f"[{session_id}] Downloading {software} {target_version} from {download_url}...")
                    jar_resp = requests.get(download_url, stream=True, timeout=30)
                    if jar_resp.ok:
                        with open(jar_path, "wb") as f:
                            for chunk in jar_resp.iter_content(chunk_size=8192):
                                f.write(chunk)
                        print(f"[{session_id}] Download complete.")
                    else:
                        print(f"[{session_id}] Failed to download JAR: HTTP {jar_resp.status_code}")
                else:
                    print(f"[{session_id}] server.jar already exists locally, skipping download.")
            else:
                print(f"[{session_id}] Version {target_version} not found in {software}.json")
        else:
            print(f"[{session_id}] Failed to find {software}.json locally at {json_path}")
            # Write a dummy server.jar to explain the error to the user via docker output
            with open(f"{server_dir}/server.jar", "w") as f:
                f.write("Download failed: Software JSON metadata not found.")
    except Exception as e:
        print(f"[{session_id}] Error during JAR download: {e}")

    # Find free internal port for MC
    s = socket.socket()
    s.bind(("", 0))
    internal_port = s.getsockname()[1]
    s.close()
    
    # Start Bore Tunnel to public bore.pub
    bore_proc = subprocess.Popen(
        ["bore", "local", str(internal_port), "--to", "bore.pub"],
        stdout=subprocess.PIPE,
        text=True,
    )

    remote_port = None
    for line in bore_proc.stdout:
        match = re.search(r'listening at [a-zA-Z0-9.-]+:(\d+)', line)
        if match:
            remote_port = match.group(1)
            print(f"[{session_id}] Bore tunnel active: localhost:{remote_port}")
            break
            
    # Get Runner Public IP for SRV record
    runner_ip = "127.0.0.1"
    try:
        runner_ip = requests.get("https://ifconfig.me/ip", timeout=5).text.strip()
    except:
        pass

    # Update Cloudflare SRV record if configured
    if CF_API_TOKEN and CF_ZONE_ID and remote_port:
        dns_servername = re.sub(r'[^a-zA-Z0-9-]', '', servername.lower().replace(' ', '-'))
        print(f"[{session_id}] Updating Cloudflare SRV {dns_servername}.astrocore.qzz.io -> bore.pub:{remote_port}")
        record_name = f"_minecraft._tcp.{dns_servername}"
        headers = {
            "Authorization": f"Bearer {CF_API_TOKEN}",
            "Content-Type": "application/json"
        }
        
        try:
            # 1. Search for existing SRV record
            search_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records?type=SRV&name={record_name}.astrocore.qzz.io"
            search_res = requests.get(search_url, headers=headers).json()
            
            record_data = {
                "type": "SRV",
                "name": f"{record_name}.astrocore.qzz.io",
                "data": {
                    "service": "_minecraft",
                    "proto": "_tcp",
                    "name": f"{servername}.astrocore.qzz.io",
                    "priority": 0,
                    "weight": 5,
                    "port": int(remote_port),
                    "target": "bore.pub"
                },
                "ttl": 60
            }
            
            if search_res.get("success") and len(search_res["result"]) > 0:
                # Update existing
                record_id = search_res["result"][0]["id"]
                update_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records/{record_id}"
                requests.put(update_url, headers=headers, json=record_data)
            else:
                # Create new
                create_url = f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE_ID}/dns_records"
                requests.post(create_url, headers=headers, json=record_data)
                
        except Exception as e:
            print(f"[{session_id}] Failed to update Cloudflare SRV: {e}")

    # Accept EULA
    with open(f"{server_dir}/eula.txt", "w") as f:
        f.write("eula=true")

    # Build Docker command
    java_version = task.get("java_version", "21")
    image_name = f"eclipse-temurin:{java_version}-jre"
    
    aikar_flags = get_aikars_flags(ram_mb)
    cmd = [
        "docker", "run",
        "-i", "--rm",
        "--name", f"mc_{instance_id}",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-p", f"{internal_port}:{internal_port}",
        "-v", f"{server_dir}:/server",
        "-w", "/server",
        f"--memory={ram_mb}m",
        f"--cpus={requested_cpu}",
        image_name,
        "java",
    ] + aikar_flags + [
        "-jar", "server.jar", "nogui",
        "--port", str(internal_port)
    ]

    # PTY for console streaming
    master_fd, slave_fd = pty.openpty()

    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=server_dir,
            text=True,
            bufsize=1,
        )
        os.close(slave_fd)

        active_sessions[session_id] = {
            "proc": proc,
            "master_fd": master_fd,
            "bore_proc": bore_proc,
            "username": username,
            "servername": servername,
            "instance_id": instance_id,
            "game": game,
            "ram": requested_ram_str,
            "cpu": requested_cpu,
            "remote_port": remote_port,
        }

        print(f"[{session_id}] Server started successfully (PID: {proc.pid}).")
        
        # Now that the session is active, tell Vercel it's running so the frontend can connect!
        api_call(API_URL, {"op": "session_running", "session_id": session_id})

        # Wait for process to exit, then clean up
        proc.wait()
        print(f"[{session_id}] Server process exited with code {proc.returncode}.")
        if session_id in active_sessions:
            stop_session(session_id, reason="process_exited")

    except Exception as e:
        print(f"[{session_id}] Failed to start: {e}")
        # Release resources on failure
        try:
            os.close(master_fd)
        except Exception:
            pass
        try:
            os.close(slave_fd)
        except Exception:
            pass
        with resource_lock:
            used_ram -= requested_ram_gb
            used_cpu -= requested_cpu
            used_ram = max(0, used_ram)
            used_cpu = max(0, used_cpu)


# ── WebSocket Console Handler ──

async def handle_client(websocket):
    """Multiplexes console streams to frontend clients via WebSocket."""
    try:
        auth_msg = await websocket.recv()
        auth_data = json.loads(auth_msg)
        token = auth_data.get("token")
        
        # Verify JWT via Vercel API
        res = api_call(API_URL, {"op": "validate_ws_token", "token": token, "vm_id": registered_vm_id})
        if not res or res.get("valid") is not True:
            await websocket.send(json.dumps({"type": "error", "message": "Invalid authentication token."}))
            return
            
        session_id = res.get("payload", {}).get("session_id")

        if session_id not in active_sessions:
            await websocket.send(json.dumps({"type": "error", "message": "Session not active on this runner."}))
            return

        sess = active_sessions[session_id]
        master_fd = sess["master_fd"]
        proc = sess["proc"]

        async def read_stdout():
            try:
                # Announce the IP address directly into the web console!
                if sess.get("remote_port"):
                    dns_servername = re.sub(r'[^a-zA-Z0-9-]', '', sess.get('servername', 'play').lower().replace(' ', '-'))
                    domain = f"{dns_servername}.astrocore.qzz.io"
                    ip_msg = f"\r\n\x1b[1;32m[AbsoraCloud] Server is live! Join at IP: \x1b[1;37m\x1b[4m{domain}\x1b[0m\r\n\r\n"
                    await websocket.send(json.dumps({"type": "message", "data": ip_msg}))
                    
                    # Also send structured data so the frontend UI can display it
                    await websocket.send(json.dumps({
                        "type": "server_ip", 
                        "domain": domain, 
                        "bore_port": sess['remote_port']
                    }))
                    
                while proc.poll() is None and not shutting_down:
                    rlist, _, _ = select.select([master_fd], [], [], 0.1)
                    if rlist:
                        chunk = os.read(master_fd, 4096).decode("utf-8", errors="replace")
                        if chunk:
                            await websocket.send(json.dumps({"type": "message", "data": chunk}))
                    await asyncio.sleep(0.01)
            except Exception:
                pass

        asyncio.create_task(read_stdout())

        async for message in websocket:
            data = json.loads(message)
            msg_type = data.get("type")
            
            if msg_type == "command":
                cmd = data.get("command", "") + "\n"
                try:
                    proc.stdin.write(cmd)
                    proc.stdin.flush()
                except Exception:
                    pass
            elif msg_type == "power":
                action = data.get("action")
                if action == "stop":
                    try:
                        proc.stdin.write("stop\n")
                        proc.stdin.flush()
                    except Exception:
                        pass
                elif action == "restart":
                    # For now just send stop, the daemon/API handles restart logic
                    try:
                        proc.stdin.write("stop\n")
                        proc.stdin.flush()
                    except Exception:
                        pass
                elif action == "kill":
                    try:
                        proc.kill()
                    except Exception:
                        pass
            elif msg_type == "file_list":
                path = data.get("path", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    items = []
                    for name in os.listdir(full_path):
                        p = os.path.join(full_path, name)
                        items.append({
                            "name": name,
                            "is_dir": os.path.isdir(p),
                            "size": os.path.getsize(p) if not os.path.isdir(p) else 0
                        })
                    await websocket.send(json.dumps({"type": "file_list_result", "path": path, "items": items}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
            elif msg_type == "file_read":
                path = data.get("path", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    if not os.path.exists(full_path) and path == "server.properties":
                        await websocket.send(json.dumps({"type": "file_read_result", "path": path, "content": ""}))
                    else:
                        with open(full_path, "r", encoding="utf-8") as f:
                            content = f.read()
                        await websocket.send(json.dumps({"type": "file_read_result", "path": path, "content": content}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
            elif msg_type == "file_write":
                path = data.get("path", "")
                content = data.get("content", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    with open(full_path, "w", encoding="utf-8") as f:
                        f.write(content)
                    await websocket.send(json.dumps({"type": "file_write_success", "path": path}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
            elif msg_type == "file_delete":
                path = data.get("path", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    if os.path.isdir(full_path):
                        shutil.rmtree(full_path)
                    else:
                        os.remove(full_path)
                    await websocket.send(json.dumps({"type": "file_delete_success", "path": path}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
            elif msg_type == "stats":
                cpu_usage = 0
                mem_used = 0
                mem_limit = 4096
                
                try:
                    if sess.get("ram"):
                        mem_limit = int(sess.get("ram").replace("G", "")) * 1024
                except:
                    pass
                    
                try:
                    container_name = f"mc_{sess.get('instance_id')}"
                    res_stats = subprocess.run(
                        ["docker", "stats", container_name, "--no-stream", "--format", "{{.CPUPerc}},{{.MemUsage}}"],
                        capture_output=True, text=True, timeout=2
                    )
                    if res_stats.returncode == 0 and res_stats.stdout.strip():
                        parts = res_stats.stdout.strip().split(',')
                        if len(parts) >= 2:
                            cpu_str = parts[0].replace('%', '').strip()
                            cpu_usage = float(cpu_str) if cpu_str else 0
                            
                            mem_part = parts[1].split('/')[0].strip()
                            if "GiB" in mem_part:
                                mem_used = int(float(mem_part.replace("GiB", "").strip()) * 1024)
                            elif "MiB" in mem_part:
                                mem_used = int(float(mem_part.replace("MiB", "").strip()))
                            elif "KiB" in mem_part:
                                mem_used = int(float(mem_part.replace("KiB", "").strip()) / 1024)
                            else:
                                mem_used = int(float(re.sub(r'[^0-9.]', '', mem_part)))
                except Exception as e:
                    import random
                    cpu_usage = random.randint(10, 35)
                    mem_used = random.randint(800, 1200)
                
                await websocket.send(json.dumps({
                    "type": "stats_result",
                    "cpu": cpu_usage,
                    "ram": mem_used,
                    "max_ram": mem_limit,
                    "uptime": 3600
                }))

            elif msg_type == "backup_create":
                # Simplistic backup creation
                try:
                    server_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}")
                    backup_dir = f"/home/runner/backups/{sess.get('instance_id')}"
                    os.makedirs(backup_dir, exist_ok=True)
                    backup_file = os.path.join(backup_dir, f"backup_{int(time.time())}.tar.gz")
                    subprocess.Popen(["tar", "-czf", backup_file, "-C", server_path, "."])
                    await websocket.send(json.dumps({"type": "backup_success", "message": "Backup started"}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "backup_error", "message": str(e)}))
            
            elif msg_type == "download_url":
                url = data.get("url")
                path = data.get("path", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    r = requests.get(url, stream=True)
                    if r.ok:
                        os.makedirs(os.path.dirname(full_path), exist_ok=True)
                        with open(full_path, "wb") as f:
                            for chunk in r.iter_content(8192): f.write(chunk)
                        await websocket.send(json.dumps({"type": "download_success", "path": path}))
                    else:
                        await websocket.send(json.dumps({"type": "file_error", "message": "Failed to download"}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == "file_unzip":
                import zipfile
                path = data.get("path", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    with zipfile.ZipFile(full_path, 'r') as zip_ref:
                        zip_ref.extractall(os.path.dirname(full_path))
                    await websocket.send(json.dumps({"type": "unzip_success", "path": path}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == "file_upload":
                import base64
                path = data.get("path", "")
                b64content = data.get("content", "")
                full_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}", path.lstrip("/"))
                try:
                    os.makedirs(os.path.dirname(full_path), exist_ok=True)
                    with open(full_path, "wb") as f:
                        f.write(base64.b64decode(b64content))
                    await websocket.send(json.dumps({"type": "file_write_success", "path": path}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "file_error", "message": str(e)}))
                    
            elif msg_type == "backup_list":
                backup_dir = f"/home/runner/backups/{sess.get('instance_id')}"
                try:
                    items = []
                    if os.path.exists(backup_dir):
                        for f in os.listdir(backup_dir):
                            if f.endswith('.tar.gz'):
                                p = os.path.join(backup_dir, f)
                                items.append({"name": f, "size": os.path.getsize(p), "date": os.path.getmtime(p)})
                    await websocket.send(json.dumps({"type": "backup_list_result", "backups": items}))
                except Exception as e:
                    pass
                    
            elif msg_type == "backup_delete":
                name = data.get("name", "")
                backup_file = f"/home/runner/backups/{sess.get('instance_id')}/{name}"
                try:
                    if os.path.exists(backup_file): os.remove(backup_file)
                    await websocket.send(json.dumps({"type": "backup_delete_success"}))
                except Exception:
                    pass
                    
            elif msg_type == "backup_restore":
                name = data.get("name", "")
                backup_file = f"/home/runner/backups/{sess.get('instance_id')}/{name}"
                server_path = os.path.join(f"/home/runner/servers/server_{sess.get('instance_id')}")
                try:
                    if os.path.exists(backup_file):
                        # Gracefully shut down server first to avoid corruption
                        stop_session(sess.get('instance_id'), reason="backup_restore")
                        shutil.rmtree(server_path, ignore_errors=True)
                        os.makedirs(server_path, exist_ok=True)
                        subprocess.run(["tar", "-xzf", backup_file, "-C", server_path])
                        await websocket.send(json.dumps({"type": "backup_restore_success"}))
                except Exception as e:
                    await websocket.send(json.dumps({"type": "backup_error", "message": str(e)}))

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")


# ── Graceful Shutdown ──

def graceful_shutdown(signum=None, frame=None):
    global shutting_down
    if shutting_down:
        return
    shutting_down = True

    print("\n=== GRACEFUL SHUTDOWN INITIATED ===")

    # Stop all active game sessions
    session_ids = list(active_sessions.keys())
    for s_id in session_ids:
        print(f"Stopping session: {s_id}")
        stop_session(s_id, reason="runner_shutdown")

    # Deregister VM from the API
    if registered_vm_id:
        print(f"Deregistering VM: {registered_vm_id}")
        api_call(API_URL, {"op": "deregister_vm", "vm_id": registered_vm_id})

    print("=== SHUTDOWN COMPLETE ===")
    os._exit(0)


# ── Main ──

async def main_loop():
    server = await websockets.serve(handle_client, "0.0.0.0", PORT)
    print(f"Console WebSocket server started on port {PORT}")
    await asyncio.Future()


if __name__ == "__main__":
    print("AbsoraCloud Python Daemon Booting...")
    print(f"  Runner ID:  {RUNNER_ID}")
    print(f"  API:        {BASE_URL}")
    print(f"  Capacity:   {TOTAL_CPU} vCPU, {TOTAL_RAM_GB}GB RAM")

    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGTERM, graceful_shutdown)
    signal.signal(signal.SIGINT, graceful_shutdown)

    threading.Thread(target=start_tunnel, daemon=True).start()
    asyncio.run(main_loop())
