"""
Updates hybrid.json with Arclight (Forge/NeoForge/Fabric hybrid) and Mohist builds,
then verifies all URLs.
"""

import json
import urllib.request
import ssl
import sys
import os

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

DATA_PATH = os.path.join("api", "_data", "hybrid.json")

def check_url(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "AbsoraCloud/1.0"})
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
            return resp.status < 400
    except:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud/1.0", "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                return resp.status < 400
        except:
            return False

def get_arclight_builds():
    url = "https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=20"
    arclight_map = {}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud/1.0"})
        with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
            releases = json.loads(resp.read().decode())
            for rel in releases:
                for asset in rel.get("assets", []):
                    name = asset.get("name", "")
                    download_url = asset.get("browser_download_url", "")
                    if name.endswith(".jar") and "arclight" in name:
                        # Extract software label e.g. arclight-forge-1.20.1-1.0.6.jar -> Arclight Forge 1.20.1
                        # arclight-neoforge-1.21.1-... -> Arclight NeoForge 1.21.1
                        # arclight-fabric-1.21.1-... -> Arclight Fabric 1.21.1
                        parts = name.split("-")
                        if len(parts) >= 3:
                            loader = parts[1].capitalize()
                            ver = parts[2]
                            label = f"Arclight ({loader}) {ver}"
                            if label not in arclight_map:
                                arclight_map[label] = download_url
    except Exception as e:
        print(f"Error fetching Arclight releases: {e}")
    return arclight_map

def main():
    print("=== Updating hybrid.json with Arclight + Mohist ===")
    
    # Load current hybrid.json
    current = {}
    if os.path.exists(DATA_PATH):
        with open(DATA_PATH, 'r') as f:
            current = json.load(f)

    # Fetch Arclight builds
    arclight = get_arclight_builds()
    print(f"Found {len(arclight)} Arclight versions from GitHub.")

    combined = {}
    # First put Arclight entries
    for k, v in arclight.items():
        combined[k] = v

    # Add Mohist entries from current if working
    mohist_vers = ["1.20.1", "1.19.4", "1.19.2", "1.18.2", "1.16.5", "1.12.2"]
    for mver in mohist_vers:
        murl = f"https://mohistmc.com/api/v2/projects/mohist/{mver}/builds/latest/download"
        combined[f"Mohist {mver}"] = murl

    # Verify all combined links
    final_hybrid = {}
    print("\n--- Verifying all Hybrid links ---")
    for name, url in combined.items():
        sys.stdout.write(f"Checking {name}... ")
        sys.stdout.flush()
        if check_url(url):
            print("OK")
            final_hybrid[name] = url
        else:
            print("BROKEN (skipping)")

    with open(DATA_PATH, 'w') as f:
        json.dump(final_hybrid, f, indent=2)
        f.write("\n")

    print(f"\nSaved hybrid.json with {len(final_hybrid)} verified working entries!")

if __name__ == "__main__":
    main()
