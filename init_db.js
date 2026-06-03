import fs from 'fs';

const envRaw = fs.readFileSync('.env', 'utf-8');
envRaw.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim().replace(/^"|"$/g, '');
});
import handler from './api/setup_db.js';

const req = {};
const res = {
  status: (code) => {
    return {
      json: (data) => {
        console.log(`Status: ${code}`);
        console.log(data);
      }
    }
  }
};

console.log("Initializing Cloudflare D1 schema...");
await handler(req, res);
