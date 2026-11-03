#!/bin/zsh
# On a disposable CI runner only: test CA, names pointed at this machine, a throwaway default keychain, the app's first-run
# state, real Cloud-mode servers from the app's own bundle, and the fake Admin.
set -u
T=$GITHUB_WORKSPACE/.github/tmp-account-test; F=$RUNNER_TEMP/fx; mkdir -p $F $OUT; cp $T/admin.mjs $T/scenario.json $F/; cd $F
APP=$APP_DIR/OpenMausBot.app; R=$APP/Contents/Resources; BIN=$APP/Contents/MacOS/OpenMausBot
codesign --force --deep -s - "$APP" 2>&1 | tail -1
HOSTS=(cloud.openmausbot.com omb-cloud-staging.fly.dev us.i.posthog.com home-a.omb-test.example home-b.omb-test.example second-a.omb-test.example team.omb-test.example)
SAN=$(printf 'DNS:%s,' $HOSTS); SAN=${SAN%,}
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -keyout ca-key.pem -out ca.pem -subj "/CN=OMB CI test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=omb-ci-test" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3 -sha256 -extfile ext.cnf -out cert.pem 2>/dev/null
sudo security authorizationdb write com.apple.trust-settings.admin allow 2>&1 | tail -1
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem 2>&1 | tail -1
for h in $HOSTS; do echo "127.0.0.1 $h"; done | sudo tee -a /etc/hosts >/dev/null
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
security verify-cert -c cert.pem -p ssl -s home-a.omb-test.example 2>&1 | tail -1 | tee $OUT/trust.txt
KC=$RUNNER_TEMP/test.keychain-db
security create-keychain -p test "$KC"; security set-keychain-settings "$KC"; security unlock-keychain -p test "$KC"; security list-keychains -d user -s "$KC" login.keychain; security default-keychain -d user -s "$KC"
SEED='{"language":"en","onboarding":{"completedAt":"2026-11-01T00:00:00.000Z","version":1,"hintsSeen":["spot.composer","spot.model","spot.approval","spot.connector","tour.composer","tour.model","tour.computer","tour.computer-browser","tour.tools","tour.apps","cloud-welcome-done","cloud-setup-hidden"]}}'
mkdir -p "$HOME/.openmausbot"; echo "$SEED" > "$HOME/.openmausbot/config.json"
: > pids
start_cloud() { id=$1; port=$2; origin=$3; secret=$4; team=$5; mkdir -p $F/clouds/$id/home $F/clouds/$id/data; echo "$SEED" > $F/clouds/$id/data/config.json
  ( export OPENAI_COMPAT_API_KEY=fixture-not-a-key OPENAI_COMPAT_URL=http://127.0.0.1:9/v1 OPENAI_COMPAT_MODEL=fixture HOME=$F/clouds/$id/home ELECTRON_RUN_AS_NODE=1 OMB_DATA_DIR=$F/clouds/$id/data OMB_PORT=$port OMB_WEBHOOK_PORT=$((port+1)) OMB_STATIC_DIR=$R/ui OMB_RESOURCES_PATH=$R OMB_SKILLS_DIR=$R/skills OMB_APP_VERSION=0.1.139 OMB_CLOUD_MACHINE_ID=fixture-$id OMB_CLOUD_ADMIN_URL=https://cloud.openmausbot.com OMB_CLOUD_BOOTSTRAP_SECRET=$secret OMB_PUBLIC_URL=$origin
    if [ -n "$team" ]; then export OMB_CLOUD_ROLE=team OMB_CLOUD_TEAM_ID=$team OMB_CLOUD_TEAM_NAME="Shared Team"; else export OMB_CLOUD_ROLE=home; fi
    nohup "$BIN" $R/server/index.js > $OUT/cloud-$id.log 2>&1 & echo $! >> $F/pids ) }
python3 -c "
import json
for c in json.load(open('scenario.json'))['clouds'].values():
  if 'port' in c: print(c['id'],c['port'],c['origin'],c['secret'],c.get('teamId',''),sep='\t')
" > clouds.tsv
while IFS=$'\t' read -r id port origin secret team; do start_cloud $id $port $origin $secret "$team"; done < clouds.tsv
FIXTURE_PORT=443 nohup node admin.mjs $F > $OUT/admin.log 2>&1 &
echo $! >> pids
sleep 12
while IFS=$'\t' read -r id port origin secret team; do echo "cloud $id: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/api/health)"; done < clouds.tsv
echo "admin via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://cloud.openmausbot.com/api/public/config)"
echo "cloud via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://home-a.omb-test.example/api/health)"
