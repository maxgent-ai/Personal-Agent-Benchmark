#!/bin/sh
# Simulates the replay Pod with Docker: replay service + browser on an internal network without
# internet access, then drives the browser over CDP from a third container.
#   sh deploy/local-pod-test.sh tasks/amazon-airpods "https://www.amazon.com/dp/B0FQFB8FMG"
set -e
cd "$(dirname "$0")/.."
TASK=${1:-tasks/amazon-airpods}
URL=${2:-https://www.amazon.com/dp/B0FQFB8FMG}
NET=pab-pod
CAPTURED=$(node -e "const m=require('./$TASK/bundle.json'); console.log(m.captured_from.slice(0,19).replace('T',' '))")

cleanup() { docker rm -f pab-pod-replay pab-pod-browser >/dev/null 2>&1 || true; docker network rm $NET >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create --internal $NET >/dev/null
docker run -d --name pab-pod-replay --network $NET -v "$PWD/$TASK:/task:ro" pab-replay:latest >/dev/null
docker run -d --name pab-pod-browser --network $NET --shm-size=1g -e RR_PROXY=http://pab-pod-replay:8899 pab-browser:latest >/dev/null
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pab-pod-browser)
echo "recording time: $CAPTURED UTC (page clocks should start there); browser CDP at $IP:9223"
# the replay service unpacks the recording before it answers
for i in $(seq 1 60); do docker logs pab-pod-replay 2>&1 | grep -q "listening" && break; sleep 1; done
docker run --rm --network $NET -e RR_CDP=http://$IP:9223 -v "$PWD:/app:ro" -w /app node:22-slim node dist/scripts/pod-smoke.js "$URL"
echo "--- egress check from the Pod network ---"
docker run --rm --network $NET node:22-slim node -e "require('http').get('http://example.com/',{timeout:5000},()=>console.log('reached internet')).on('error',e=>console.log('no internet:',e.code)).on('timeout',function(){this.destroy();console.log('no internet: timeout')})"
