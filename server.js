const { spawn } = require('child_process');
const WebSocket = require('ws');
const os = require('os'); 
const fs = require('fs');

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

const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); 
    activeClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ text: text })); } });
};

const MAX_RUNTIME_MINUTES = 345; 
let elapsedMinutes = 0;

setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes === 340) {
        broadcast("\n[Absora Cloud] WARNING: Approaching node maximum lifespan. Cloud relay transfer initiating in 5 minutes.");
        if (mcServer) mcServer.stdin.write('say [Absora] Server cloud node transferring in 5 minutes!\n');
    }
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        broadcast("\n[Absora Cloud] Initiating automated Relay Transfer. Saving data...");
        fs.writeFileSync('relay.flag', 'true'); 
        if (mcServer) {
            mcServer.stdin.write('kick @a [Absora] Cloud node transfer in progress. Please reconnect in 60 seconds!\n');
            mcServer.stdin.write('save-all\n');
            setTimeout(() => { mcServer.stdin.write('stop\n'); }, 3000);
        }
    }
}, 60000); 

setInterval(() => {
    if (activeClients.length > 0) {
        const realTotal = os.totalmem();
        const realFree = os.freemem();
        const displayUsedGB = planTotalGB <= 8 ? Math.min((realTotal - realFree) / (1024 ** 3), planTotalGB * 0.98) : planTotalGB * ((realTotal - realFree) / realTotal);
        const ramPercent = ((displayUsedGB / planTotalGB) * 100).toFixed(1);
        const ramString = `${displayUsedGB.toFixed(2)}GB / ${planTotalGB.toFixed(2)}GB`;
        const cpuPercentNum = Math.min(((os.loadavg()[0] / os.cpus().length) * 100), 100).toFixed(1);
        const cpuString = `${cpuPercentNum}% (${planCores} vCPU)`;
        activeClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'stats', ram: ramString, ramPercent: ramPercent, cpu: cpuString, cpuPercent: cpuPercentNum })); } });
    }
}, 3000);

wss.on('connection', (ws) => {
    activeClients.push(ws);
    if (logHistory.length > 0) { ws.send(JSON.stringify({ text: logHistory.join('') })); }
    ws.on('error', () => {});
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'command' && mcServer) {
                const cmd = data.command.trim().toLowerCase();
                if (cmd === 'restart') { mcServer.stdin.write("stop\n"); return; }
                mcServer.stdin.write(data.command + "\n");
            }
        } catch(e) {}
    });
    ws.on('close', () => { activeClients = activeClients.filter(client => client !== ws); });
});

function startMinecraft() {
    let launchCmd = 'java';
    let launchArgs = [];

    if (fs.existsSync('run.sh')) {
        fs.writeFileSync('user_jvm_args.txt', `-Xms${assignedRam} -Xmx${assignedRam}`);
        launchCmd = 'sh';
        launchArgs = ['run.sh', 'nogui'];
        broadcast(`[Absora Cloud] Modern Modded Engine detected. Executing launch script...\n`);
    } else {
        launchArgs = [
            `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
            '-jar', 'server.jar', 'nogui'
        ];
        broadcast(`[Absora Cloud] Standard Engine detected. Booting with ${assignedRam} allocation...\n`);
    }

    mcServer = spawn(launchCmd, launchArgs);
    mcServer.stdout.on('data', (data) => { process.stdout.write(data); broadcast(data.toString()); });
    mcServer.stderr.on('data', (data) => { process.stderr.write(data); broadcast(data.toString()); });
    mcServer.on('close', (code) => {
        broadcast("\n[Absora Cloud] Engine container shutting down. Syncing volumes...");
        process.exit(0); 
    });
}
startMinecraft();
