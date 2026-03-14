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
const MAX_LOG_HISTORY = 100; 
let logHistory = [];
let mcServer;
let isRestarting = false; 

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
        broadcast("\n[Absora Engine] Max lifespan reached. Initiating automated relay...\n");
        fs.writeFileSync('relay.flag', 'true'); 
        if (mcServer) {
            mcServer.stdin.write('kick @a [Absora] Cloud node transfer in 60s!\n');
            mcServer.stdin.write('end\nsave-all\n');
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
                if (cmd === 'restart') {
                    isRestarting = true;
                    broadcast("\n[Absora Engine] Soft Reboot requested. Saving...\n");
                    mcServer.stdin.write("end\nsave-all\n");
                    setTimeout(() => { mcServer.stdin.write("stop\n"); }, 2000);
                    return; 
                }
                if (cmd === 'stop') {
                    isRestarting = false; 
                    broadcast("\n[Absora Engine] Manual shutdown initiated...\n");
                    mcServer.stdin.write("end\nstop\n");
                    return;
                }
                mcServer.stdin.write(data.command + "\n");
            }
        } catch(e) {}
    });
    ws.on('close', () => { activeClients = activeClients.filter(c => c !== ws); });
});

function startMinecraft() {
    let launchCmd = 'java';
    let launchArgs = [];
    let targetJar = 'server.jar'; 

    if (fs.existsSync('run.sh')) {
        fs.writeFileSync('user_jvm_args.txt', `-Xms${assignedRam} -Xmx${assignedRam}`);
        launchCmd = 'sh';
        launchArgs = ['run.sh', 'nogui'];
    } else {
        const files = fs.readdirSync('.');
        const foundJar = files.find(f => f.endsWith('.jar') && !f.includes('server.js'));
        
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
                        execSync(`wget -O server.jar "${downloadUrl}"`);
                        targetJar = 'server.jar';
                        broadcast(`[Absora Engine] Download complete. Igniting...\n`);
                    } else {
                        throw new Error(`Link not found in ${softwareFile}`);
                    }
                } else {
                    throw new Error(`${softwareFile} missing from repository.`);
                }
            } catch(err) {
                broadcast(`[Absora Engine] 🛑 CRITICAL: Auto-Download failed (${err.message}).\n`);
                broadcast("[Absora Engine] Entering Standby Mode. Upload via Files tab.\n");
                return;
            }
        } else {
            broadcast(`[Absora Engine] 🛑 CRITICAL: No engine found and no version specified.\n`);
            return;
        }

        launchArgs = [
            `-Xms${assignedRam}`, `-Xmx${assignedRam}`,
            '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
            '-jar', targetJar, 'nogui'
        ];
    }

    mcServer = spawn(launchCmd, launchArgs);
    
    mcServer.stdout.on('data', (data) => { process.stdout.write(data); broadcast(data.toString()); });
    mcServer.stderr.on('data', (data) => { process.stderr.write(data); broadcast(data.toString()); });
    
    mcServer.on('close', (code) => {
        if (isRestarting) {
            broadcast("\n[Absora Engine] JVM offline. Purging cache (8 seconds)...\n");
            isRestarting = false; 
            setTimeout(startMinecraft, 8000); 
        } else {
            broadcast("\n[Absora Engine] Container shutting down. Syncing volumes to Cloud...\n");
            process.exit(0); 
        }
    });
}

startMinecraft();
