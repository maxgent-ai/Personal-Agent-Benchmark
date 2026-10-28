# Personal Agent Benchmark

Real-site tasks for personal agents, replayed offline from network recordings through whistle.

## Layout

- `tasks/<id>/` one task: `task.yaml`, `recording/`, `rules/`, `grading.yaml`. Format: `docs/tasks.md`, grading in `docs/grading.md` (`src/grading.ts` validates it).
- `sites/` site rules shared by all tasks; `_default.yaml` applies to every site.
- `src/core/` bundle format (`bundle.ts`, `writer.ts`, `warc.ts`, `archive.ts`), request normalization (`normalize.ts`), site rules (`rules.ts`), index (`store.ts`), lookup ladder (`lookup.ts`), publish audit (`audit.ts`).
- `src/replay/` replay engine, whistle plugin entry, whistle launcher, page clock.
- `src/tasks.ts` task resolution and unpacking; `src/cli.ts` the `pab` command; `src/grade.ts` `pab grade`, which `cli.ts` requires only when it runs.
- `plugins/whistle.bench-replay/` thin plugin package loading `dist/src/replay/whistle-plugin.js`.
- `deploy/` the replay image and per-task images (built locally, never pushed), a stand-in for the agent's browser, and a local Docker check. How a platform schedules replays is that platform's integration; `docs/deploy.md` says what it must ensure.

The recording tool lives in a separate, internal repository and depends on this package as
published to npm, at an exact version (`personal-agent-benchmark/<module>` imports). `exports` in
`package.json` lists the module paths it may import. A change to those modules, to the recording
format (`RECORDING_FORMAT`) or to request matching ships as a new version: a new minor version
while the package is 0.x. `npm run release-check` (`scripts/release-check.ts`) lists what changed
since the published version in what the tool uses, and `npm publish` stops when that is nothing.
Keep what the tool never runs out of the modules it loads, as `pab grade` is: the tool imports
`cli`, so scoring, the report and the judge are required inside the command, not imported by
`cli.ts`.

## Rules

- The replay path never opens a network connection. Misses are answered locally and logged.
- Normalization and lookup exist once, in `src/core/`; do not copy them.
- `tasks/<id>/recording/` and `rules/*.auto.yaml` are written by the import step of the recording tool; do not edit them by hand. Corrections go into `rules/<site>.yaml` or `sites/<site>.yaml`.
- Every recording must pass `pab audit` (no cookies or credentials, no excluded pages, no recorder name) before it is committed.
- Never commit unpacked bundles (`.cache/`).
- Documentation is in English.

## Commands

```bash
npm install
npm run build
npm test
npm run release-check   # does the recording tool need a new version?
node bin/pab.js help
```
