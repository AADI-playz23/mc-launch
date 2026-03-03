#!/bin/bash
# LunarHost Ephemeral Server Automation Script

TARGET_USER=$USERNAME
DISK_DIR="mc-disk"

echo "=== 1. Installing Core Dependencies ==="
sudo apt-get update -qq && sudo apt-get install -y jq tmux wget > /dev/null 2>&1

echo "=== 2. Setting up Bore Tunnel ==="
wget -q https://github.com/ekzhang/bore/releases/download/v0.4.1/bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
tar -xzf bore-v0.4.1-x86_64-unknown-linux-musl.tar.gz
chmod +x bore

./bore local 25565 --to bore.network > bore.log 2>&1 &
sleep 5 

PORT=$(grep -oP 'listening at bore.network:\K\d+' bore.log | head -n 1)
echo "Allocated LunarHost Port: $PORT"

echo "=== 3. Updating users.json with new IP ==="
cd $DISK_DIR
jq ".\"$TARGET_USER\".current_ip = \"bore.network:$PORT\"" users.json > tmp.json && mv tmp.json users.json

git config --global user.name "LunarHost System"
git config --global user.email "system@lunarhost.com"
git add users.json
git commit -m "IP Update: $TARGET_USER -> bore.network:$PORT"
git push

echo "=== 4. Starting Minecraft Server ==="
mkdir -p users/$TARGET_USER
cd users/$TARGET_USER

if [ ! -f "server.jar" ]; then
    echo "Downloading PaperMC..."
    wget -q -O server.jar https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar
    echo "eula=true" > eula.txt
fi

tmux new-session -d -s lunar_node "java -Xmx6G -jar server.jar nogui"

echo "=== 5. Server Live! Starting 5h 40m Timer ==="
sleep 20400 

echo "=== 6. Commencing Graceful Shutdown ==="
tmux send-keys -t lunar_node "say [LunarHost] Server is saving and restarting to new node in 1 minute!" C-m
sleep 60
tmux send-keys -t lunar_node "save-all" C-m
sleep 10
tmux send-keys -t lunar_node "stop" C-m

while tmux has-session -t lunar_node 2>/dev/null; do
  sleep 5
done
echo "Server safely stopped."

echo "=== 7. Pushing World Data to mc-disk ==="
cd ../../ 
jq ".\"$TARGET_USER\".current_ip = \"Restarting...\"" users.json > tmp.json && mv tmp.json users.json
git add .
git commit -m "Auto-Save Cycle: $TARGET_USER"
git push
