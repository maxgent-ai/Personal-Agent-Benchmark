#!/bin/sh
# Simulates a replay with Docker: the replay service fed from the task image, and a browser standing
# in for the agent's, on an internal network without internet access. Drives the browser over CDP
# from a third container, then checks that the network has no way out.
#   sh deploy/local-pod-test.sh tasks/<id> "<a recorded page URL>"
set -e
cd "$(dirname "$0")/.."
TASK=${1:?usage: sh deploy/local-pod-test.sh tasks/<id> <a recorded page URL>}
URL=${2:?usage: sh deploy/local-pod-test.sh tasks/<id> <a recorded page URL>}
NET=pab-pod
VOLUME=pab-pod-task
IMAGES=$(sh deploy/build-images.sh "$TASK")
REPLAY_IMAGE=$(echo "$IMAGES" | sed -n 1p)
TASK_IMAGE=$(echo "$IMAGES" | sed -n 2p)
docker image inspect pab-browser:latest >/dev/null 2>&1 || docker build -q -t pab-browser:latest deploy/browser >/dev/null
BUNDLE=$(node bin/pab.js unpack "$TASK")
CAPTURED=$(node -e "const m=require('$BUNDLE/manifest.json'); console.log(m.captured_from.slice(0,19).replace('T',' '))")

cleanup() {
  docker rm -f pab-pod-replay pab-pod-browser >/dev/null 2>&1 || true
  docker network rm $NET >/dev/null 2>&1 || true
  docker volume rm $VOLUME >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create --internal $NET >/dev/null
# copy the task out of its image into a volume the replay service reads at /task
docker volume create $VOLUME >/dev/null
docker run --rm -v $VOLUME:/out "$TASK_IMAGE"
docker run -d --name pab-pod-replay --network $NET -v $VOLUME:/task:ro "$REPLAY_IMAGE" >/dev/null
docker run -d --name pab-pod-browser --network $NET --shm-size=1g -e RR_PROXY=http://pab-pod-replay:8899 pab-browser:latest >/dev/null
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pab-pod-browser)
echo "images: $REPLAY_IMAGE $TASK_IMAGE"
echo "recording time: $CAPTURED UTC (page clocks should start there); browser CDP at $IP:9223"
# the replay service unpacks the recording before it answers
for i in $(seq 1 60); do docker logs pab-pod-replay 2>&1 | grep -q "listening" && break; sleep 1; done
docker run --rm --network $NET -e RR_CDP=http://$IP:9223 -v "$PWD:/app:ro" -w /app node:22-slim node dist/scripts/pod-smoke.js "$URL"
echo "--- egress check from the Pod network ---"
docker run --rm --network $NET node:22-slim node -e "require('http').get('http://example.com/',{timeout:5000},()=>console.log('reached internet')).on('error',e=>console.log('no internet:',e.code)).on('timeout',function(){this.destroy();console.log('no internet: timeout')})"
