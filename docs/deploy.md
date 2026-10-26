# Running replays in containers

One run is one Pod: a replay container (`deploy/Dockerfile`) and a browser container
(`deploy/browser/`) sharing localhost. The task directory is mounted read-only at `/task`; the
replay service unpacks the recording into `/cache` when it starts and serves the proxy on 8899. The
browser exposes CDP on 9223 for the agent or the orchestrator.

```bash
docker build -f deploy/Dockerfile -t pab-replay:latest .
docker build -t pab-browser:latest deploy/browser
```

- `deploy/k8s/replay-pod.yaml`: the Pod.
- `deploy/k8s/networkpolicy.yaml`: no egress from replay Pods; CDP only from Pods labelled
  `app: bench-orchestrator`. Egress back to the orchestrator is allowed because some CNIs (kind's
  kindnet) apply egress rules to reply packets of allowed ingress connections; with `egress: []`
  the orchestrator's CDP connection hangs.

## Page clocks

The replay service injects a small script at the top of every HTML page that shifts `Date` to the
recording time (`captured_from` in the manifest) and lets it run on from there; pages with a CSP
get the script's hash added to `script-src`. `RR_CLOCK=off` turns this off. libfaketime in the
browser container was tried and makes Chromium's CDP handshake hang; it would also miss agents
that bring their own browser.

## Local checks

```bash
npm run build
sh deploy/local-pod-test.sh tasks/<id> <URL>        # Docker internal network, no internet
sh deploy/kind/test.sh                               # throwaway kind cluster with the NetworkPolicy
sh deploy/kind/test-netpol.sh                        # NetworkPolicy only, no Chromium (less memory)
```

`local-pod-test.sh` runs both containers on a network without internet access, drives the
browser over CDP from a third container (`scripts/pod-smoke.ts`), and checks that the network has
no way out. The kind scripts create the cluster `pab-test` and delete it afterwards; they need
about 2 GB of free Docker memory.
