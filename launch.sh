#!/bin/bash
TARGET_USER=$USERNAME
DISK_DIR="mc-disk"

echo "=== LunarHost Boot Sequence for $TARGET_USER ==="
sudo apt-get update -qq && sudo apt-get install -y jq tmux wget curl > /dev/null 2>&1

# 1. Start Tunnel
wget -q https://github.com/ekzhang/bore/releases/download/v0.4.1/bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
tar -xzf bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
chmod +x bore
./bore local 25565 --to bore.network > bore.log 2>&1 &
sleep 5 
PORT=$(grep -oP 'listening at bore.network:\K\d+' bore.log | head -n 1)

# 2. Update Database & IP Folder
cd $DISK_DIR
jq ".\"$TARGET_USER\".server_name = \"$SERVER_NAME\"" users.json > tmp.json && mv tmp.json users.json
jq ".\"$TARGET_USER\".software = \"$SOFTWARE\"" users.json > tmp.json && mv tmp.json users.json
jq ".\"$TARGET_USER\".version = \"$VERSION\"" users.json > tmp.json && mv tmp.json users.json

mkdir -p ip
echo "bore.network:$PORT" > ip/$TARGET_USER.txt

git config --global user.name "LunarHost System"
git config --global user.email "system@lunarhost.com"
git add users.json ip/$TARGET_USER.txt
git commit -m "Node Online: $TARGET_USER ($SERVER_NAME)"
git push

# 3. Setup User's Specific Server Folder (e.g., mc-disk/AADI)
mkdir -p $TARGET_USER
cd $TARGET_USER
echo "eula=true" > eula.txt

# Dynamic API Downloader
if [ ! -f "server.jar" ] || [ "$SOFTWARE" != "$(cat .current_software 2>/dev/null)" ] || [ "$VERSION" != "$(cat .current_version 2>/dev/null)" ]; then
    echo "Downloading new $SOFTWARE $VERSION engine..."
    
    if [ "$SOFTWARE" == "purpur" ]; then
        # Purpur API automatically serves the latest build for a version
        wget -q -O server.jar "https://api.purpurmc.org/v2/purpur/$VERSION/latest/download"
    else
        # Paper API requires us to find the latest build number first
        LATEST_BUILD=$(curl -s https://api.papermc.io/v2/projects/paper/versions/$VERSION | jq -r '.builds[-1]')
        wget -q -O server.jar "https://api.papermc.io/v2/projects/paper/versions/$VERSION/builds/$LATEST_BUILD/downloads/paper-$VERSION-$LATEST_BUILD.jar"
    fi
    
    echo "$SOFTWARE" > .current_software
    echo "$VERSION" > .current_version
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

cd ../
echo "Offline" > ip/$TARGET_USER.txt
git add .
git commit -m "Auto-Save Cycle: $TARGET_USER"
git push
