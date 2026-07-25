/**
 * Updates paper.json with working download URLs from the new PaperMC Fill v3 API.
 * The old api.papermc.io/v2 was sunset on July 1, 2026 and returns 410 Gone.
 * The new API is fill.papermc.io/v3.
 */

const fs = require('fs');
const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function getLatestBuildUrl(version) {
  try {
    const raw = await fetch(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds`);
    const builds = JSON.parse(raw);
    
    // Find the latest STABLE build, falling back to any build
    const stableBuilds = builds.filter(b => b.channel === 'STABLE');
    const best = stableBuilds.length > 0 ? stableBuilds[0] : builds[0];
    
    if (best && best.downloads && best.downloads['server:default']) {
      return best.downloads['server:default'].url;
    }
    return null;
  } catch (e) {
    console.error(`  ✗ Failed for ${version}: ${e.message}`);
    return null;
  }
}

async function main() {
  // Read existing paper.json
  const existing = JSON.parse(fs.readFileSync('api/_data/paper.json', 'utf8'));
  const versions = Object.keys(existing.versions);
  
  console.log(`Updating ${versions.length} versions from Fill v3 API...\n`);
  
  const newVersions = {};
  let updated = 0;
  let failed = 0;
  
  for (const ver of versions) {
    process.stdout.write(`  ${ver}... `);
    const url = await getLatestBuildUrl(ver);
    if (url) {
      newVersions[ver] = url;
      console.log(`✓ ${url.split('/').pop()}`);
      updated++;
    } else {
      // Keep old URL as fallback
      newVersions[ver] = existing.versions[ver];
      console.log(`✗ KEPT OLD URL`);
      failed++;
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  
  // Also get latest version from the API
  let latestVersion = existing.latest;
  try {
    const projectRaw = await fetch('https://fill.papermc.io/v3/projects/paper');
    const project = JSON.parse(projectRaw);
    // Get the latest stable version from 1.21 group
    if (project.versions && project.versions['1.21']) {
      latestVersion = project.versions['1.21'][0]; // First is the latest
    }
  } catch (e) {
    console.log(`Could not fetch latest version: ${e.message}`);
  }
  
  const result = {
    latest: latestVersion,
    versions: newVersions
  };
  
  fs.writeFileSync('api/_data/paper.json', JSON.stringify(result, null, 2) + '\n');
  
  console.log(`\nDone! Updated ${updated}/${versions.length} versions. ${failed} failed.`);
  console.log(`Latest version: ${latestVersion}`);
}

main().catch(console.error);
