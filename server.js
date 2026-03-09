const { spawn } = require('child_process');
const WebSocket = require('ws');
const os = require('os'); 

const username = process.argv[2] || 'Pilot';
const assignedRam = process.argv[3] || '4G';
const wss = new WebSocket.Server({ port: 8080 });

let planTotalGB = parseInt(assignedRam) || 4; 
let planCores = 1;
if (planTotalGB >= 6) planCores = 2;
if (planTotalGB >= 8) planCores = 4;
if (planTotalGB >= 16) planCores = 8;

let activeClients = [];
const MAX_LOG_HISTORY = 50; 
let logHistory = [];
let mcServer;
let intentionalStop = false;

const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); 
    activeClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ text: text })); } });
};

// --- ABSORA RELAY KILLSWITCH ---
// Safely shut down at 5 hours and 45 minutes to prevent data corruption
const MAX_RUNTIME_MINUTES = 345; 
let elapsedMinutes = 0;

setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes === 340) {
        broadcast("\n[Absora Cloud] WARNING: Approaching node maximum lifespan. Cloud relay transfer initiating in 5 minutes. Server will briefly restart.");
        if (mcServer) mcServer.stdin.write('say [Absora] Server cloud node transferring in 5 minutes! You will be disconnected briefly.\n');
    }
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        broadcast("\n[Absora Cloud] Initiating automated Relay Transfer. Saving data...");
        intentionalStop = true;
        if (mcServer) {
            mcServer.stdin.write('kick @a [Absora] Cloud node transfer in progress. Please reconnect in 60 seconds!\n');
            mcServer.stdin.write('save-all\n');
            setTimeout(() => { mcServer.stdin.write('stop\n'); }, 3000);
        }
    }
}, 60000); // Check every 1 minute
// -------------------------------

setInterval(() => {
    if (activeClients.length > 0) {
        const realTotal = os.totalmem();
        const realFree = os.freemem();
        const realUsed = realTotal - realFree;
        const realUsedGB = realUsed / (1024 * 1024 * 1024);
        const realCpuLoad = os.loadavg()[0] / os.cpus().length;

        let displayUsedGB = 0;
        if (planTotalGB <= 8) {
            displayUsedGB = Math.min(realUsedGB, planTotalGB * 0.98);
        } else {
            const memoryPercent = realUsed / realTotal;
            displayUsedGB = planTotalGB * memoryPercent;
        }

        const ramPercent = ((displayUsedGB / planTotalGB) * 100).toFixed(1);
        const ramString = `${displayUsedGB.toFixed(2)}GB / ${planTotalGB.toFixed(2)}GB`;
        const cpuPercentNum = Math.min((realCpuLoad * 100), 100).toFixed(1);
        const cpuString = `${cpuPercentNum}% (${planCores} vCPU)`;

        const statsPayload = JSON.stringify({ type: 'stats', ram: ramString, ramPercent: ramPercent, cpu: cpuString, cpuPercent: cpuPercentNum });
        activeClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) { ws.send(statsPayload); } });
    }
}, 3000);

wss.on('connection', (ws) => {
    activeClients.push(ws);
    console.log("[Absora] Web Dashboard connected to telemetry stream.");
    if (logHistory.length > 0) { ws.send(JSON.stringify({ text: logHistory.join('') })); }
    ws.on('error', () => {});
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'command' && mcServer) {
                const cmd = data.command.trim().toLowerCase();
                if (cmd === 'stop') { intentionalStop = true; } 
                else if (cmd === 'restart') { intentionalStop = false; mcServer.stdin.write("stop\n"); return; }
                mcServer.stdin.write(data.command + "\n");
            }
        } catch(e) {}
    });
    ws.on('close', () => { activeClients = activeClients.filter(client => client !== ws); });
});

function startMinecraft() {
    broadcast(`[Absora] Booting Engine with ${assignedRam} RAM allocation...\n`);
    mcServer = spawn('java', [
        `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
        '-XX:+AlwaysPreTouch', '-XX:+DisableExplicitGC', '-XX:+ParallelRefProcEnabled',
        '-XX:+PerfDisableSharedMem', '-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC',
        '-XX:G1HeapRegionSize=8M', '-XX:G1HeapWastePercent=5', '-XX:G1MaxNewSizePercent=40',
        '-XX:G1MixedGCCountTarget=4', '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1NewSizePercent=30', '-XX:G1RSetUpdatingPauseTimePercent=5',
        '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15',
        '-XX:MaxGCPauseMillis=200', '-XX:MaxTenuringThreshold=1', '-XX:SurvivorRatio=32',
        '-jar', 'server.jar', 'nogui'
    ]);

    mcServer.stdout.on('data', (data) => { process.stdout.write(data); broadcast(data.toString()); });
    mcServer.stderr.on('data', (data) => { process.stderr.write(data); broadcast(data.toString()); });

    mcServer.on('close', (code) => {
        if (intentionalStop) {
            broadcast("\n[Absora] Engine shut down. Terminating orbital container...");
            process.exit(0); 
        } else {
            broadcast(`\n[Absora] Server stopped. Rebooting in 5 seconds...`);
            setTimeout(startMinecraft, 5000); 
        }
    });
}

startMinecraft();
