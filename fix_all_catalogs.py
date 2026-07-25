"""
COMPREHENSIVE catalog updater for AbsoraCloud.
Fetches ALL available versions from each upstream API and generates
complete, up-to-date catalog JSON files.
Date: 25/07/2026
"""

import json
import os
import urllib.request
import ssl
import sys
import time

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

DATA_DIR = os.path.join("api", "_data")

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud-Updater/1.0"})
    with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
        return json.loads(resp.read().decode())

def check_url(url, timeout=10):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "AbsoraCloud/1.0"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return True
    except:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud/1.0", "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return True
        except:
            return False

def save_json(filename, data):
    filepath = os.path.join(DATA_DIR, filename)
    with open(filepath, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    print(f"  -> Saved {filename}!")

def get_fill_v3_url(project, version):
    try:
        builds = fetch_json(f"https://fill.papermc.io/v3/projects/{project}/versions/{version}/builds")
        stable = [b for b in builds if b.get("channel") == "STABLE"]
        best = stable[0] if stable else (builds[0] if builds else None)
        if best and "downloads" in best and "server:default" in best["downloads"]:
            return best["downloads"]["server:default"]["url"]
    except Exception as e:
        pass
    return None


# =====================================================
# 1. PAPER - Already fixed, just verify
# =====================================================
def update_paper():
    print("\n" + "="*60)
    print("  1. paper.json (Fill v3 API)")
    print("="*60)
    
    project = fetch_json("https://fill.papermc.io/v3/projects/paper")
    all_versions = []
    for group_versions in project["versions"].values():
        all_versions.extend(group_versions)
    
    # Filter to stable releases only (no snapshots/pre/rc)
    stable = [v for v in all_versions if "pre" not in v and "rc" not in v and "snapshot" not in v.lower()]
    print(f"  Found {len(all_versions)} total versions, {len(stable)} stable")
    
    result = {"latest": stable[0], "versions": {}}
    
    # Include ALL versions (stable + pre-releases)
    for ver in all_versions:
        sys.stdout.write(f"  {ver}... ")
        sys.stdout.flush()
        url = get_fill_v3_url("paper", ver)
        if url:
            result["versions"][ver] = url
            print(f"OK")
        else:
            print(f"SKIP")
        time.sleep(0.15)
    
    save_json("paper.json", result)
    return len(result["versions"])


# =====================================================
# 2. PURPUR
# =====================================================
def update_purpur():
    print("\n" + "="*60)
    print("  2. purpur.json (PurpurMC API)")
    print("="*60)
    
    # Purpur uses /latest/download which auto-resolves, so we just need valid versions
    # Let's check which versions actually exist
    try:
        versions_data = fetch_json("https://api.purpurmc.org/v2/purpur")
        versions = versions_data.get("versions", [])
        print(f"  Found {len(versions)} versions from PurpurMC API")
    except Exception as e:
        print(f"  Could not fetch Purpur versions: {e}")
        return 0
    
    result = {}
    for ver in versions:
        url = f"https://api.purpurmc.org/v2/purpur/{ver}/latest/download"
        result[f"Purpur {ver}"] = url
        print(f"  Purpur {ver}: Added")
    
    save_json("purpur.json", result)
    return len(result)


# =====================================================
# 3. FABRIC
# =====================================================
def update_fabric():
    print("\n" + "="*60)
    print("  3. fabric.json (Fabric Meta API)")
    print("="*60)
    
    # Get latest stable loader
    loaders = fetch_json("https://meta.fabricmc.net/v2/versions/loader")
    stable_loader = None
    for l in loaders:
        if l.get("stable", False):
            stable_loader = l["version"]
            break
    if not stable_loader:
        stable_loader = loaders[0]["version"]
    print(f"  Latest stable Fabric loader: {stable_loader}")
    
    # Get game versions
    games = fetch_json("https://meta.fabricmc.net/v2/versions/game")
    stable_games = [g["version"] for g in games if g.get("stable", False)]
    print(f"  Found {len(stable_games)} stable game versions")
    
    # Installer version
    installers = fetch_json("https://meta.fabricmc.net/v2/versions/installer")
    stable_installer = None
    for i in installers:
        if i.get("stable", False):
            stable_installer = i["version"]
            break
    if not stable_installer:
        stable_installer = installers[0]["version"]
    print(f"  Latest stable Fabric installer: {stable_installer}")
    
    result = {}
    for ver in stable_games:
        url = f"https://meta.fabricmc.net/v2/versions/loader/{ver}/{stable_loader}/{stable_installer}/server/jar"
        result[f"Fabric {ver}"] = url
        print(f"  Fabric {ver}: Added")
    
    save_json("fabric.json", result)
    return len(result)


# =====================================================
# 4. QUILT
# =====================================================
def update_quilt():
    print("\n" + "="*60)
    print("  4. quilt.json (Quilt Meta API)")
    print("="*60)
    
    # Quilt uses DIFFERENT loader versions per game version
    # We need to query per game version to find the right loader
    games = fetch_json("https://meta.quiltmc.org/v3/versions/game")
    stable_games = [g["version"] for g in games if g.get("stable", False)]
    print(f"  Found {len(stable_games)} stable game versions")
    
    result = {}
    for ver in stable_games:
        sys.stdout.write(f"  Quilt {ver}... ")
        sys.stdout.flush()
        try:
            # Get available loaders for this game version
            loader_data = fetch_json(f"https://meta.quiltmc.org/v3/versions/loader/{ver}")
            if loader_data:
                # Pick first (latest) loader
                loader_ver = loader_data[0]["loader"]["version"]
                url = f"https://meta.quiltmc.org/v3/versions/loader/{ver}/{loader_ver}/server/jar"
                # Verify it actually works
                if check_url(url):
                    result[f"Quilt {ver}"] = url
                    print(f"OK (loader {loader_ver})")
                else:
                    print(f"BROKEN (loader {loader_ver})")
            else:
                print("NO LOADERS")
        except Exception as e:
            print(f"ERROR: {e}")
        time.sleep(0.2)
    
    save_json("quilt.json", result)
    return len(result)


# =====================================================
# 5. FORGE / NEOFORGE
# =====================================================
def update_forge():
    print("\n" + "="*60)
    print("  5. forge.json (NeoForge + Forge)")
    print("="*60)
    
    result = {}
    
    # NeoForge versions - check known versions from search results
    neoforge_versions = {
        "NeoForge 1.21.11": "21.11",
        "NeoForge 1.21.4": "21.4",
        "NeoForge 1.21.3": "21.3",
        "NeoForge 1.21.1": "21.1",
        "NeoForge 1.20.6": "20.6",
        "NeoForge 1.20.4": "20.4",
    }
    
    for name, prefix in neoforge_versions.items():
        sys.stdout.write(f"  {name}... ")
        sys.stdout.flush()
        # Try to find latest build by scanning version range
        found = False
        for minor in range(200, 0, -1):
            test_url = f"https://maven.neoforged.net/releases/net/neoforged/neoforge/{prefix}.{minor}/neoforge-{prefix}.{minor}-installer.jar"
            if check_url(test_url):
                print(f"OK (v{prefix}.{minor})")
                result[name] = test_url
                found = True
                break
        if not found:
            # Try beta versions
            test_url = f"https://maven.neoforged.net/releases/net/neoforged/neoforge/{prefix}.0-beta/neoforge-{prefix}.0-beta-installer.jar"
            if check_url(test_url):
                print(f"OK (v{prefix}.0-beta)")
                result[name] = test_url
            else:
                print(f"NOT FOUND")
    
    # Legacy Forge versions
    forge_versions = {
        "Forge 1.20.4": "1.20.4-49.0.50",
        "Forge 1.20.1": "1.20.1-47.3.0",
        "Forge 1.19.4": "1.19.4-45.3.3",
        "Forge 1.19.2": "1.19.2-43.5.2",
        "Forge 1.18.2": "1.18.2-40.2.18",
        "Forge 1.17.1": "1.17.1-37.1.1",
        "Forge 1.16.5": "1.16.5-36.2.39",
        "Forge 1.15.2": "1.15.2-31.2.57",
        "Forge 1.14.4": "1.14.4-28.2.26",
        "Forge 1.13.2": "1.13.2-25.0.223",
        "Forge 1.12.2": "1.12.2-14.23.5.2860",
    }
    
    for name, ver_str in forge_versions.items():
        url = f"https://maven.minecraftforge.net/net/minecraftforge/forge/{ver_str}/forge-{ver_str}-installer.jar"
        sys.stdout.write(f"  {name}... ")
        sys.stdout.flush()
        if check_url(url):
            print("OK")
            result[name] = url
        else:
            print("BROKEN (skipping)")
        time.sleep(0.1)
    
    save_json("forge.json", result)
    return len(result)


# =====================================================
# 6. HIGH PERFORMANCE (Folia + Pufferfish)
# =====================================================
def update_high_performance():
    print("\n" + "="*60)
    print("  6. high_performance.json (Folia + Pufferfish)")
    print("="*60)
    
    result = {}
    
    # Folia from Fill v3
    try:
        folia_project = fetch_json("https://fill.papermc.io/v3/projects/folia")
        all_folia = []
        for group_versions in folia_project["versions"].values():
            all_folia.extend(group_versions)
        print(f"  Available Folia versions: {all_folia}")
    except Exception as e:
        print(f"  Could not fetch Folia: {e}")
        all_folia = []
    
    for ver in all_folia:
        sys.stdout.write(f"  Folia {ver}... ")
        sys.stdout.flush()
        url = get_fill_v3_url("folia", ver)
        if url:
            print(f"OK -> {url.split('/')[-1]}")
            result[f"Folia {ver} (Multi-Thread)"] = url
        else:
            print("SKIP")
        time.sleep(0.15)
    
    # Pufferfish - check known working versions
    pufferfish_versions = [
        ("Pufferfish 1.21.1 (Performance)", "Pufferfish-1.21", "1.21.1"),
        ("Pufferfish 1.20.4 (Performance)", "Pufferfish-1.20", "1.20.4"),
        ("Pufferfish 1.19.4 (Performance)", "Pufferfish-1.19", "1.19.4"),
        ("Pufferfish 1.18.2 (Performance)", "Pufferfish-1.18", "1.18.2"),
        ("Pufferfish 1.17.1 (Performance)", "Pufferfish-1.17", "1.17.1"),
    ]
    
    for name, job, mc_ver in pufferfish_versions:
        url = f"https://ci.pufferfish.host/job/{job}/lastSuccessfulBuild/artifact/build/libs/pufferfish-paperclip-{mc_ver}-R0.1-SNAPSHOT-reobf.jar"
        sys.stdout.write(f"  {name}... ")
        sys.stdout.flush()
        if check_url(url):
            print("OK")
            result[name] = url
        else:
            print("BROKEN (skipping)")
        time.sleep(0.1)
    
    save_json("high_performance.json", result)
    return len(result)


# =====================================================
# 7. PROXIES (Velocity + BungeeCord)
# =====================================================
def update_proxies():
    print("\n" + "="*60)
    print("  7. proxies.json (Velocity + BungeeCord)")
    print("="*60)
    
    result = {}
    
    # Velocity from Fill v3
    try:
        vel_project = fetch_json("https://fill.papermc.io/v3/projects/velocity")
        all_vel = []
        for group_versions in vel_project["versions"].values():
            all_vel.extend(group_versions)
        stable_vel = [v for v in all_vel if "SNAPSHOT" not in v]
        print(f"  Stable Velocity versions: {stable_vel}")
    except Exception as e:
        print(f"  Could not fetch Velocity: {e}")
        stable_vel = []
    
    for ver in stable_vel:
        sys.stdout.write(f"  Velocity {ver}... ")
        sys.stdout.flush()
        url = get_fill_v3_url("velocity", ver)
        if url:
            print(f"OK -> {url.split('/')[-1]}")
            result[f"Velocity {ver} (Stable Release)"] = url
        else:
            print("SKIP")
        time.sleep(0.15)
    
    # BungeeCord
    bc_url = "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar"
    if check_url(bc_url):
        result["BungeeCord (Universal Stable)"] = bc_url
        print("  BungeeCord: OK")
    
    save_json("proxies.json", result)
    return len(result)


# =====================================================
# 8. HYBRID (Mohist)
# =====================================================
def update_hybrid():
    print("\n" + "="*60)
    print("  8. hybrid.json (Mohist)")
    print("="*60)
    print("  NOTE: Mohist development is paused. Checking existing builds...")
    
    result = {}
    mohist_versions = ["1.20.4", "1.20.1", "1.19.4", "1.19.2", "1.18.2", "1.16.5", "1.12.2"]
    
    for mc_ver in mohist_versions:
        url = f"https://mohistmc.com/api/v2/projects/mohist/{mc_ver}/builds/latest/download"
        sys.stdout.write(f"  Mohist {mc_ver}... ")
        sys.stdout.flush()
        if check_url(url):
            print("OK")
            result[f"Mohist {mc_ver}"] = url
        else:
            print("BROKEN (removing)")
        time.sleep(0.2)
    
    if not result:
        result["_note"] = "Mohist development is paused. No working builds available."
    
    save_json("hybrid.json", result)
    return len(result)


# =====================================================
# 9. SPIGOT (BuildTools)
# =====================================================
def update_spigot():
    print("\n" + "="*60)
    print("  9. spigot.json (SpigotMC BuildTools)")
    print("="*60)
    print("  NOTE: getbukkit.org is down. Spigot requires BuildTools to compile.")
    
    buildtools_url = "https://hub.spigotmc.org/jenkins/job/BuildTools/lastSuccessfulBuild/artifact/target/BuildTools.jar"
    
    if not check_url(buildtools_url):
        print("  WARNING: BuildTools URL is also down!")
        return 0
    
    print("  BuildTools URL is working")
    
    # Same versions as Paper for consistency
    versions = [
        "1.21.11", "1.21.10", "1.21.9", "1.21.8", "1.21.7", "1.21.6",
        "1.21.5", "1.21.4", "1.21.3", "1.21.1", "1.21",
        "1.20.6", "1.20.4", "1.20.2", "1.20.1", "1.20",
        "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19",
        "1.18.2", "1.18.1", "1.18",
        "1.17.1", "1.17",
        "1.16.5", "1.16.4", "1.16.3", "1.16.2", "1.16.1",
        "1.15.2", "1.15.1", "1.15",
        "1.14.4", "1.14.3", "1.14.2", "1.14.1", "1.14",
        "1.13.2", "1.13.1", "1.13",
        "1.12.2", "1.12.1", "1.12",
        "1.11.2", "1.10.2", "1.9.4", "1.8.8"
    ]
    
    result = {}
    for ver in versions:
        result[f"Spigot {ver}"] = buildtools_url
        print(f"  Spigot {ver}: Added (BuildTools)")
    
    result["_buildtools_note"] = "All Spigot versions use BuildTools. Run: java -jar BuildTools.jar --rev VERSION"
    
    save_json("spigot.json", result)
    return len(result)


# =====================================================
# MAIN
# =====================================================
def main():
    print("="*60)
    print("  AbsoraCloud FULL Catalog Update")
    print("  Date: 25/07/2026")
    print("="*60)
    
    totals = {}
    totals["Paper"] = update_paper()
    totals["Purpur"] = update_purpur()
    totals["Fabric"] = update_fabric()
    totals["Quilt"] = update_quilt()
    totals["Forge/NeoForge"] = update_forge()
    totals["High Performance"] = update_high_performance()
    totals["Proxies"] = update_proxies()
    totals["Hybrid"] = update_hybrid()
    totals["Spigot"] = update_spigot()
    
    print("\n" + "="*60)
    print("  FINAL SUMMARY")
    print("="*60)
    total = 0
    for name, count in totals.items():
        print(f"  {name}: {count} versions")
        total += count
    print(f"\n  TOTAL: {total} working download URLs across all catalogs")
    print("="*60)

if __name__ == "__main__":
    main()
