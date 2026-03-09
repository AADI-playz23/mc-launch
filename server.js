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
const MAX_LOG_HISTORY = 100; 
let logHistory = [];
let mcServer;
let isRestarting = false; // The magic flag

const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); 
    activeClients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ text: text })); } });
};

const MAX_RUNTIME_MINUTES = 345; 
let elapsedMinutes = 0;

setInterval(() => {
    elapsedMinutes++;
    if (elapsedMinutes >= MAX_RUNTIME_MINUTES) {
        broadcast("\n[Absora Engine] Max lifespan reached. Initiating automated relay transfer...\n");
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
        const cpuPercentNum = Math.min(((os.loadavg()[0] / os.cpus().length) * 100), 100).toFixed(1);
        activeClients.forEach(ws => { 
            if (ws.readyState === WebSocket.OPEN) { 
                ws.send(JSON.stringify({ type: 'stats', ram: `${displayUsedGB.toFixed(2)}GB / ${planTotalGB.toFixed(2)}GB`, ramPercent: ramPercent, cpu: `${cpuPercentNum}% (${planCores} vCPU)`, cpuPercent: cpuPercentNum })); 
            } 
        });
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
                
                // --- THE RESTART FIX ---
                if (cmd === 'restart') {
                    isRestarting = true;
                    broadcast("\n[Absora Engine] Soft Reboot requested. Saving world data...\n");
                    mcServer.stdin.write("save-all\n");
                    
                    // Wait 2 seconds for chunks to save before stopping
                    setTimeout(() => {
                        mcServer.stdin.write("stop\n");
                    }, 2000);
                    return; 
                }
                
                if (cmd === 'stop') {
                    isRestarting = false; // Ensure runner dies on normal stop
                    broadcast("\n[Absora Engine] Manual shutdown initiated...\n");
                    mcServer.stdin.write("stop\n");
                    return;
                }

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
    } else {
        launchArgs = [
            `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
            '-jar', 'server.jar', 'nogui'
        ];
    }

    broadcast(`\n[Absora Engine] Booting JVM Framework...\n`);
    mcServer = spawn(launchCmd, launchArgs);
    
    mcServer.stdout.on('data', (data) => { process.stdout.write(data); broadcast(data.toString()); });
    mcServer.stderr.on('data', (data) => { process.stderr.write(data); broadcast(data.toString()); });
    
    mcServer.on('close', (code) => {
        if (isRestarting) {
            broadcast("\n[Absora Engine] JVM offline. Purging cache and waiting for port 25565 to free (8 seconds)...\n");
            isRestarting = false; // Reset flag so it doesn't loop infinitely
            
            // Wait 8 full seconds so Linux releases the TIME_WAIT port
            setTimeout(startMinecraft, 8000); 
        } else {
            broadcast("\n[Absora Engine] Container shutting down. Syncing volumes to Cloud...\n");
            process.exit(0); // Normal stop, kill runner
        }
    });
}

// Initial Boot
startMinecraft();
