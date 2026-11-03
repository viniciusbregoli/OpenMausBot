#!/bin/zsh
# On a disposable CI runner only: test CA, names pointed at this machine, a throwaway default keychain, real Cloud-mode servers
# from the app's own bundle (one Team Cloud with no AI, one with the trial's credit relay, one My Cloud), and the fake Admin.
set -u
T=$GITHUB_WORKSPACE/.github/tmp-team-walk; F=$RUNNER_TEMP/fx; mkdir -p $F $OUT; cp $T/admin.mjs $T/lib.mjs $T/scenario.json $F/; cd $F
APP=$APP_DIR/OpenMausBot.app; R=$APP/Contents/Resources; BIN=$APP/Contents/MacOS/OpenMausBot
codesign --force --deep -s - "$APP" 2>&1 | tail -1
HOSTS=(cloud.openmausbot.com omb-cloud-staging.fly.dev cloud.mausbot.com platform.mausbot.com us.i.posthog.com checkout.dodopayments.com home-o.omb-test.example team.omb-test.example credit.omb-test.example)
SAN=$(printf 'DNS:%s,' $HOSTS); SAN=${SAN%,}
openssl req -x509 -newkey rsa:2048 -nodes -days 3 -keyout ca-key.pem -out ca.pem -subj "/CN=OMB CI test CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout key.pem -out leaf.csr -subj "/CN=omb-ci-test" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3 -sha256 -extfile ext.cnf -out cert.pem 2>/dev/null
sudo security authorizationdb write com.apple.trust-settings.admin allow 2>&1 | tail -1
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.pem 2>&1 | tail -1
for h in $HOSTS; do echo "127.0.0.1 $h"; done | sudo tee -a /etc/hosts >/dev/null
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
security verify-cert -c cert.pem -p ssl -s team.omb-test.example 2>&1 | tail -1 | tee $OUT/trust.txt
KC=$RUNNER_TEMP/test.keychain-db
security create-keychain -p test "$KC"; security set-keychain-settings "$KC"; security unlock-keychain -p test "$KC"; security list-keychains -d user -s "$KC" login.keychain; security default-keychain -d user -s "$KC"
: > pids
start_cloud() { id=$1; port=$2; origin=$3; secret=$4; team=$5; name=$6; credit=$7; mkdir -p $F/clouds/$id/home $F/clouds/$id/data
  ( export HOME=$F/clouds/$id/home ELECTRON_RUN_AS_NODE=1 OMB_DATA_DIR=$F/clouds/$id/data OMB_PORT=$port OMB_WEBHOOK_PORT=$((port+1)) OMB_STATIC_DIR=$R/ui OMB_RESOURCES_PATH=$R OMB_SKILLS_DIR=$R/skills OMB_APP_VERSION=0.1.140 OMB_CLOUD_MACHINE_ID=fixture-$id OMB_CLOUD_ADMIN_URL=https://cloud.openmausbot.com OMB_CLOUD_BOOTSTRAP_SECRET=$secret OMB_PUBLIC_URL=$origin NODE_EXTRA_CA_CERTS=$F/ca.pem
    if [ -n "$team" ]; then export OMB_CLOUD_ROLE=team OMB_CLOUD_TEAM_ID=$team OMB_CLOUD_TEAM_NAME="$name"; else export OMB_CLOUD_ROLE=home; fi
    if [ "$credit" = "True" ]; then export OMB_CLOUD_AI_URL=https://cloud.openmausbot.com/api/cloud/services/ai/v1 OMB_CLOUD_AI_TOKEN=omb_ai_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ; fi
    nohup "$BIN" $R/server/index.js > $OUT/cloud-$id.log 2>&1 & echo $! >> $F/pids ) }
python3 -c "
import json
for c in json.load(open('scenario.json'))['clouds'].values(): print(c['id'],c['port'],c['origin'],c['secret'],c.get('teamId',''),c['name'],c.get('credit',False),sep='\t')
" > clouds.tsv
while IFS=$'\t' read -r id port origin secret team name credit; do start_cloud $id $port $origin $secret "$team" "$name" "$credit"; done < clouds.tsv
FIXTURE_PORT=443 nohup node admin.mjs $F > $OUT/admin.log 2>&1 &
echo $! >> pids
sleep 12
while IFS=$'\t' read -r id port origin secret team name credit; do echo "cloud $id: $(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:$port/api/health)"; done < clouds.tsv
echo "admin via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://cloud.openmausbot.com/api/public/config)"
echo "cloud via trusted name: $(curl -s -m 5 -o /dev/null -w '%{http_code}' --cacert ca.pem https://team.omb-test.example/api/health)"
