// wrapper.js (Inside mc-launch)
const { spawn } = require('child_process');
const WebSocket = require('ws');

const username = process.argv[2];

// Connect securely through Cloudflare Edge
const ws = new WebSocket('wss://console.absoracloud.com:8080'); 

ws.on('open', () => {
    console.log("Connected to Cloudflare secure console relay.");
    
    const mcServer = spawn('java', ['-Xmx6G', '-Xms6G', '-jar', 'server.jar', 'nogui']);

    // Stream logs to Cloudflare
    mcServer.stdout.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'log', username: username, text: data.toString() }));
    });

    mcServer.stderr.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'log', username: username, text: data.toString() }));
    });
});
