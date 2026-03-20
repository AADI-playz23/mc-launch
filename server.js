#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const { spawn, execSync } = require('child_process');
const os        = require('os');

// ── Args ──────────────────────────────────────────────────────────────────────
const username     = process.argv[2] || 'Pilot';
const assignedRam  = process.argv[3] || '4G';
const softwareFile = process.argv[4] || 'paper.json';
const versionKey   = process.argv[5] || null;

const planTotalGb  = parseInt(assignedRam) || 4;
const planCores    = planTotalGb >= 16 ? 8 : planTotalGb >= 8 ? 4 : planTotalGb >= 6 ? 2 : 1;

// ── State ─────────────────────────────────────────────────────────────────────
const clients    = new Set();
const logHistory = [];
const MAX_HISTORY = 200;
let mcProcess    = null;
let serverState  = 'stopped'; // stopped | starting | running | stopping | restarting

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastAll(msg) {
    const dead = [];
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(msg);
        } else {
            dead.push(ws);
        }
    }
    dead.forEach(ws => clients.delete(ws));
}

function broadcastLog(msg) {
    logHistory.push(msg);
    if (logHistory.length > MAX_HISTORY) logHistory.shift();
    broadcastAll(JSON.stringify({ text: msg }));
}

function broadcastState(state) {
    serverState = state;
    broadcastAll(JSON.stringify({ type: 'state', state }));
}

// ── Max runtime relay ─────────────────────────────────────────────────────────
const MAX_RUNTIME_MINUTES = 345;
let elapsedMinutes = 0;

const runtimeTimer = setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        clearInterval(runtimeTimer);
        broadcastLog('\n[Absora Engine] Max lifespan reached. Initiating automated relay...\n');
        fs.writeFileSync('relay.flag', 'true');
        if (mcProcess && serverState === 'running') {
            broadcastState('stopping');
            mcProcess.stdin.write('kick @a [Absora] Cloud node transfer in 60s!\n');
            mcProcess.stdin.write('save-all\n');
            setTimeout(() => {
                mcProcess.stdin.write('stop\n');
            }, 5000);
        }
    }
}, 60000);

// ── Stats broadcast ───────────────────────────────────────────────────────────
setInterval(() => {
    if (clients.size === 0) return;
    try {
        const totalMem   = os.totalmem();
        const freeMem    = os.freemem();
        const usedBytes  = totalMem - freeMem;
        const usedGb     = usedBytes / (1024 ** 3);
        const usedDisplay = Math.min(usedGb, planTotalGb * 0.98);
        const ramPct     = Math.round((usedDisplay / planTotalGb) * 1000) / 10;

        // CPU: average load over last 1 min, scaled to percentage
        const load    = os.loadavg()[0];
        const cpuCount = os.cpus().length;
        const cpuPct  = Math.min(Math.round((load / cpuCount) * 1000) / 10, 100);

        broadcastAll(JSON.stringify({
            type:       'stats',
            ram:        `${usedDisplay.toFixed(2)}GB / ${planTotalGb.toFixed(2)}GB`,
            ramPercent: String(ramPct),
            cpu:        `${cpuPct}% (${planCores} vCPU)`,
            cpuPercent: String(cpuPct),
            state:      serverState
        }));
    } catch (e) { /* ignore */ }
}, 3000);

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
    host: '0.0.0.0',
    port: 8080,
    maxPayload: 1024 * 1024,  // 1MB
});

// Keep-alive ping
const pingInterval = setInterval(() => {
    for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clients.delete(ws);
    }
}, 20000);

wss.on('connection', (ws) => {
    clients.add(ws);

    // Send log history + current state to new client
    if (logHistory.length > 0) {
        ws.send(JSON.stringify({ text: logHistory.join('') }));
    }
    ws.send(JSON.stringify({ type: 'state', state: serverState }));

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw.toString());
            if (data.type !== 'command') return;
            const cmd = (data.command || '').trim().toLowerCase();

            if (cmd === 'restart') {
                if (serverState !== 'running') {
                    ws.send(JSON.stringify({ text: '\n[Absora Engine] Server is not running.\n' }));
                    return;
                }
                broadcastState('restarting');
                broadcastLog('\n[Absora Engine] Soft Reboot requested. Saving world...\n');
                mcProcess.stdin.write('save-all\n');
                setTimeout(() => mcProcess.stdin.write('stop\n'), 3000);

            } else if (cmd === 'stop') {
                if (serverState !== 'running') {
                    ws.send(JSON.stringify({ text: '\n[Absora Engine] Server is not running.\n' }));
                    return;
                }
                broadcastState('stopping');
                broadcastLog('\n[Absora Engine] Manual shutdown. Saving world...\n');
                mcProcess.stdin.write('save-all\n');
                setTimeout(() => mcProcess.stdin.write('stop\n'), 3000);

            } else {
                if (mcProcess && serverState === 'running') {
                    mcProcess.stdin.write(data.command + '\n');
                } else {
                    ws.send(JSON.stringify({ text: '\n[Absora Engine] Cannot send command — server not running.\n' }));
                }
            }
        } catch (e) { /* ignore bad messages */ }
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
});

wss.on('listening', () => {
    broadcastLog('[Absora Engine] WebSocket server ready on port 8080\n');
    startMinecraft();
});

// ── Minecraft launcher ────────────────────────────────────────────────────────
function startMinecraft() {
    broadcastState('starting');

    // Auto-accept EULA
    fs.writeFileSync('eula.txt', 'eula=true\n');

    let launchCmd;
    let launchArgs = [];
    let targetJar  = 'server.jar';

    if (fs.existsSync('run.sh')) {
        // NeoForge / modded server with run.sh
        fs.writeFileSync('user_jvm_args.txt', `-Xms${assignedRam} -Xmx${assignedRam}`);
        launchCmd  = 'sh';
        launchArgs = ['run.sh', 'nogui'];

    } else {
        // Find existing JAR
        const jars = fs.readdirSync('.').filter(f => f.endsWith('.jar') && f !== 'server.js');
        if (jars.length > 0) {
            targetJar = jars[0];
        } else if (versionKey) {
            // Auto-download JAR
            broadcastLog(`\n[Absora Engine] No JAR found. Auto-downloading ${versionKey}...\n`);
            try {
                const jsonPath = path.join('..', softwareFile);
                if (!fs.existsSync(jsonPath)) throw new Error(`${softwareFile} missing`);
                const db  = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const url = (db.versions || db)[versionKey];
                if (!url) throw new Error(`Version "${versionKey}" not found in ${softwareFile}`);
                broadcastLog(`[Absora Engine] Fetching: ${url}\n`);
                execSync(`wget -q -O server.jar "${url}"`, { stdio: 'inherit' });
                broadcastLog('[Absora Engine] Download complete. Igniting...\n');
            } catch (e) {
                broadcastLog(`[Absora Engine] CRITICAL: ${e.message}\n`);
                broadcastState('stopped');
                return;
            }
        } else {
            broadcastLog('[Absora Engine] CRITICAL: No JAR and no version specified.\n');
            broadcastState('stopped');
            return;
        }

        launchCmd  = 'java';
        launchArgs = [
            `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled',
            '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
            '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
            '-XX:G1HeapWastePercent=5',
            '-jar', targetJar, 'nogui'
        ];
    }

    mcProcess = spawn(launchCmd, launchArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    broadcastState('running');

    mcProcess.stdout.on('data', (data) => broadcastLog(data.toString()));
    mcProcess.stderr.on('data', (data) => broadcastLog(data.toString()));

    mcProcess.on('exit', () => {
        const prev = serverState;
        mcProcess  = null;

        if (prev === 'restarting') {
            broadcastLog('\n[Absora Engine] JVM offline. Restarting in 8s...\n');
            broadcastState('restarting');
            setTimeout(startMinecraft, 8000);
        } else {
            broadcastState('stopped');
            broadcastLog('\n[Absora Engine] Server stopped. Syncing to cloud...\n');
            clearInterval(pingInterval);
            setTimeout(() => process.exit(0), 1000);
        }
    });

    mcProcess.on('error', (e) => {
        broadcastLog(`[Absora Engine] CRITICAL: Failed to launch — ${e.message}\n`);
        broadcastState('stopped');
    });
}
