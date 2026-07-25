"""
Updates paper.json with working download URLs from the new PaperMC Fill v3 API.
The old api.papermc.io/v2 was sunset on July 1, 2026 and returns 410 Gone.
The new API is fill.papermc.io/v3.
"""

import json
import urllib.request
import time
import sys
import os

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud-Updater/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

def get_latest_build_url(version):
    try:
        builds = fetch_json(f"https://fill.papermc.io/v3/projects/paper/versions/{version}/builds")
        # Find latest STABLE build, fallback to any
        stable = [b for b in builds if b.get("channel") == "STABLE"]
        best = stable[0] if stable else (builds[0] if builds else None)
        
        if best and "downloads" in best and "server:default" in best["downloads"]:
            return best["downloads"]["server:default"]["url"]
        return None
    except Exception as e:
        print(f"  FAIL Failed for {version}: {e}")
        return None

def main():
    json_path = os.path.join("api", "_data", "paper.json")
    
    with open(json_path, "r") as f:
        existing = json.load(f)
    
    versions = list(existing["versions"].keys())
    print(f"Updating {len(versions)} versions from Fill v3 API...\n")
    
    new_versions = {}
    updated = 0
    failed = 0
    
    for ver in versions:
        sys.stdout.write(f"  {ver}... ")
        sys.stdout.flush()
        
        url = get_latest_build_url(ver)
        if url:
            new_versions[ver] = url
            print(f"OK {url.split('/')[-1]}")
            updated += 1
        else:
            new_versions[ver] = existing["versions"][ver]
            print("FAIL KEPT OLD URL")
            failed += 1
        
        time.sleep(0.2)
    
    # Get latest version
    latest_version = existing.get("latest", "1.21.11")
    try:
        project = fetch_json("https://fill.papermc.io/v3/projects/paper")
        if "versions" in project and "1.21" in project["versions"]:
            latest_version = project["versions"]["1.21"][0]
    except Exception as e:
        print(f"Could not fetch latest version: {e}")
    
    result = {"latest": latest_version, "versions": new_versions}
    
    with open(json_path, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    
    print(f"\nDone! Updated {updated}/{len(versions)} versions. {failed} failed.")
    print(f"Latest version: {latest_version}")

if __name__ == "__main__":
    main()
