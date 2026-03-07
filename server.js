const { spawn } = require('child_process');
const WebSocket = require('ws');
const os = require('os'); 

const username = process.argv[2] || 'Pilot';
const assignedRam = process.argv[3] || '4G';
const wss = new WebSocket.Server({ port: 8080 });

let activeClients = [];
const MAX_LOG_HISTORY = 50; 
let logHistory = [];
let mcServer;
let intentionalStop = false;

setInterval(() => {
    if (activeClients.length > 0) {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const ramPercent = ((usedMem / totalMem) * 100).toFixed(1);
        const ramString = `${(usedMem / 1024 / 1024 / 1024).toFixed(2)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(2)}GB`;

        const cpus = os.cpus().length;
        const cpuLoad = ((os.loadavg()[0] / cpus) * 100).toFixed(1);
        const cpuPercent = Math.min(cpuLoad, 100); 
        const cpuString = `${cpuPercent}%`;

        const statsPayload = JSON.stringify({
            type: 'stats',
            ram: ramString,
            ramPercent: ramPercent,
            cpu: cpuString,
            cpuPercent: cpuPercent
        });

        activeClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(statsPayload);
            }
        });
    }
}, 3000);

wss.on('connection', (ws) => {
    activeClients.push(ws);
    console.log("[Absora] Web Dashboard connected to telemetry stream.");

    if (logHistory.length > 0) {
        ws.send(JSON.stringify({ text: logHistory.join('') }));
    }

    ws.on('error', () => {});

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'command' && mcServer) {
                const cmd = data.command.trim().toLowerCase();
                
                if (cmd === 'stop') {
                    intentionalStop = true; 
                } else if (cmd === 'restart') {
                    intentionalStop = false; 
                    mcServer.stdin.write("stop\n"); 
                    return;
                }
                
                mcServer.stdin.write(data.command + "\n");
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        activeClients = activeClients.filter(client => client !== ws);
    });
});

const broadcast = (text) => {
    logHistory.push(text);
    if (logHistory.length > MAX_LOG_HISTORY) logHistory.shift(); 

    activeClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ text: text }));
        }
    });
};

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

    mcServer.stdout.on('data', (data) => {
        process.stdout.write(data);
        broadcast(data.toString());
    });

    mcServer.stderr.on('data', (data) => {
        process.stderr.write(data);
        broadcast(data.toString());
    });

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
