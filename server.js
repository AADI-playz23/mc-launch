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

// FIX: Use a proper enum-style state instead of a boolean flag
// States: 'running', 'restarting', 'stopping', 'stopped'
let serverState = 'stopped';

const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); 
    activeClients.forEach(ws => { 
        if (ws.readyState === WebSocket.OPEN) { 
            ws.send(JSON.stringify({ text: text })); 
        } 
    });
};

// Broadcast current server state to all clients so UI can sync
const broadcastState = (state) => {
    activeClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'state', state: state }));
        }
    });
};

const MAX_RUNTIME_MINUTES = 345; 
let elapsedMinutes = 0;

setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        broadcast("\n[Absora Engine] Max lifespan reached. Initiating automated relay...\n");
        fs.writeFileSync('relay.flag', 'true'); 
        if (mcServer && serverState === 'running') {
            serverState = 'stopping';
            mcServer.stdin.write('kick @a [Absora] Cloud node transfer in 60s!\n');
            mcServer.stdin.write('save-all\n');
            setTimeout(() => { 
                if (mcServer) mcServer.stdin.write('stop\n'); 
            }, 5000);
        }
    }
}, 60000); 

// Stats broadcast interval
setInterval(() => {
    if (activeClients.length > 0) {
        const realTotal = os.totalmem();
        const realFree = os.freemem();
        const displayUsedGB = planTotalGB <= 8 
            ? Math.min((realTotal - realFree) / (1024 ** 3), planTotalGB * 0.98) 
            : planTotalGB * ((realTotal - realFree) / realTotal);
        const ramPercent = ((displayUsedGB / planTotalGB) * 100).toFixed(1);
        const cpuPercentNum = Math.min(((os.loadavg()[0] / os.cpus().length) * 100), 100).toFixed(1);
        activeClients.forEach(ws => { 
            if (ws.readyState === WebSocket.OPEN) { 
                ws.send(JSON.stringify({ 
                    type: 'stats', 
                    ram: `${displayUsedGB.toFixed(2)}GB / ${planTotalGB.toFixed(2)}GB`, 
                    ramPercent: ramPercent, 
                    cpu: `${cpuPercentNum}% (${planCores} vCPU)`, 
                    cpuPercent: cpuPercentNum,
                    state: serverState
                })); 
            } 
        });
    }
}, 3000);

wss.on('connection', (ws) => {
    activeClients.push(ws);
    
    // Send full log history to new client
    if (logHistory.length > 0) { 
        ws.send(JSON.stringify({ text: logHistory.join('') })); 
    }
    
    // FIX: Send current server state immediately on connect so UI is always in sync
    ws.send(JSON.stringify({ type: 'state', state: serverState }));
    
    ws.on('error', () => {});
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'command') {
                const cmd = data.command.trim().toLowerCase();
                
                // FIX: Handle restart properly - set state BEFORE writing to stdin
                if (cmd === 'restart') {
                    if (serverState !== 'running') {
                        ws.send(JSON.stringify({ text: '\n[Absora Engine] Server is not running.\n' }));
                        return;
                    }
                    serverState = 'restarting';
                    broadcastState('restarting');
                    broadcast("\n[Absora Engine] Soft Reboot requested. Saving world...\n");
                    mcServer.stdin.write("save-all\n");
                    // FIX: Give save-all time to run before stop
                    setTimeout(() => { 
                        if (mcServer) mcServer.stdin.write("stop\n"); 
                    }, 3000);
                    return; 
                }
                
                // FIX: Handle stop properly
                if (cmd === 'stop') {
                    if (serverState !== 'running') {
                        ws.send(JSON.stringify({ text: '\n[Absora Engine] Server is not running.\n' }));
                        return;
                    }
                    serverState = 'stopping';
                    broadcastState('stopping');
                    broadcast("\n[Absora Engine] Manual shutdown initiated. Saving world...\n");
                    mcServer.stdin.write("save-all\n");
                    setTimeout(() => { 
                        if (mcServer) mcServer.stdin.write("stop\n"); 
                    }, 3000);
                    return;
                }
                
                // All other commands - only if running
                if (mcServer && serverState === 'running') {
                    mcServer.stdin.write(data.command + "\n");
                } else {
                    ws.send(JSON.stringify({ text: '\n[Absora Engine] Cannot send command - server not running.\n' }));
                }
            }
        } catch(e) {}
    });
    
    ws.on('close', () => { 
        activeClients = activeClients.filter(c => c !== ws); 
    });
});

function startMinecraft() {
    let launchCmd = 'java';
    let launchArgs = [];
    let targetJar = 'server.jar'; 

    serverState = 'starting';
    broadcastState('starting');

    if (fs.existsSync('run.sh')) {
        fs.writeFileSync('user_jvm_args.txt', `-Xms${assignedRam} -Xmx${assignedRam}`);
        launchCmd = 'sh';
        launchArgs = ['run.sh', 'nogui'];
    } else {
        const files = fs.readdirSync('.');
        const foundJar = files.find(f => f.endsWith('.jar') && f !== 'server.js');
        
        if (foundJar) {
            targetJar = foundJar;
        } else if (versionKey) {
            broadcast(`\n[Absora Engine] No engine found. Initiating Auto-Download for ${versionKey}...\n`);
            try {
                const jsonPath = `../${softwareFile}`;
                if (fs.existsSync(jsonPath)) {
                    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                    const downloadUrl = jsonData.versions ? jsonData.versions[versionKey] : jsonData[versionKey];

                    if (downloadUrl) {
                        broadcast(`[Absora Engine] Fetching from: ${downloadUrl}\n`);
                        execSync(`wget -q --show-progress -O server.jar "${downloadUrl}" 2>&1`, { stdio: 'inherit' });
                        targetJar = 'server.jar';
                        broadcast(`[Absora Engine] Download complete. Igniting...\n`);
                    } else {
                        throw new Error(`Version key "${versionKey}" not found in ${softwareFile}`);
                    }
                } else {
                    throw new Error(`${softwareFile} missing from repository.`);
                }
            } catch(err) {
                broadcast(`[Absora Engine] CRITICAL: Auto-Download failed (${err.message}).\n`);
                broadcast("[Absora Engine] Entering Standby Mode. Upload via Files tab.\n");
                serverState = 'stopped';
                broadcastState('stopped');
                return;
            }
        } else {
            broadcast(`[Absora Engine] CRITICAL: No engine found and no version specified.\n`);
            serverState = 'stopped';
            broadcastState('stopped');
            return;
        }

        launchArgs = [
            `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
            '-XX:+UnlockExperimentalVMOptions', '-XX:G1HeapRegionSize=8M',
            '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5',
            '-jar', targetJar, 'nogui'
        ];
    }

    mcServer = spawn(launchCmd, launchArgs);
    serverState = 'running';
    broadcastState('running');
    
    mcServer.stdout.on('data', (data) => { 
        process.stdout.write(data); 
        broadcast(data.toString()); 
    });
    mcServer.stderr.on('data', (data) => { 
        process.stderr.write(data); 
        broadcast(data.toString()); 
    });
    
    mcServer.on('close', (code) => {
        mcServer = null;
        const prevState = serverState;
        
        if (prevState === 'restarting') {
            // FIX: Don't reset state until we actually restart
            broadcast("\n[Absora Engine] JVM offline. Purging cache (8 seconds)...\n");
            serverState = 'restarting'; // keep restarting state
            broadcastState('restarting');
            setTimeout(startMinecraft, 8000); 
        } else {
            // Was stopping or crashed
            serverState = 'stopped';
            broadcastState('stopped');
            broadcast("\n[Absora Engine] Container shutting down. Syncing volumes to Cloud...\n");
            process.exit(0); 
        }
    });
}

startMinecraft();
