# Running replays in containers

This repository ships the replay as images and says what a platform running agents against it
must ensure. How the platform schedules a replay (Pods, Services, network policies) belongs to
that platform's integration, not here.

## Images

Two images per task, built on the machine that runs the replay; nothing is pushed to a registry.

| Image | What is in it | Built again when |
|---|---|---|
| `pab-replay:<digest>` | the replay service (`deploy/Dockerfile`): whistle, the replay plugin, `sites/` | the code or shared site rules change |
| `pab-task:<id>-<digest>` | one task directory (`deploy/task/Dockerfile`): recording, `rules/`, `task.yaml`, `grading.yaml` | that task changes |

```bash
sh deploy/build-images.sh tasks/<id>    # builds what is missing, prints both image names
```

Tags are digests of what goes into each image, so a run can record exactly which code and which
recording it used. Old tags are not removed. The task image keeps the recording packed; the
replay service unpacks it when it starts (about a second for a 75 MB recording, 214 MB
unpacked).

## Running one replay

- Run the task image once with a volume at `/out`: it copies the task there and exits.
- Run the replay image with that volume at `/task`. It serves the proxy on port 8899 and writes
  every request, and how it was answered, to `/logs/replay.jsonl`. That log is what `pab grade`
  scores the run from (docs/grading.md), so keep it after the run.
- One replay serves one task for one run: start a fresh one per run.

## What the platform must ensure

The replay itself:

- has no network access beyond answering the agent's browser (and whatever reads its log and
  `http://rr.control/stats`). The proxy never opens a connection, but nothing should let it.

The agent's browser, so that the recording rather than the internet answers it:

1. sends everything through the proxy: `--proxy-server=http://<replay host>:8899`, with no
   bypass list beyond loopback (some browser images add private ranges to `--proxy-bypass-list`
   unless it is given);
2. turns QUIC off (`--disable-quic`): QUIC runs over UDP and does not go through an HTTP proxy;
3. accepts the proxy's certificates (`--ignore-certificate-errors`, or trust whistle's root CA):
   the proxy answers HTTPS itself;
4. can reach nothing but the proxy (and DNS to find it);
5. starts from a fresh profile each run (no cache or service workers from an earlier run);
6. preferably uses the recording's time zone and language (`timezone` and `locale` in the
   bundle's `manifest.json`).

Page clocks need nothing from the browser (see below). Agent tools that fetch pages without the
browser (HTTP fetch, search APIs) bypass the proxy: route them through it (`HTTPS_PROXY`) or turn
them off for replay runs.

`deploy/browser/` (`pab-browser`) is Chromium set up this way. It stands in for the agent's
browser in the local check.

## Page clocks

The replay service injects a small script at the top of every HTML page that shifts `Date` to the
recording time (`captured_from` in the manifest) and lets it run on from there; pages with a CSP
get the script's hash added to `script-src`. `RR_CLOCK=off` turns this off. libfaketime in the
browser container was tried and makes Chromium's CDP handshake hang; it would also miss agents
that bring their own browser.

## Local check

```bash
npm run build
sh deploy/local-pod-test.sh tasks/<id> <URL>    # Docker internal network, no internet
```

It builds the images it lacks, runs the replay and the stand-in browser on a Docker network
without internet access, drives the browser over CDP from a third container
(`scripts/pod-smoke.ts`) to open `<URL>` (a page in the recording), and checks that the network
has no way out.
