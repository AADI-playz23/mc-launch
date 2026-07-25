"""
Checks ALL download URLs across all software catalogs in api/_data/.
Reports which ones are broken (HTTP errors) and which are working.
"""

import json
import os
import urllib.request
import ssl
import sys

# Skip SSL verification for speed (just checking HTTP status)
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

DATA_DIR = os.path.join("api", "_data")

def check_url(url, timeout=10):
    """Returns (status_code, ok) by doing a HEAD request, falling back to GET."""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "AbsoraCloud-Checker/1.0"})
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return resp.status, True
    except urllib.error.HTTPError as e:
        return e.code, False
    except Exception as e:
        # Try GET as fallback (some servers don't support HEAD)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AbsoraCloud-Checker/1.0", "Range": "bytes=0-0"})
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                return resp.status, True
        except urllib.error.HTTPError as e2:
            return e2.code, False
        except Exception as e2:
            return str(e2)[:50], False

def main():
    json_files = sorted([f for f in os.listdir(DATA_DIR) if f.endswith(".json")])
    
    total_urls = 0
    total_ok = 0
    total_broken = 0
    broken_list = []
    
    for filename in json_files:
        filepath = os.path.join(DATA_DIR, filename)
        with open(filepath, "r") as f:
            data = json.load(f)
        
        # Collect all URLs from the JSON (handle both flat and nested "versions" format)
        urls = {}
        if "versions" in data and isinstance(data["versions"], dict):
            urls = data["versions"]
        else:
            urls = {k: v for k, v in data.items() if isinstance(v, str) and v.startswith("http")}
        
        if not urls:
            continue
            
        print(f"\n{'='*60}")
        print(f"  {filename} ({len(urls)} URLs)")
        print(f"{'='*60}")
        
        for name, url in urls.items():
            sys.stdout.write(f"  {name}... ")
            sys.stdout.flush()
            
            status, ok = check_url(url)
            total_urls += 1
            
            if ok:
                print(f"OK ({status})")
                total_ok += 1
            else:
                print(f"BROKEN ({status})")
                total_broken += 1
                broken_list.append((filename, name, url, status))
    
    # Summary
    print(f"\n{'='*60}")
    print(f"  SUMMARY")
    print(f"{'='*60}")
    print(f"  Total URLs checked: {total_urls}")
    print(f"  Working: {total_ok}")
    print(f"  Broken:  {total_broken}")
    
    if broken_list:
        print(f"\n  BROKEN URLs:")
        for filename, name, url, status in broken_list:
            print(f"    [{filename}] {name}")
            print(f"      URL: {url}")
            print(f"      Status: {status}")
    else:
        print(f"\n  All URLs are working!")

if __name__ == "__main__":
    main()
