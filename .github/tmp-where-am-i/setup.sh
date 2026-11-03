#!/bin/zsh
# On a disposable CI runner only: test CA, names pointed at this machine, a throwaway default keychain, the app's first-run
# state, real Cloud-mode servers (one from the last release's bundle, an older Cloud page), and the fake Admin.
set -u
T=$GITHUB_WORKSPACE/.github/tmp-where-am-i; F=$RUNNER_TEMP/fx; mkdir -p $F $OUT; cp $T/admin.mjs $T/scenario.json $F/; cd $F
APP=$APP_DIR/OpenMausBot.app; R=$APP/Contents/Resources; BIN=$APP/Contents/MacOS/OpenMausBot
codesign --force --deep -s - "$APP" 2>&1 | tail -1
curl -fsSL -o older.zip "https://github.com/milind-soni/OpenMausBot/releases/download/v$OLDER_RELEASE/OpenMausBot-$OLDER_RELEASE-arm64.zip" && mkdir -p older && ditto -x -k older.zip older
OLD_APP=$F/older/OpenMausBot.app; OLD_R=$OLD_APP/Contents/Resources; OLD_BIN=$OLD_APP/Contents/MacOS/OpenMausBot
HOSTS=(cloud.openmausbot.com omb-cloud-staging.fly.dev us.i.posthog.com studio.omb-test.example older.omb-test.example acme.omb-test.example)
SAN=$(printf 'DNS:%s,' $HOSTS); SAN=${SAN%,}
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -keyout ca-key.pem -out ca.pem -subj "/CN=OMB CI test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=omb-ci-test" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3 -sha256 -extfile ext.cnf -out cert.pem 2>/dev/null
sudo security authorizationdb write com.apple.trust-settings.admin allow 2>&1 | tail -1
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem 2>&1 | tail -1
for h in $HOSTS; do echo "127.0.0.1 $h"; done | sudo tee -a /etc/hosts >/dev/null
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
security verify-cert -c cert.pem -p ssl -s studio.omb-test.example 2>&1 | tail -1 | tee $OUT/trust.txt
KC=$RUNNER_TEMP/test.keychain-db
security create-keychain -p test "$KC"; security set-keychain-settings "$KC"; security unlock-keychain -p test "$KC"; security list-keychains -d user -s "$KC" login.keychain; security default-keychain -d user -s "$KC"
SEED='{"language":"en","onboarding":{"completedAt":"2026-11-01T00:00:00.000Z","version":1,"hintsSeen":["spot.composer","spot.model","spot.approval","spot.connector","tour.composer","tour.model","tour.computer","tour.computer-browser","tour.tools","tour.apps","cloud-welcome-done","cloud-setup-hidden","grok-move-2026-11","whats-new-2026-11","updates-consent","two-places","product-hunt-launch-2026-10","boat-credit-2026-11","github-star-dismissed","cloud-trial-intro-seen-only"]}}'
mkdir -p "$HOME/.openmausbot"; echo "$SEED" > "$HOME/.openmausbot/config.json"
: > pids
start_cloud() { id=$1; port=$2; origin=$3; secret=$4; team=$5; name=$6; release=$7; mkdir -p $F/clouds/$id/home $F/clouds/$id/data; echo "$SEED" > $F/clouds/$id/data/config.json
  ( if [ "$release" = older ]; then B=$OLD_BIN; S=$OLD_R; V=$OLDER_RELEASE; else B=$BIN; S=$R; V=0.1.140; fi
    export HOME=$F/clouds/$id/home ELECTRON_RUN_AS_NODE=1 OMB_DATA_DIR=$F/clouds/$id/data OMB_PORT=$port OMB_WEBHOOK_PORT=$((port+1)) OMB_STATIC_DIR=$S/ui OMB_RESOURCES_PATH=$S OMB_SKILLS_DIR=$S/skills OMB_APP_VERSION=$V OMB_CLOUD_MACHINE_ID=fixture-$id OMB_CLOUD_ADMIN_URL=https://cloud.openmausbot.com OMB_CLOUD_BOOTSTRAP_SECRET=$secret OMB_PUBLIC_URL=$origin
    if [ -n "$team" ]; then export OMB_CLOUD_ROLE=team OMB_CLOUD_TEAM_ID=$team OMB_CLOUD_TEAM_NAME="$name"; else export OMB_CLOUD_ROLE=home; fi
    nohup "$B" $S/server/index.js > $OUT/cloud-$id.log 2>&1 & echo $! >> $F/pids ) }
python3 -c "
import json
for c in json.load(open('scenario.json'))['clouds'].values(): print(c['id'],c['port'],c['origin'],c['secret'],c.get('teamId','') or '-',c['name'],c.get('release','') or '-',sep='\t')
" > clouds.tsv
while IFS=$'\t' read -r id port origin secret team name release; do [ "$team" = "-" ] && team=""; start_cloud $id $port $origin $secret "$team" "$name" "$release"; done < clouds.tsv
FIXTURE_PORT=443 nohup node admin.mjs $F > $OUT/admin.log 2>&1 &
echo $! >> pids
sleep 15
while IFS=$'\t' read -r id port origin secret team name release; do echo "cloud $id ($name): $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/api/health)"; done < clouds.tsv
echo "admin via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://cloud.openmausbot.com/api/public/config)"
echo "cloud via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://studio.omb-test.example/api/health)"
brew install cliclick 2>&1 | tail -1 || true
