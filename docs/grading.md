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

A grading needs at least one of `require`, `checks` or `trace`. A report lists, per run, the
extracted fields, each item with its result and reason (expected and actual values, the LLM's
reason, the matching request), the score, and the model that graded.
