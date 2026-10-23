#!/bin/sh
# Creates a throwaway kind cluster "pab-test", runs the replay Pod with the no-egress NetworkPolicy,
# drives the browser over CDP from the orchestrator Pod, checks egress and CDP access, then
# deletes the cluster. Needs: kind, kubectl, and images pab-replay, pab-browser, node:22-slim.
set -e
cd "$(dirname "$0")/../.."
REPO=$(pwd)
CLUSTER=pab-test
CTX=kind-$CLUSTER
[ -z "$KEEP" ] && trap 'kind delete cluster --name $CLUSTER >/dev/null 2>&1 || true' EXIT
sed "s#REPO_ROOT#$REPO#" deploy/kind/cluster.yaml > /tmp/pab-kind-cluster.yaml
kind create cluster --name $CLUSTER --config /tmp/pab-kind-cluster.yaml --wait 120s
# `kind load docker-image` trips over multi-platform images; load single-platform archives instead
ARCH=$(docker version -f '{{.Server.Arch}}')
for IMG in pab-replay:latest pab-browser:latest node:22-slim; do
  TAR=/tmp/pab-kind-$(echo $IMG | tr ':/' '__').tar
  docker save --platform linux/$ARCH -o $TAR $IMG
  kind load image-archive $TAR --name $CLUSTER
  rm -f $TAR
done
# the real NetworkPolicy; Pods from the test variant (hostPath task directory)
kubectl --context $CTX apply -f deploy/k8s/networkpolicy.yaml
kubectl --context $CTX apply -f deploy/kind/test-pods.yaml
kubectl --context $CTX wait --for=condition=Ready pod/replay-amazon-airpods pod/orchestrator pod/outsider --timeout=180s
set +e   # report every check even if one fails
BROWSER_IP=$(kubectl --context $CTX get pod replay-amazon-airpods -o jsonpath='{.status.podIP}')
echo "--- agent view over CDP from the orchestrator Pod ($BROWSER_IP:9223) ---"
kubectl --context $CTX exec orchestrator -- env RR_CDP=http://$BROWSER_IP:9223 node dist/scripts/pod-smoke.js https://www.amazon.com/dp/B0FQFB8FMG
PROBE='let done=0;const say=m=>{if(!done++)console.log(m)};require("http").get(process.argv[1],{timeout:15000},r=>{r.resume();say("reached "+r.statusCode)}).on("error",e=>say("blocked "+e.code)).on("timeout",function(){say("blocked timeout");this.destroy()})'
OUTSIDER_IP=$(kubectl --context $CTX get pod outsider -o jsonpath='{.status.podIP}')
echo "--- replay Pod -> internet (expected: blocked) ---"
kubectl --context $CTX exec replay-amazon-airpods -c replay -- node -e "$PROBE" http://example.com/
echo "--- replay Pod -> another Pod (expected: blocked) ---"
kubectl --context $CTX exec replay-amazon-airpods -c replay -- node -e "$PROBE" http://$OUTSIDER_IP:80/
echo "--- unlabelled Pod -> CDP (expected: blocked) ---"
kubectl --context $CTX exec outsider -- node -e "$PROBE" http://$BROWSER_IP:9223/json/version
echo "--- orchestrator -> internet (control, no policy; depends on the host network) ---"
kubectl --context $CTX exec orchestrator -- node -e "$PROBE" http://example.com/
