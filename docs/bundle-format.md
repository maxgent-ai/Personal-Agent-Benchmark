# Bundle format

A bundle is one recording of a task (or several merged into one). It holds only what replay
reads. In this repository it travels as `tasks/<id>/bundle.tar.gz`, which `pab` unpacks into
`.cache/bundles/<id>-<hash>/` on first use.

```text
manifest.json            the few facts replay needs (below)
archive/data.warc        every HTTP exchange (WARC 1.1, uncompressed records)
indexes/entries.jsonl    replay index: one line per exchange, with the request body
pages/pages.jsonl        top-level pages visited while recording
```

Web-archive tools such as ReplayWeb.page read WACZ files, which also carry a CDXJ index and a
`datapackage.json`. Replay does not use them, so bundles do not store them; the recording tool
builds them when it exports a WACZ. Bundles written before this change still contain both files
and unpack as before.

## manifest.json

```json
{
  "task_id": "amazon-airpods",
  "captured_from": "2026-10-22T10:40:57.458Z",
  "captured_to": "2026-10-22T12:50:41.949Z",
  "not_found": { "amazon": "https://www.amazon.com/rr-not-found-mgxy1k2a" },
  "locale": "en-US",
  "timezone": "America/New_York"
}
```

| Field | Used for |
|---|---|
| `task_id` | which `tasks/<id>/` the recording belongs to |
| `captured_from` | page clocks start here during replay |
| `captured_to` | with `captured_from`, tells merged recordings apart |
| `not_found` | each site's own 404 page, answered for documents replay cannot find |
| `locale`, `timezone` | the replay browser's language and time zone |

Nothing else is recorded: not who recorded it, where from, with which browser, or request
counts. `pab audit` fails a manifest with any other field. Recordings made before 2026-10-26
also have `start_url`; replay ignores it, the audit lets it pass, and the next import of the
task drops it. Replay opens the first page opened while recording unless given `--url`.

Rules and compute rules are not part of the published bundle; they live next to it in the task
directory, so they can be reviewed and changed without touching the recording.

## Archive

`bundle.tar.gz` is a gzip-compressed tar of the files above, written with fixed timestamps so
the same files always give the same bytes. WARC records are stored uncompressed inside it: one
gzip stream over the whole archive compresses far better than per-record gzip (the Amazon task:
33 MB instead of 39 MB). Archives larger than 45 MB are split into `bundle.tar.gz.000`, `.001`,
... and read back in order. Extraction accepts only the files listed above (plus the two older
files), and only regular files.

## WARC records

Each exchange is two records: `response` (or `revisit`) first, then `request`, whose
`WARC-Concurrent-To` points at the response.

- Response bodies are stored **decoded**. `Content-Encoding` and `Transfer-Encoding` are removed
  and `Content-Length` matches the stored body; the original encoding is kept in the WARC header
  `RR-Original-Content-Encoding`.
- Identical payloads of 1 KB or more are stored once; later copies are `revisit` records
  (`WARC-Profile: identical-payload-digest`) and `revisitOf` in `entries.jsonl` points at the
  original.
- Requests carry no `Cookie` or `Authorization` header; every `Set-Cookie` value is `REDACTED`.
  `pab audit` verifies both.
- Custom WARC headers: `RR-Exchange-Id` (the id in `entries.jsonl`), `RR-Resource-Type`.

## entries.jsonl

```json
{"id":"e000123","ts":"2026-10-22T10:41:05.120Z","method":"GET","url":"https://www.amazon.com/Apple-.../dp/B0FQFB8FMG/ref=sr_1_1?...","status":200,"mime":"text/html","digest":"<sha256>","size":812345,"reqOffset":1234,"reqLength":456,"respOffset":789,"respLength":101112}
```

POST bodies are kept base64-encoded in `reqBody`. Matching keys are not stored: the replay engine
computes them from the current rules when it starts, so changing a rule never requires a new
recording.

## pages.jsonl

Pages visited while recording, in order. `fetched` says how the address was reached: `GET` (a
document load), `POST` (a form result) or `none` (rewritten by page script). `note:
"not-found-probe"` marks a visit to a path that cannot exist, made to record the site's own 404
page; replay serves that page for documents it cannot find.
