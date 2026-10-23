# Bundle format

A bundle is one recording. On disk it is a directory laid out like a WACZ file (`archive/`,
`indexes/`, `pages/`, `datapackage.json`). In this repository it travels as
`tasks/<id>/bundle.tar.gz`, which `pab` unpacks into `.cache/bundles/<id>-<hash>/` on first use.

```text
manifest.json            recording window, region, browser, sites and their request counts,
                         each site's own 404 page, statistics
archive/data.warc        every HTTP exchange (WARC 1.1, uncompressed records)
indexes/entries.jsonl    replay index: one line per exchange, with the request body
indexes/index.cdxj       standard CDXJ index (SURT, timestamp, offset)
pages/pages.jsonl        top-level pages visited while recording
datapackage.json         file list with sha256 hashes
```

Rules and compute rules are not part of the published bundle; they live next to it in the task
directory, so they can be reviewed and changed without touching the recording.

## Archive

`bundle.tar.gz` is a gzip-compressed tar of the files above, written with fixed timestamps so
the same files always give the same bytes. WARC records are stored uncompressed inside it: one
gzip stream over the whole archive compresses far better than per-record gzip (the Amazon task:
33 MB instead of 39 MB). Archives larger than 45 MB are split into `bundle.tar.gz.000`, `.001`,
... and read back in order. Extraction accepts only the files listed above, and only regular files.

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
