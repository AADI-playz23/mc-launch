#!/usr/bin/env python3
import asyncio
import websockets
import json
import os
import sys
import subprocess
import threading
import time
import psutil

# ── Args ──────────────────────────────────────────────────────────────────────
username     = sys.argv[1] if len(sys.argv) > 1 else 'Pilot'
assigned_ram = sys.argv[2] if len(sys.argv) > 2 else '4G'
software_file = sys.argv[3] if len(sys.argv) > 3 else 'paper.json'
version_key  = sys.argv[4] if len(sys.argv) > 4 else None

plan_total_gb = int(''.join(filter(str.isdigit, assigned_ram))) or 4
plan_cores    = 8 if plan_total_gb >= 16 else (4 if plan_total_gb >= 8 else (2 if plan_total_gb >= 6 else 1))

# ── State ─────────────────────────────────────────────────────────────────────
clients      = set()
log_history  = []
MAX_HISTORY  = 200
mc_process   = None
server_state = 'stopped'   # stopped | starting | running | stopping | restarting

# ── Helpers ───────────────────────────────────────────────────────────────────
def broadcast_sync(msg: str):
    """Thread-safe broadcast — called from subprocess reader threads."""
    log_history.append(msg)
    if len(log_history) > MAX_HISTORY:
        log_history.pop(0)
    asyncio.run_coroutine_threadsafe(_broadcast_all(json.dumps({'text': msg})), loop)

def broadcast_state(state: str):
    global server_state
    server_state = state
    asyncio.run_coroutine_threadsafe(_broadcast_all(json.dumps({'type': 'state', 'state': state})), loop)

async def _broadcast_all(msg: str):
    dead = set()
    for ws in list(clients):
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    clients.difference_update(dead)

# ── Max runtime relay ─────────────────────────────────────────────────────────
MAX_RUNTIME_MINUTES = 345
elapsed_minutes = 0

def runtime_tick():
    global elapsed_minutes
    while True:
        time.sleep(60)
        elapsed_minutes += 1
        if elapsed_minutes >= MAX_RUNTIME_MINUTES:
            broadcast_sync('\n[Absora Engine] Max lifespan reached. Initiating automated relay...\n')
            open('relay.flag', 'w').write('true')
            if mc_process and server_state == 'running':
                broadcast_state('stopping')
                mc_process.stdin.write('kick @a [Absora] Cloud node transfer in 60s!\n')
                mc_process.stdin.flush()
                mc_process.stdin.write('save-all\n')
                mc_process.stdin.flush()
                time.sleep(5)
                mc_process.stdin.write('stop\n')
                mc_process.stdin.flush()
            break

threading.Thread(target=runtime_tick, daemon=True).start()

# ── Stats broadcast ───────────────────────────────────────────────────────────
def stats_tick():
    while True:
        time.sleep(3)
        if not clients:
            continue
        try:
            mem  = psutil.virtual_memory()
            used = mem.used / (1024 ** 3)
            total = plan_total_gb
            used_display = min(used, total * 0.98)
            ram_pct = round((used_display / total) * 100, 1)
            cpu_pct = round(min(psutil.cpu_percent(interval=None), 100), 1)
            msg = json.dumps({
                'type':       'stats',
                'ram':        f'{used_display:.2f}GB / {total:.2f}GB',
                'ramPercent': str(ram_pct),
                'cpu':        f'{cpu_pct}% ({plan_cores} vCPU)',
                'cpuPercent': str(cpu_pct),
                'state':      server_state
            })
            asyncio.run_coroutine_threadsafe(_broadcast_all(msg), loop)
        except Exception:
            pass

threading.Thread(target=stats_tick, daemon=True).start()

# ── WebSocket handler ─────────────────────────────────────────────────────────
async def handler(ws):
    clients.add(ws)

    # Send log history + current state to new client
    if log_history:
        await ws.send(json.dumps({'text': ''.join(log_history)}))
    await ws.send(json.dumps({'type': 'state', 'state': server_state}))

    try:
        async for raw in ws:
            try:
                data = json.loads(raw)
                if data.get('type') != 'command':
                    continue
                cmd = data.get('command', '').strip().lower()

                if cmd == 'restart':
                    if server_state != 'running':
                        await ws.send(json.dumps({'text': '\n[Absora Engine] Server is not running.\n'}))
                        continue
                    broadcast_state('restarting')
                    broadcast_sync('\n[Absora Engine] Soft Reboot requested. Saving world...\n')
                    mc_process.stdin.write('save-all\n')
                    mc_process.stdin.flush()
                    await asyncio.sleep(3)
                    mc_process.stdin.write('stop\n')
                    mc_process.stdin.flush()

                elif cmd == 'stop':
                    if server_state != 'running':
                        await ws.send(json.dumps({'text': '\n[Absora Engine] Server is not running.\n'}))
                        continue
                    broadcast_state('stopping')
                    broadcast_sync('\n[Absora Engine] Manual shutdown. Saving world...\n')
                    mc_process.stdin.write('save-all\n')
                    mc_process.stdin.flush()
                    await asyncio.sleep(3)
                    mc_process.stdin.write('stop\n')
                    mc_process.stdin.flush()

                else:
                    if mc_process and server_state == 'running':
                        mc_process.stdin.write(data['command'] + '\n')
                        mc_process.stdin.flush()
                    else:
                        await ws.send(json.dumps({'text': '\n[Absora Engine] Cannot send command — server not running.\n'}))
            except Exception:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(ws)

# ── Minecraft launcher ────────────────────────────────────────────────────────
def stream_output(pipe, label):
    """Read MC process stdout/stderr and broadcast line by line."""
    try:
        for line in iter(pipe.readline, ''):
            if line:
                broadcast_sync(line)
    except Exception:
        pass

def start_minecraft():
    global mc_process, server_state

    broadcast_state('starting')

    launch_cmd  = None
    launch_args = []
    target_jar  = 'server.jar'

    # Auto-accept EULA
    open('eula.txt', 'w').write('eula=true\n')

    if os.path.exists('run.sh'):
        open('user_jvm_args.txt', 'w').write(f'-Xms{assigned_ram} -Xmx{assigned_ram}')
        launch_cmd  = 'sh'
        launch_args = ['run.sh', 'nogui']
    else:
        jars = [f for f in os.listdir('.') if f.endswith('.jar') and f != 'server.py']
        if jars:
            target_jar = jars[0]
        elif version_key:
            broadcast_sync(f'\n[Absora Engine] No JAR found. Auto-downloading {version_key}...\n')
            try:
                json_path = f'../{software_file}'
                if not os.path.exists(json_path):
                    raise FileNotFoundError(f'{software_file} missing')
                with open(json_path) as f:
                    import json as _json
                    data = _json.load(f)
                url = data.get('versions', data).get(version_key)
                if not url:
                    raise ValueError(f'Version "{version_key}" not found in {software_file}')
                broadcast_sync(f'[Absora Engine] Fetching: {url}\n')
                subprocess.run(['wget', '-q', '-O', 'server.jar', url], check=True)
                broadcast_sync('[Absora Engine] Download complete. Igniting...\n')
            except Exception as e:
                broadcast_sync(f'[Absora Engine] CRITICAL: {e}\n')
                broadcast_state('stopped')
                return
        else:
            broadcast_sync('[Absora Engine] CRITICAL: No JAR and no version specified.\n')
            broadcast_state('stopped')
            return

        launch_cmd  = 'java'
        launch_args = [
            f'-Xms{assigned_ram}', f'-Xmx{assigned_ram}',
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled',
            '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
            '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
            '-XX:G1HeapWastePercent=5',
            '-jar', target_jar, 'nogui'
        ]

    mc_process = subprocess.Popen(
        [launch_cmd] + launch_args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )

    broadcast_state('running')

    # Stream stdout and stderr in background threads
    threading.Thread(target=stream_output, args=(mc_process.stdout, 'stdout'), daemon=True).start()
    threading.Thread(target=stream_output, args=(mc_process.stderr, 'stderr'), daemon=True).start()

    # Wait for process to exit
    def wait_exit():
        global mc_process
        mc_process.wait()
        prev = server_state
        mc_process = None

        if prev == 'restarting':
            broadcast_sync('\n[Absora Engine] JVM offline. Restarting in 8s...\n')
            broadcast_state('restarting')
            time.sleep(8)
            start_minecraft()
        else:
            broadcast_state('stopped')
            broadcast_sync('\n[Absora Engine] Server stopped. Syncing to cloud...\n')
            os._exit(0)

    threading.Thread(target=wait_exit, daemon=False).start()

# ── Main ──────────────────────────────────────────────────────────────────────
async def main():
    # websockets 10+ compatible — works great behind cloudflared
    async with websockets.serve(
        handler,
        '0.0.0.0',
        8080,
        ping_interval=20,
        ping_timeout=60,
        max_size=2**20
    ):
        broadcast_sync('[Absora Engine] WebSocket server ready on port 8080\n')
        start_minecraft()
        await asyncio.Future()  # run forever

loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
loop.run_until_complete(main())
