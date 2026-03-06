const { spawn } = require('child_process');
const { Octokit } = require("@octokit/rest");

const username = process.argv[2]; 
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = "Absora-Studio"; 
const repoB = "mc-disk"; 

console.log(`Starting Bore tunnel for ${username}...`);
const bore = spawn('bore', ['local', '25565', '--to', 'bore.pub']);

bore.stdout.on('data', async (data) => {
    const match = data.toString().match(/listening at (.*):(\d+)/);
    if (match) {
        const ipAddress = `${match[1]}:${match[2]}`;
        console.log(`Tunnel established: ${ipAddress}`);
        
        try {
            const path = `ip/${username}.txt`;
            let fileSha;
            try {
                const { data: fileData } = await octokit.rest.repos.getContent({ owner, repo: repoB, path });
                fileSha = fileData.sha;
            } catch (err) {}

            await octokit.rest.repos.createOrUpdateFileContents({
                owner, repo: repoB, path,
                message: `AbsoraCloud: Update IP for ${username}`,
                content: Buffer.from(ipAddress).toString('base64'),
                sha: fileSha
            });
        } catch (error) { console.error("Error pushing IP:", error); }
    }
});
