# Personal Agent Benchmark

A benchmark for personal agents on real websites: shopping, posting, booking and more. Each task
comes with a network-level recording of the sites it needs. During a run the agent's browser goes
through a local replay proxy, so the agent sees the real URLs and real pages, while no request
leaves the machine. Runs are repeatable, cannot trip a site's bot defenses, and can be repeated as
often as needed.

## How it works

```text
agent ─▶ browser ─▶ replay proxy (whistle + replay plugin) ─▶ recording of the task
                                  │
                                  └─ nothing is forwarded; misses are answered locally
```

- **Recording**: a person browses the task in a dedicated Chrome profile. Every HTTP exchange is
  stored in a WARC file, with cookies and credentials removed.
- **Matching**: each request is reduced to a key (method, host, path, the query parameters that
  matter, the request body fields that matter). Site rules say which parameters matter, which
  paths are the same page, which requests are searches, and which are trackers.
- **Carts**: there is no cart arithmetic. Adding to the cart works for what was added while
  recording; anything else misses. Cart and checkout pages answer with their last recording,
  which is where the task left them.
- **Clock**: pages see the time of the recording, so "deal ends in 2 hours" behaves as it did.

## Repository layout

```text
tasks/<id>/        one task: task.yaml, recording/, rules/, grading.yaml
sites/             site rules shared by all tasks (_default.yaml applies everywhere)
src/               replay engine, whistle plugin, bundle format, CLI (pab)
plugins/           whistle plugin package that loads the replay engine
deploy/            replay and task images (built locally), a local Docker check
docs/              task format, bundle format, site rules, deployment
```

## Quick start

Needs Node 22+ and Google Chrome.

```bash
npm install
npm run build
node bin/pab.js list
node bin/pab.js replay <task>
```

`replay` unpacks the task's recording into `.cache/`, starts the replay proxy and opens a Chrome
window that uses it, at the first page opened while recording. Close the window to stop; hit rates are printed at the
end.

Connecting an agent:

```bash
node bin/pab.js replay <task> --cdp-port 9333   # the agent drives this Chrome over CDP
node bin/pab.js replay <task> --no-browser      # proxy only; bring your own browser
node bin/pab.js serve <task> --port 8899 --host 0.0.0.0   # in a container
```

A browser of your own needs `--proxy-server=http://127.0.0.1:<port> --ignore-certificate-errors
--disable-quic`. The proxy also answers `http://rr.control/{health,stats,reset}`: `stats` counts
hits and misses, `reset` starts a new run.

Scoring a run: give the request log of the replay and the agent's final answer.

```bash
node bin/pab.js grade <task> --log .cache/logs/replay-<task>-<time>.jsonl --answer answer.md
```

It writes `result.json` and `report.html` (rendered from it) to `.cache/runs/<task>-<time>/`
(`--out` to choose): the score, each graded item with its reason, and the pages the agent opened
that came back 404 (see [docs/grading.md](docs/grading.md#run-report)).

Other commands:

```bash
node bin/pab.js inspect <task> "https://www.amazon.com/s?k=airpods+pro"   # key and match of one request
node bin/pab.js audit                          # check recordings are safe to publish
node bin/pab.js stats .cache/logs/replay-*.jsonl
```

## As a package

The replay engine, the recording format and the `pab` command are published to npm as
`personal-agent-benchmark`; tasks are not part of the package.

```bash
npm install personal-agent-benchmark@0.1.0
npx pab replay path/to/tasks/<id>
```

Modules are imported by path, for example `personal-agent-benchmark/scoring` or
`personal-agent-benchmark/core/rules`; `exports` in `package.json` lists them. While the version
is 0.x, a new minor version may change them. 0.1.x reads and writes recordings in format 2
([docs/bundle-format.md](docs/bundle-format.md)); a new format comes with a new minor version.

## Tasks

No task is published yet; `node bin/pab.js list` shows the tasks of a checkout.

See [docs/tasks.md](docs/tasks.md) for the task format and how tasks are added.

## Isolation

- The proxy is a dedicated whistle instance with one rule that hands every request, HTTPS
  included, to the replay plugin. The plugin only reads the recording.
- Its DNS points at a dead address and proxy variables are removed, so even a request that slipped
  past the plugin could not resolve a host.
- The platform that runs the replay keeps it off the network and the agent's browser to the
  proxy; [docs/deploy.md](docs/deploy.md) lists what it must ensure.

## Recordings

Recordings contain pages of third-party websites as they were served on the recording date, with
cookies, credentials and personal data removed (`pab audit` checks this). They are published here
for evaluating agents. To have content removed, open an issue.

## Documentation

- [docs/tasks.md](docs/tasks.md): task directory, task card, how a task is added
- [docs/bundle-format.md](docs/bundle-format.md): what is inside `recording/`, and its format version
- [docs/site-rules.md](docs/site-rules.md): request matching and site rules
- [docs/grading.md](docs/grading.md): how answers to a task are scored
- [docs/deploy.md](docs/deploy.md): replay and task images, what a platform running replays must ensure

## License

Not decided yet.
