# Personal Agent Benchmark

Real-site tasks for personal agents, replayed offline from network recordings through whistle.

## Layout

- `tasks/<id>/` one task: `task.yaml`, `bundle.tar.gz` (recording), `bundle.json`, `rules/`, `compute.yaml`. Format: `docs/tasks.md`.
- `sites/` site rules shared by all tasks; `_default.yaml` applies to every site.
- `src/core/` bundle format (`bundle.ts`, `writer.ts`, `warc.ts`, `archive.ts`), request normalization (`normalize.ts`), site rules (`rules.ts`), index (`store.ts`), lookup ladder (`lookup.ts`), compute module (`compute/`), publish audit (`audit.ts`).
- `src/replay/` replay engine, whistle plugin entry, whistle launcher, page clock.
- `src/tasks.ts` task resolution and unpacking; `src/cli.ts` the `pab` command.
- `plugins/whistle.bench-replay/` thin plugin package loading `dist/src/replay/whistle-plugin.js`.
- `deploy/` replay and browser images, Pod and NetworkPolicy, local and kind checks.

The recording tool lives in a separate, internal repository and depends on this package
(`personal-agent-benchmark/<module>` imports). Keep exported module paths stable.

## Rules

- The replay path never opens a network connection. Misses are answered locally and logged.
- Normalization and lookup exist once, in `src/core/`; do not copy them.
- `tasks/<id>/bundle.tar.gz*`, `bundle.json` and `rules/*.auto.yaml` are written by the import step of the recording tool; do not edit them by hand. Corrections go into `rules/<site>.yaml` or `sites/<site>.yaml`.
- Every recording must pass `pab audit` (no cookies or credentials, no excluded pages, no recorder name) before it is committed.
- Never commit unpacked bundles (`.cache/`).
- Documentation is in English.

## Commands

```bash
npm install
npm run build
npm test
node bin/pab.js help
```
