# Demo: a minimal agent against a task replay

A minimal [pi](https://github.com/earendil-works/pi) agent with one tool, a browser driven through
the [browser-use](https://github.com/browser-use/browser-use) CLI, runs one task against its replay.
You watch it work in a Chrome window. Afterwards a report lists what the recording could not
answer: the pages and API calls to record again.

```text
pi agent (OpenRouter model)
  └─ tool `browser`: Python snippet → browser-use CLI → CDP :9333
       └─ Chrome window (fresh profile)  ──proxy──▶  replay of the task (whistle, :18899)
                                                        └─ replay.jsonl: every request and how it was answered
```

The replay and the browser are the benchmark's own (`src/replay/launcher.ts`, `src/browser.ts`,
the same pieces `pab replay` uses), so the window behaves as it does in `pab replay`.

## Setup

Needs Node 24, [uv](https://docs.astral.sh/uv/) and Google Chrome.

```bash
sh demo/setup.sh
```

It builds the benchmark (`npm run build`), installs the pi packages, and installs browser-use
0.13.14 into `demo/.venv`. Then put your OpenRouter key into `demo/.env` (created from
`.env.example`):

```bash
OPENROUTER_API_KEY=sk-or-...
MODEL=anthropic/claude-sonnet-5.5
```

## Run

```bash
cd demo
node run.ts                      # task sony-xm5-price-compare from this checkout
node run.ts --task <id> --repo <a checkout that has the task> --max-steps 40 --keep-open
node run.ts --model faux         # scripted run without a model: opens the first recorded page and reads it
```

`--keep-open` leaves the window open after the agent answers; close it or press Ctrl-C to write the
report. Ctrl-C during the run stops the agent and still writes the report.

Each run writes `runs/<task>-<time>/`:

| File | What it is |
|---|---|
| `coverage.md` | pages the replay did not answer properly, similar-page answers, API calls missing from the recording, and every page opened |
| `report.html`, `result.json` | the benchmark's run report (`pab grade`'s format): the score when the task has `grading.yaml`, and the run's times, steps, tokens and cost |
| `replay.jsonl` | the replay log |
| `transcript.jsonl`, `answer.md` | the agent's steps and final answer |

`node report.ts runs/<run>` rebuilds the reports of an earlier run.

When the task has `grading.yaml`, the answer is graded the way `pab grade` does it: Claude answers
the checks, through a signed-in local `claude` CLI, or the Claude API when `ANTHROPIC_API_KEY` is
set ([docs/grading.md](../docs/grading.md)).

A page counts as not answered properly when it is not in the recording (the site's 404 page), or
when its recorded copy has no response or is a 403/429/503 page.

## Keeping the run inside the recording

- Chrome sends everything through the replay proxy, with QUIC off and a fresh profile.
- `http_get` (browser-use's fetch outside the browser) is refused, and the harness process gets the
  replay as its HTTP proxy, so Python that fetches on its own cannot reach the internet either.
- The OpenRouter key is not passed to the harness process; only the model calls use it.
- The browser-use daemon runs in its own runtime directory against this window only, so it never
  attaches to your everyday Chrome.

## Notes

- browser-use 0.13's CLI is a CDP harness: the agent reads pages with `js(...)` and clicks by
  coordinates. The system prompt in `agent.ts` says how.
- Kernel's open-source browser images (`onkernel/chromium-headless`) ship only for amd64 (Chrome
  for Testing has no Linux arm64 build); the local Chrome window is used instead and is what you
  watch.
- Locale and time zone come from the recording's manifest; when it has none, `en-US` and
  `America/Chicago` (`--locale`, `--timezone`).
