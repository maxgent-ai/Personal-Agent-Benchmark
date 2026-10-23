#!/bin/sh
# Light kind check of deploy/k8s/networkpolicy.yaml: runs the same probes before and after the
# policy is applied. Expected: before, everything connects; after, the replay Pod cannot reach the
# internet and no Pod can reach its proxy port (only CDP 9223 from the orchestrator is allowed).
cd "$(dirname "$0")/../.."
REPO=$(pwd)
CLUSTER=pab-test
CTX=kind-$CLUSTER
[ -z "$KEEP" ] && trap 'kind delete cluster --name $CLUSTER >/dev/null 2>&1 || true' EXIT
sed "s#REPO_ROOT#$REPO#" deploy/kind/cluster.yaml > /tmp/pab-kind-cluster.yaml
kind create cluster --name $CLUSTER --config /tmp/pab-kind-cluster.yaml --wait 120s || exit 1
ARCH=$(docker version -f '{{.Server.Arch}}')
for IMG in pab-replay:latest node:22-slim; do
  TAR=/tmp/pab-kind-$(echo $IMG | tr ':/' '__').tar
  docker save --platform linux/$ARCH -o $TAR $IMG && kind load image-archive $TAR --name $CLUSTER; rm -f $TAR
done
kubectl --context $CTX apply -f deploy/kind/test-pods-light.yaml
kubectl --context $CTX wait --for=condition=Ready pod/replay-amazon-airpods pod/orchestrator pod/outsider --timeout=180s || exit 1
REPLAY_IP=$(kubectl --context $CTX get pod replay-amazon-airpods -o jsonpath='{.status.podIP}')
# probe target: "http://host/path" (direct) or "http://host/path@ip:port" (through a proxy)
PROBE_JS='const [u,p]=process.argv[1].split("@");const t=new URL(u);const o=p?{host:p.split(":")[0],port:+p.split(":")[1],path:u,headers:{Host:t.host}}:u;const q=require("http").get(o,{timeout:6000},s=>{s.resume();console.log("reached "+s.statusCode)});q.on("error",e=>console.log("blocked "+e.code));q.on("timeout",()=>{q.destroy();console.log("blocked timeout")})'
run_probe() { kubectl --context $CTX exec "$1" -- node -e "$PROBE_JS" "$2" 2>&1 | tail -1; }
probe() {
  echo "  replay Pod -> internet:        $(run_probe replay-amazon-airpods http://example.com/)"
  echo "  outsider -> replay proxy:      $(run_probe outsider http://rr.control/health@$REPLAY_IP:8899)"
  echo "  orchestrator -> replay proxy:  $(run_probe orchestrator http://rr.control/health@$REPLAY_IP:8899)"
  echo "  orchestrator -> internet:      $(run_probe orchestrator http://example.com/)"
}
echo "--- before NetworkPolicy ---"; probe
kubectl --context $CTX apply -f deploy/k8s/networkpolicy.yaml
sleep 5
echo "--- after NetworkPolicy ---"; probe
