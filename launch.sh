#!/bin/bash
TARGET_USER=$USERNAME
DISK_DIR="mc-disk"

echo "=== LunarHost Boot Sequence ==="
sudo apt-get update -qq && sudo apt-get install -y jq tmux wget > /dev/null 2>&1

# 1. Start Tunnel
wget -q https://github.com/ekzhang/bore/releases/download/v0.4.1/bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
tar -xzf bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
chmod +x bore
./bore local 25565 --to bore.network > bore.log 2>&1 &
sleep 5 
PORT=$(grep -oP 'listening at bore.network:\K\d+' bore.log | head -n 1)

# 2. Update Database
cd $DISK_DIR
jq ".\"$TARGET_USER\".current_ip = \"bore.network:$PORT\"" users.json > tmp.json && mv tmp.json users.json
jq ".\"$TARGET_USER\".software = \"$SOFTWARE\"" users.json > tmp.json && mv tmp.json users.json
jq ".\"$TARGET_USER\".version = \"$VERSION\"" users.json > tmp.json && mv tmp.json users.json

git config --global user.name "LunarHost System"
git config --global user.email "system@lunarhost.com"
git add users.json
git commit -m "IP Update: $TARGET_USER"
git push

# 3. Setup Server Environment
mkdir -p users/$TARGET_USER
cd users/$TARGET_USER
echo "eula=true" > eula.txt

# Dynamic Software Downloader
echo "Downloading $SOFTWARE $VERSION..."
if [ "$SOFTWARE" == "purpur" ]; then
    wget -q -O server.jar "https://api.purpurmc.org/v2/purpur/$VERSION/latest/download"
else
    # Default to Paper if undefined
    # (Note: Using a stable fallback link for Paper as their API requires build numbers)
    wget -q -O server.jar "https://api.papermc.io/v2/projects/paper/versions/$VERSION/builds/496/downloads/paper-$VERSION-496.jar"
fi

# 4. Start Server
tmux new-session -d -s lunar_node "java -Xmx6G -jar server.jar nogui"

# 5. Timer (5h 45m)
sleep 20700 

# 6. Save & Push
tmux send-keys -t lunar_node "say [LunarHost] Saving and relocating node..." C-m
sleep 10
tmux send-keys -t lunar_node "save-all" C-m
sleep 10
tmux send-keys -t lunar_node "stop" C-m

while tmux has-session -t lunar_node 2>/dev/null; do sleep 5; done

cd ../../ 
jq ".\"$TARGET_USER\".current_ip = \"Restarting...\"" users.json > tmp.json && mv tmp.json users.json
git add .
git commit -m "Auto-Save Cycle: $TARGET_USER"
git push
