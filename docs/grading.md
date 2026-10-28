# Grading

A personal agent answers in text, so a task is scored from its answer with an LLM and from what
it did in the replay. Each task says how in `tasks/<id>/grading.yaml`, next to `task.yaml`. The
grading requirements are written by the person who set the task; the recording tool turns them
into this format when the recording is imported.

## Format

```yaml
extract:                        # fields an LLM extracts from the agent's answer
  price: { type: money, description: lowest price found, without shipping }
  store: { type: text, description: the website selling at that price }

require:                        # compared by the program; any failure scores 0
  - field: price
    equals: 278.00              # numbers: equals, or min/max; tolerance defaults to 0.01
    source: { url: "https://www.bestbuy.com/site/sony-wh1000xm5/6505727.p", text: "$278.00" }
  - field: store
    one_of: ["Best Buy", "bestbuy.com"]   # text: equals, one_of or contains; case and spacing ignored

checks:                         # yes/no questions an LLM answers about the answer
  - id: right_product
    question: Is the product in the answer a new, black Sony WH-1000XM5 (not renewed, used or another model)?
    required: true              # "no" scores 0; the default when no weight is given
  - id: says_shipping
    question: Does the answer say whether shipping is free?
    weight: 1                   # partial credit

trace:                          # requests the agent made in the replay
  - id: no_order
    must_not: { method: POST, url: "*/checkout/place*" }
  - id: added_to_cart
    must: { method: POST, url: "*/cart/add*", hit: true }   # hit: answered from the recording
```

| Field | Types | Tests |
|---|---|---|
| `money`, `number` | numbers | `equals` (with `tolerance`), `min`, `max`, `one_of` |
| `text` | text | `equals`, `one_of`, `contains` |
| `boolean` | true / false | `equals` |

`source` says where the expected value appears in the recording: a recorded page (or API
response) and the text shown on it, or the text as it is in the response when page scripts fill
the value in (for example `"currentPrice":228`). Import checks that the page is in the recording
and holds that text, so the answer key is something the agent could have read during replay.

## Score

- Required items are every `require` entry, every check without `weight`, and every `trace`
  entry. If any of them fails, the score is 0.
- Otherwise the score is the weight of the weighted checks that passed divided by their total
  weight, or 1 when there are none.

A grading needs at least one of `require`, `checks` or `trace`.

## Run report

`pab grade <task> --log <replay-log.jsonl> --answer <file> [--run <file>]` scores one run and
writes two files side by side, every time:

- `result.json`: the score, the extracted fields, each item with its result and reason (expected
  and actual values, the LLM's reason, the matching request), the model that graded, the answer,
  the pages the agent opened, and how the run went when the harness says (`--run`).
- `report.html`: the same, as a page to read, rendered from `result.json`.

Pages are what the agent opened in a browser tab (`sec-fetch-dest: document` in the replay log),
not frames, scripts, styles or API calls. `pages.not_found` lists those that came back 404, one row
per normalized key with the site, the route, the first URL and how many times it was opened:

- `source: miss`: the recording has no copy. Recording the page lets a later run see it.
- any other source: the site itself answered 404 while recording.

`--run` takes a JSON file from the harness that ran the agent. The report shows it under 运行情况,
with the duration worked out from the two times:

```json
{
  "started": "2026-10-28T06:54:54.376Z",
  "finished": "2026-10-28T06:56:23.042Z",
  "steps": 8,
  "model": "anthropic/claude-sonnet-5.5",
  "tokens": { "input": 18, "output": 2915, "cache_read": 36495, "cache_write": 10202, "total": 49630 },
  "cost_usd": 0.0583
}
```

`started` is when the agent was given the task and `finished` when it answered; both are
required. `steps` counts tool calls. `tokens` are summed over every model call, with `input`
leaving out what was read from or written to the prompt cache.

The report is in Chinese: the page, what the program tests and why an item failed, and the notes.
The grader is told to give its reasons in Simplified Chinese. A check's test is its question as
written in `grading.yaml`, so write the questions in Chinese.

Without `--answer`, or for a task without `grading.yaml`, nothing is scored but both files are
still written with the page list. When the grader fails, the files are written with a note and the
command exits with 1.

The grader is Claude (`claude-opus-5-5`, `--model` to change). With `ANTHROPIC_API_KEY` or
`ANTHROPIC_AUTH_TOKEN` set it calls the Claude API, where a declined request is re-run on
Anthropic's recommended fallback model; otherwise it runs a signed-in local `claude` CLI.
`--judge api|cli` picks one.
