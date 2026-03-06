// server.js (Inside AADI-playz23/mc-launch)
const { spawn } = require('child_process');
const WebSocket = require('ws');

const username = process.argv[2] || 'Pilot';

// 1. Open a local WebSocket server on port 8080
const wss = new WebSocket.Server({ port: 8080 });
let activeClients = [];

wss.on('connection', (ws) => {
    activeClients.push(ws);
    console.log("[LunarHost] Web Dashboard connected to telemetry stream.");

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'command' && mcServer) {
                mcServer.stdin.write(data.command + "\n");
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        activeClients = activeClients.filter(client => client !== ws);
    });
});

const broadcast = (text) => {
    activeClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ text: text }));
        }
    });
};

// 2. Start the Minecraft Server with Aikar's Flags
const mcServer = spawn('java', [
    '-Xms6G', '-Xmx6G',
    '-XX:+AlwaysPreTouch', '-XX:+DisableExplicitGC', '-XX:+ParallelRefProcEnabled',
    '-XX:+PerfDisableSharedMem', '-XX:+UnlockExperimentalVMOptions', '-XX:+UseG1GC',
    '-XX:G1HeapRegionSize=8M', '-XX:G1HeapWastePercent=5', '-XX:G1MaxNewSizePercent=40',
    '-XX:G1MixedGCCountTarget=4', '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1NewSizePercent=30', '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15',
    '-XX:MaxGCPauseMillis=200', '-XX:MaxTenuringThreshold=1', '-XX:SurvivorRatio=32',
    '-jar', 'server.jar', 'nogui'
]);

// 3. Pipe logs to GitHub Actions console AND the Web Dashboard
mcServer.stdout.on('data', (data) => {
    process.stdout.write(data);
    broadcast(data.toString());
});

mcServer.stderr.on('data', (data) => {
    process.stderr.write(data);
    broadcast(data.toString());
});
