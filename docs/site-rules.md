# Site rules and request matching

## The matching key

```text
key = method + host and normalized path + kept query parameters (sorted) + normalized body
e.g. GET www.amazon.com/dp/B0FQFB8FMG
     GET www.amazon.com/s?k=airpods pro
     POST shop.test/cart/add #body:{"ASIN":"B0TEST","quantity":"1"}
```

The key ignores the scheme (http and https are the same request). Keys are computed when replay
starts, from the rules in effect, so a rule change takes effect on the next replay without a new
recording.

## Where rules come from

| File | Written by | Applies to |
|---|---|---|
| `sites/_default.yaml` | people | every site: generic tracking parameters, ad and analytics hosts |
| `sites/<site>.yaml` | people | every task on that site |
| `tasks/<id>/rules/<site>.auto.yaml` | the recording tool | this task; regenerated with each recording |
| `tasks/<id>/rules/<site>.yaml` | people | this task |

Hand-written rules win over inferred ones; the task's hand-written rules win over `sites/`
(details in [tasks.md](tasks.md)).

### What is inferred

| Inferred | From |
|---|---|
| Excluded bot-check pages (`exclude`) | visible text or path of a captcha page, e.g. "I am human", `/checkpoint/` |
| Volatile parameters (`drop_params`, `body_drop`) | values that differ between loads of the same path and look random or leave the response unchanged; timestamps near the recording time |
| Page identity (`key` + `keep_params: []`) | an ID in the page's `<link rel="canonical">` (Amazon ASIN, numeric IDs, Target `A-…`): title slugs and tracking segments map to `/…/{id}` |
| Searches (`kind: search`) | common query parameter names (`q`, `k`, `query`, `field-keywords`, ...); suggestions by `prefix` and similar |
| Trackers (`block`) | near-empty responses on beacon-like paths (`events`, `batch`, `/px/`, `uedata`, ...); hosts that serve nothing else are blocked whole |

What people usually write: cart and checkout ([compute.md](compute.md)) and the occasional fix.

Effect on the Amazon task (same recording; self-check plus an agent run):

| | generic rules only | + inferred | + hand-written |
|---|---|---|---|
| self-check: API requests matched | 52 / 159 | 42 / 42 | 42 / 42 |
| agent searches with unrecorded wording | 404, no product | finds it, reads $199.00 | same |
| agent buys 3 | wrong cart | wrong cart (no compute rules) | $597.00 |

## Rule file

```yaml
site: amazon                      # rule name; compute.yaml refers to sites by this name
hosts: ["amazon.com", "*.amazon.com"]
drop_params: [ref, qid, sr, "pd_rd_*"]   # query parameters ignored when matching (* wildcards)
body_drop: ["*token*"]            # request body fields ignored when matching (recursive)
block: ["fls-na.amazon.com", "www.amazon.com/1/batch/**"]   # answered with 204 (host, or host/path)
exclude: ["www.amazon.com/checkpoint/**"]   # never stored, never replayed
xhr_not_found: { content_type: application/json, body: "{}" } # optional body for missed API calls
endpoints:
  - name: product
    match: "GET /*/dp/{asin}/**"  # method optional; * one segment, ** any segments, {x} captures one
    key: "/dp/{asin}"             # normalized path
  - name: search
    match: "GET /s"
    host: "www.amazon.com"        # optional: only this host
    keep_params: [k, page]        # only these parameters count (allow-list, beats drop_params)
    kind: search                  # free text: matched by word-set similarity
    text_param: k
    similarity: 0.6
  - name: add_to_cart
    match: "POST /cart/add-to-cart/**"
    kind: stateful                # changes state; handled by ops in compute.yaml
    body_keep: [ASIN, quantity]   # only these body fields count
  - name: cart_view
    match: "GET /gp/cart/view.html"
    kind: computed                # rendered by views in compute.yaml
  - name: promo
    match: "POST /cart/promo"
    kind: promo                   # known codes get their recorded answer; unknown codes get the
    text_param: code              # answer recorded for invalid_code
    invalid_code: BADCODE
```

Other endpoint fields: `fuzzy` (allow same-path matching with different parameters; on by default
for GET, off for requests with a body) and `fuzzy_min` (share of parameters that must agree,
default 0.5; 0 for static files).

## Lookup order

1. `block` rules: 204.
2. Compute rules: state operations (`ops`) update this run's cart and return the recorded
   response; computed views (`views`) are rendered from a recorded page.
3. Exact key. When a key was recorded more than once, the earliest copy wins.
4. Free text: `search` finds the most similar recorded search; `promo` as above.
5. Fuzzy: same method and path, the most query parameters in common.
6. Miss:
   - trackers: 204;
   - images, fonts, CSS, JS: 404 with an empty body;
   - documents: the site's own 404 page (recorded during capture), else a plain 404 page;
   - API requests: 404 with `xhr_not_found`, or `{}` when JSON is accepted.
7. CORS preflights (OPTIONS) that were not recorded are allowed.

The request type comes from `Sec-Fetch-Dest`, falling back to `Accept` and the file extension.
With `--log`, every request is logged as one JSON line: time, method, URL, key, type, source
(exact/fuzzy/search/promo/computed/blocked/preflight/miss), status, matched record, duration.

## Fixing misses

```bash
node bin/pab.js inspect <task> "<url>"     # normalized key, and which record it hits
node bin/pab.js replay <task> --log replay.jsonl && node bin/pab.js stats replay.jsonl
```

- The same path keeps missing with different parameters: add the parameter to `drop_params`.
- Product URLs carry changing slugs and `ref` segments: map them with `match` + a `key` template.
- A POST carries a fresh token each time: `body_drop` it, or list the fields that matter in
  `body_keep`.
