# Bundle format

A bundle is one recording of a task (or several merged into one). It holds only what replay
reads. In this repository it travels as `tasks/<id>/recording/` (the published layout, below),
which `pab` unpacks into `.cache/bundles/<id>-<hash>/` on first use.

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
| `format` | layout version of the published recording (below); only in `recording/manifest.json` |

Nothing else is recorded: not who recorded it, where from, with which browser, or request
counts. `pab audit` fails a manifest with any other field. Recordings made before 2026-10-26
also have `start_url`; replay ignores it, the audit lets it pass, and the next import of the
task drops it. Replay opens the first page opened while recording unless given `--url`.

Rules are not part of the published bundle; they live next to it in the task
directory, so they can be reviewed and changed without touching the recording.

## Published layout (format 2)

```text
tasks/<id>/recording/
  manifest.json        the manifest above, plus "format": 2
  pages.jsonl          pages/pages.jsonl
  entries.jsonl.gz     indexes/entries.jsonl, gzip-compressed
  warc.tar.gz          archive/data.warc in a gzip-compressed tar
                       (warc.tar.gz.000, .001, ... when larger than 45 MB)
```

The WARC is almost all of a recording (the Sony task: 74 MB of 78 MB) and follows the WARC
standard, so it is stored apart from the small files whose layout is ours. The tar is written
with fixed timestamps, so the same WARC always gives the same bytes. WARC records are stored
uncompressed inside it: one gzip stream over the whole file compresses far better than
per-record gzip (the Amazon task: 33 MB instead of 39 MB). Archives larger than 45 MB are split
into numbered parts (GitHub warns above 50 MB and refuses 100 MB) and read back in order.
Extraction accepts only `archive/data.warc`, and only as a regular file.

### Changing the format

`format` is the contract between this repository and the tool that writes recordings into it.
Replay reads exactly one format, `RECORDING_FORMAT` in `src/core/archive.ts`, and refuses any
other with an error naming both. A change to the layout or to the files in it bumps the number,
and the same change rewrites every task to the new format with a script, so replay never keeps
readers for old formats. When only the small files change, the rewrite leaves `warc.tar.gz` as
it was and git stores nothing new for it.

Format 1 was one `bundle.tar.gz` (split the same way) holding all four files; format 2 replaced
it on 2026-10-26.

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
- Every header line is a header: a header sent several times is stored once per value. Recordings
  made with record-replay before 0.5.5 stored such a header as one value joined by newlines, so
  each further value is a line of its own; readers take those lines as values of the header on the
  line before, and `pab audit` fails a bundle that has any.
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
