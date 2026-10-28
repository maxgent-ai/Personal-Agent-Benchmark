import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchBrowser } from './browser';
import { auditBundle } from './core/audit';
import { Bundle } from './core/bundle';
import { lookup } from './core/lookup';
import { normalizeRequest } from './core/normalize';
import { RuleSet } from './core/rules';
import { RecordStore } from './core/store';
import { readJsonl } from './core/util';
import type { ReplayStats } from './replay/engine';
import { startReplayServer } from './replay/launcher';
import { Repo, resolveTarget, type ReplayTarget } from './tasks';

const HELP = `pab - Personal Agent Benchmark: replay real-site tasks offline

  pab list                                   tasks in this repository
  pab replay <task> [--port 18899] [--url URL] [--cdp-port 9333] [--headless] [--no-browser] [--log FILE]
                                             replay proxy plus a Chrome window that uses it
  pab serve <task> [--port 8899] [--host 127.0.0.1] [--log FILE]
                                             replay proxy only (containers, external browsers)
  pab inspect <task> <url> [--method GET]    normalized key of a request and the recording it hits
  pab audit [<task>...]                      check recordings are safe to publish (all tasks by default)
  pab unpack <task>                          unpack the recording and print its directory
  pab stats <replay-log.jsonl>               summarize a replay log
  pab grade <task> --log <replay-log.jsonl> [--answer FILE] [--run FILE] [--out DIR] [--judge api|cli] [--model M]
                                             score a run and list the pages that returned 404;
                                             writes result.json and report.html; --run: the run's
                                             times, steps, tokens and cost (docs/grading.md)

<task> is a task id, a task directory, or an unpacked bundle directory.
--repo DIR (or PAB_REPO) points at another checkout of this repository.
`;

export interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: string | boolean | undefined, d: number): number => (typeof v === 'string' ? Number(v) : d);

const repoOf = (flags: Args['flags']) => (str(flags.repo) ? new Repo(path.resolve(str(flags.repo)!)) : Repo.default());

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'list':
      return cmdList(flags);
    case 'replay':
      return cmdReplay(positional, flags);
    case 'serve':
      return cmdServe(positional, flags);
    case 'inspect':
      return cmdInspect(positional, flags);
    case 'audit':
      return cmdAudit(positional, flags);
    case 'unpack': {
      const [arg] = positional;
      if (!arg) throw new Error('usage: pab unpack <task>');
      console.log((await resolveTarget(arg, repoOf(flags))).bundleDir);
      return;
    }
    case 'stats':
      return cmdStats(positional);
    case 'grade':
      // required here, not imported: scoring, the report and the judge load only for this command
      return (require('./grade') as typeof import('./grade')).cmdGrade(positional, flags, repoOf(flags));
    default:
      console.log(HELP);
  }
}

function cmdList(flags: Args['flags']): void {
  const repo = repoOf(flags);
  for (const id of repo.taskIds()) {
    const task = repo.task(id);
    const card = task.card();
    const recorded = task.recordingFiles().length ? '' : '  (no recording yet)';
    console.log(`${id.padEnd(28)} ${card.title ?? ''}${recorded}`);
  }
}

/** Rules and recordings of a target, as the replay engine loads them. */
export function loadTarget(target: ReplayTarget): { bundle: Bundle; rules: RuleSet; store: RecordStore } {
  const bundle = new Bundle(target.bundleDir);
  const rules = RuleSet.load([bundle.rulesDir, ...target.rulesDirs]);
  const store = new RecordStore(bundle, rules);
  return { bundle, rules, store };
}

async function cmdReplay(positional: string[], flags: Args['flags']): Promise<void> {
  const [arg] = positional;
  if (!arg) throw new Error('usage: pab replay <task>');
  const repo = repoOf(flags);
  const target = await resolveTarget(arg, repo);
  const bundle = new Bundle(target.bundleDir);
  const manifest = bundle.manifest();
  const port = num(flags.port, 18899);
  const logFile = str(flags.log) ?? path.join(repo.cacheDir, 'logs', `replay-${target.name}-${Date.now()}.jsonl`);
  const server = await startReplayServer({ bundleDir: target.bundleDir, rulesDirs: target.rulesDirs, port, logFile });
  console.log(`replay proxy: ${server.proxy} (${target.name}, recorded ${manifest.captured_from})`);
  console.log(`request log: ${logFile}`);
  const stop = async () => {
    const stats = await server.control<ReplayStats>('/stats').catch(() => undefined);
    await server.stop();
    if (stats) printStats(stats);
  };
  if (flags['no-browser'] === true) {
    console.log(`point a browser at it with: --proxy-server=${server.proxy} --ignore-certificate-errors --disable-quic`);
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await stop();
    return;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-replay-'));
  const cdpPort = flags['cdp-port'] ? num(flags['cdp-port'], 9333) : undefined;
  const context = await launchBrowser({
    profileDir: profile,
    headless: flags.headless === true,
    proxy: { server: server.proxy },
    ignoreHTTPSErrors: true,
    locale: manifest.locale,
    timezoneId: manifest.timezone,
    cdpPort,
  });
  await context.clock.install({ time: new Date(manifest.captured_from) });
  if (cdpPort) console.log(`CDP: http://127.0.0.1:${cdpPort} (an agent can drive this browser)`);
  const page = context.pages()[0] ?? (await context.newPage());
  // the first page opened while recording, unless told otherwise
  const url = str(flags.url) ?? bundle.pages().find((p) => p.note !== 'not-found-probe')?.url;
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => console.error(String(e)));
  console.log('Close the browser window or press Ctrl-C to stop.');
  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
    process.once('SIGINT', () => resolve());
  });
  await context.close().catch(() => undefined);
  fs.rmSync(profile, { recursive: true, force: true });
  await stop();
}

async function cmdServe(positional: string[], flags: Args['flags']): Promise<void> {
  const [arg] = positional;
  if (!arg) throw new Error('usage: pab serve <task>');
  const target = await resolveTarget(arg, repoOf(flags));
  const host = str(flags.host) ?? '127.0.0.1';
  const server = await startReplayServer({
    bundleDir: target.bundleDir,
    rulesDirs: target.rulesDirs,
    port: num(flags.port, 8899),
    host,
    logFile: str(flags.log),
  });
  console.log(`replay proxy for ${target.name} listening on ${host}:${server.port}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    server.child.once('exit', () => resolve());
  });
  await server.stop();
}

async function cmdInspect(positional: string[], flags: Args['flags']): Promise<void> {
  const [arg, url] = positional;
  if (!arg || !url) throw new Error('usage: pab inspect <task> <url>');
  const { rules, store } = loadTarget(await resolveTarget(arg, repoOf(flags)));
  const norm = normalizeRequest({ method: str(flags.method) ?? 'GET', url }, rules);
  const found = lookup(store, norm);
  console.log(JSON.stringify({ key: norm.key, kind: norm.kind, endpoint: norm.endpoint?.name, site: norm.site?.site, text: norm.text, match: found ? { source: found.source, entry: found.ix.entry.id, url: found.ix.entry.url, detail: found.detail } : null }, null, 2));
}

async function cmdAudit(positional: string[], flags: Args['flags']): Promise<void> {
  const repo = repoOf(flags);
  const args = positional.length ? positional : repo.taskIds().filter((id) => repo.task(id).recordingFiles().length);
  let failed = 0;
  for (const arg of args) {
    const target = await resolveTarget(arg, repo);
    const { bundle, rules } = loadTarget(target);
    const findings = await auditBundle(bundle, rules);
    for (const part of target.task?.recordingFiles() ?? []) {
      const mb = fs.statSync(part).size / 1024 / 1024;
      if (mb > 50) findings.push({ check: 'size', detail: `${path.basename(part)} is ${mb.toFixed(1)} MB (git hosts warn above 50 MB)` });
    }
    console.log(`${findings.length ? 'FAIL' : 'ok  '}  ${target.name}`);
    for (const f of findings) console.log(`      [${f.check}] ${f.detail}`);
    if (findings.length) failed++;
  }
  if (failed) process.exitCode = 1;
}

function cmdStats(positional: string[]): void {
  const [file] = positional;
  if (!file) throw new Error('usage: pab stats <replay-log.jsonl>');
  const rows = readJsonl<{ class: string; source: string; url: string }>(file);
  const byClass: Record<string, { total: number; hit: number; miss: number }> = {};
  const misses: Record<string, { count: number; resourceClass: string; url: string }> = {};
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    const c = (byClass[r.class] ??= { total: 0, hit: 0, miss: 0 });
    c.total++;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    if (r.source === 'miss') {
      c.miss++;
      const m = (misses[r.url] ??= { count: 0, resourceClass: r.class, url: r.url });
      m.count++;
    } else c.hit++;
  }
  printStats({ requests: rows.length, byClass: byClass as ReplayStats['byClass'], bySource, misses: misses as ReplayStats['misses'] });
}

export function printStats(stats: ReplayStats): void {
  console.log(`requests ${stats.requests}`);
  for (const [cls, c] of Object.entries(stats.byClass)) {
    if (!c.total) continue;
    console.log(`  ${cls.padEnd(9)} hit ${c.hit}/${c.total} (${((c.hit / c.total) * 100).toFixed(1)}%)`);
  }
  console.log(`  sources ${JSON.stringify(stats.bySource)}`);
  const top = Object.values(stats.misses).sort((a, b) => b.count - a.count).slice(0, 15);
  if (top.length) {
    console.log('  misses (top 15):');
    for (const m of top) console.log(`    [${m.resourceClass}] x${m.count} ${m.url.slice(0, 140)}`);
  }
}
