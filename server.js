const { spawn, execSync } = require('child_process');
const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');

const username = process.argv[2] || 'Pilot';
const assignedRam = process.argv[3] || '4G';
const softwareFile = process.argv[4] || 'paper.json';
const versionKey = process.argv[5];
const wss = new WebSocket.Server({ port: 8080 });

let planTotalGB = parseInt(assignedRam) || 4;
let planCores = planTotalGB >= 16 ? 8 : (planTotalGB >= 8 ? 4 : (planTotalGB >= 6 ? 2 : 1));

let activeClients = [];
const MAX_LOG_HISTORY = 200;
let logHistory = [];
let mcServer = null;
let isRestarting = false;
let serverStarted = false;

// ── Broadcast to all connected WebSocket clients ──────────────────────────────
const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift();
    
    // Save to file so history survives refreshes and days!
    try { fs.appendFileSync('absora.log', text); } catch(e) {}

    activeClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ text }));
        }
    });
};

// ── Max runtime relay flag ────────────────────────────────────────────────────
const MAX_RUNTIME_MINUTES = 345;
let elapsedMinutes = 0;
setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        broadcast("\n[Absora Engine] Max lifespan reached. Initiating automated relay...\n");
        fs.writeFileSync('relay.flag', 'true');
        if (mcServer) {
            mcServer.stdin.write('say [Absora] Cloud node transfer in 60s! Find a safe spot.\n');
            setTimeout(() => { 
                if (mcServer) {
                    mcServer.stdin.write('kick @a [Absora] Node transferring. Reconnect in 2 minutes!\n');
                    mcServer.stdin.write('save-all\n');
                    setTimeout(() => { if (mcServer) mcServer.stdin.write('stop\n'); }, 5000); 
                }
            }, 60000);
        }
    }
}, 60000);

// ── Stats broadcast every 3s ─────────────────────────────────────────────────
setInterval(() => {
    if (activeClients.length === 0) return;
    const realTotal = os.totalmem();
    const realFree = os.freemem();
    const displayUsedGB = planTotalGB <= 8
        ? Math.min((realTotal - realFree) / (1024 ** 3), planTotalGB * 0.98)
        : planTotalGB * ((realTotal - realFree) / realTotal);
    const ramPercent = ((displayUsedGB / planTotalGB) * 100).toFixed(1);
    const cpuPercentNum = Math.min(((os.loadavg()[0] / os.cpus().length) * 100), 100).toFixed(1);
    const statusMsg = serverStarted ? 'online' : (isRestarting ? 'restarting' : 'stopped');

    activeClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stats',
                ram: `${displayUsedGB.toFixed(2)}GB / ${planTotalGB.toFixed(2)}GB`,
                ramPercent,
                cpu: `${cpuPercentNum}% (${planCores} vCPU)`,
                cpuPercent: cpuPercentNum,
                status: statusMsg
            }));
        }
    });
}, 3000);

// ── WebSocket connection handler ──────────────────────────────────────────────
wss.on('connection', (ws) => {
    activeClients.push(ws);
    if (logHistory.length > 0) ws.send(JSON.stringify({ text: logHistory.join('') }));
    ws.send(JSON.stringify({ type: 'status', status: serverStarted ? 'online' : (isRestarting ? 'restarting' : 'stopped') }));
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type !== 'command') return;
            const cmd = data.command.trim().toLowerCase();

            if (cmd === 'restart') {
                if (!mcServer || !serverStarted) return broadcast("\n[Absora Engine] No running server to restart.\n");
                isRestarting = true; serverStarted = false;
                broadcast("\n[Absora Engine] Soft Reboot requested. Saving world...\n");
                mcServer.stdin.write("save-all\n");
                setTimeout(() => { if (mcServer) mcServer.stdin.write("stop\n"); }, 2000);
                return;
            }
            if (cmd === 'stop') {
                if (!mcServer || !serverStarted) return broadcast("\n[Absora Engine] No running server to stop.\n");
                isRestarting = false; serverStarted = false;
                broadcast("\n[Absora Engine] Manual shutdown initiated...\n");
                mcServer.stdin.write("save-all\n");
                setTimeout(() => { if (mcServer) mcServer.stdin.write("stop\n"); }, 2000);
                return;
            }
            if (mcServer && serverStarted) mcServer.stdin.write(data.command + "\n");
        } catch (e) {}
    });

    ws.on('close', () => activeClients = activeClients.filter(c => c !== ws));
});

const heartbeatInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) { activeClients = activeClients.filter(c => c !== ws); return ws.terminate(); }
        ws.isAlive = false; ws.ping();
    });
}, 20000);
wss.on('close', () => clearInterval(heartbeatInterval));

// ── Async Minecraft server launcher ──────────────────────────────────────────
async function startMinecraft() {
    if (!fs.existsSync('eula.txt')) {
        fs.writeFileSync('eula.txt', 'eula=true\n');
        broadcast("[Absora Engine] Auto-accepted Minecraft EULA.\n");
    }

    let launchCmd = 'java';
    let launchArgs = [];
    let targetJar = 'server.jar';

    const existingJars = fs.readdirSync('.').filter(f => f.endsWith('.jar') && !f.includes('installer') && f !== 'server.js');
    const hasRunSh = fs.existsSync('run.sh');

    if (!hasRunSh && existingJars.length === 0) {
        if (versionKey) {
            broadcast(`\n[Absora Engine] Engine not found. Auto-Downloading: ${versionKey}...\n`);
            try {
                const jsonPath = `../${softwareFile}`;
                if (!fs.existsSync(jsonPath)) throw new Error(`${softwareFile} missing.`);
                const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const downloadUrl = jsonData.versions ? (jsonData.versions[versionKey] || jsonData.versions[jsonData.latest]) : jsonData[versionKey];
                if (!downloadUrl) throw new Error(`Version "${versionKey}" not found.`);

                broadcast(`[Absora Engine] Fetching: ${downloadUrl}\n`);
                execSync(`wget -q -O server.jar "${downloadUrl}"`);

                if (softwareFile === 'forge.json') {
                    broadcast(`\n[Absora Engine] Executing Modded Installer (This may take 2-3 minutes)...\n`);
                    await new Promise((resolve) => {
                        const inst = spawn('java', ['-jar', 'server.jar', '--installServer']);
                        inst.stdout.on('data', d => broadcast(d.toString()));
                        inst.stderr.on('data', d => broadcast(d.toString()));
                        inst.on('close', () => {
                            try { fs.renameSync('server.jar', 'installer.jar.bak'); } catch(e){}
                            resolve();
                        });
                    });
                    broadcast(`[Absora Engine] Installation finished.\n`);
                } else {
                    targetJar = 'server.jar';
                }
            } catch (err) {
                return broadcast(`[Absora Engine] CRITICAL: Auto-Download failed — ${err.message}\n`);
            }
        } else {
            return broadcast(`[Absora Engine] CRITICAL: No engine found and no version specified.\n`);
        }
    }

    if (fs.existsSync('run.sh')) {
        fs.writeFileSync('user_jvm_args.txt', `-Xms${assignedRam} -Xmx${assignedRam}`);
        try { let rs = fs.readFileSync('run.sh', 'utf8'); if (rs.includes('pause')) fs.writeFileSync('run.sh', rs.replace(/pause/ig, '')); } catch(e) {}
        launchCmd = 'sh';
        launchArgs = ['run.sh', 'nogui'];
    } else {
        const files = fs.readdirSync('.');
        if (fs.existsSync('server.jar')) targetJar = 'server.jar';
        else {
            const mainJar = files.find(f => f.endsWith('.jar') && !f.includes('installer') && f !== 'server.js');
            if (mainJar) targetJar = mainJar;
        }
        launchArgs = [ `-Xms${assignedRam}`, `-Xmx${assignedRam}`, '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-jar', targetJar, 'nogui' ];
    }

    broadcast(`\n[Absora Engine] Igniting engine with ${assignedRam} RAM...\n`);
    mcServer = spawn(launchCmd, launchArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

    mcServer.stdout.on('data', (data) => {
        const text = data.toString();
        process.stdout.write(text);
        broadcast(text);
        
        const lowerTxt = text.toLowerCase();
        if (lowerTxt.includes('done') || lowerTxt.includes('listening on') || lowerTxt.includes('started velocity') || lowerTxt.includes('startup done') || lowerTxt.includes('for help, type')) {
            if (!serverStarted) {
                serverStarted = true;
                broadcast("\n[Absora Engine] Server is ONLINE and accepting connections.\n");
            }
        }
    });

    mcServer.stderr.on('data', (data) => {
        const text = data.toString();
        process.stderr.write(text);
        broadcast(text);
    });

    mcServer.on('close', (code) => {
        serverStarted = false; mcServer = null;
        if (isRestarting) {
            broadcast("\n[Absora Engine] JVM offline. Purging cache (8 seconds)...\n");
            isRestarting = false;
            setTimeout(startMinecraft, 8000);
        } else {
            broadcast(`\n[Absora Engine] Process exited (code ${code}). Syncing to Cloud...\n`);
            process.exit(0);
        }
    });

    mcServer.on('error', (err) => {
        broadcast(`\n[Absora Engine] Failed to spawn process: ${err.message}\n`);
        serverStarted = false; mcServer = null;
    });
}

startMinecraft();
