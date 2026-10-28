// What a run says about the recording: pages and API calls the replay could not answer properly,
// i.e. what to record again. Pages come from the benchmark's own scoring (src/scoring.ts).
//   node report.ts runs/<run>        rebuild the report of an earlier run
import fs from 'node:fs';
import path from 'node:path';
import { pab } from './pab.ts';

const { readJsonl } = pab('core/util.js');
const { scoreRun, writeRun } = pab('scoring.js');

interface LogLine { t: string; method: string; url: string; key: string; class: string; dest?: string; source: string; status: number; entry?: string; detail?: string }
interface Page { site: string; route: string; method: string; url: string; count: number; status: number; source: string }

export interface ReportInput {
  dir: string;
  task: { id: string; title?: string; prompt?: string };
  answer?: string;
  logFile: string;
  rules: { siteFor(host: string): { site: string } | undefined };
  probes: string[];
}

/** Writes result.json and report.html (the benchmark's run report) and coverage.md; returns coverage.md. */
export async function writeReport(o: ReportInput): Promise<string> {
  const log: LogLine[] = fs.existsSync(o.logFile) ? readJsonl(o.logFile) : [];
  const result = await scoreRun({ task: o.task, answer: o.answer, log, logFile: o.logFile, rules: o.rules, probes: o.probes });
  writeRun(result, o.dir);
  const md = coverage(result.pages.opened as Page[], log, o.rules);
  const file = path.join(o.dir, 'coverage.md');
  fs.writeFileSync(file, md);
  return md;
}

function problem(p: Page): string | undefined {
  if (p.source === 'miss') return 'not in the recording (the site\'s 404 page was shown)';
  if (p.status <= 0) return 'the recorded copy has no response (request failed while recording)';
  if ([403, 429, 503].includes(p.status)) return `the recorded copy is a ${p.status} page (likely a bot check)`;
  return undefined;
}

function coverage(pages: Page[], log: LogLine[], rules: ReportInput['rules']): string {
  const out: string[] = ['# Recording coverage', ''];
  const bad = pages.map((p) => ({ p, why: problem(p) })).filter((x) => x.why);
  const near = pages.filter((p) => !problem(p) && p.source !== 'exact');
  const ok = pages.length - bad.length - near.length;
  out.push(`Pages opened: ${pages.length}; answered from the recording: ${ok}; by a similar recorded page: ${near.length}; not answered properly: ${bad.length}.`, '');

  out.push('## Pages the replay did not answer properly', '');
  if (!bad.length) out.push('None.');
  for (const { p, why } of bad) out.push(`- **${p.site}** ${why}${p.count > 1 ? ` (opened ${p.count} times)` : ''}  \n  ${p.url}`);
  out.push('');

  if (near.length) {
    out.push('## Pages answered with a similar recorded page', '', 'Check that the content fits what the agent asked for (search terms, product).', '');
    for (const p of near) out.push(`- **${p.site}** ${p.source}: ${p.url}`);
    out.push('');
  }

  // API calls the pages made that the recording lacks, grouped by endpoint
  const api = new Map<string, { site: string; count: number; url: string }>();
  for (const r of log) {
    if (r.class !== 'xhr' || r.source !== 'miss') continue;
    const u = new URL(r.url);
    const id = `${r.method} ${u.host}${u.pathname}`;
    const seen = api.get(id);
    if (seen) seen.count++;
    else api.set(id, { site: rules.siteFor(u.host)?.site ?? u.host, count: 1, url: r.url });
  }

  out.push('## API calls not in the recording', '');
  if (!api.size) out.push('None.');
  for (const [id, a] of [...api].sort((x, y) => x[1].site.localeCompare(y[1].site) || y[1].count - x[1].count)) {
    out.push(`- **${a.site}** ${id} (${a.count})  \n  ${a.url.length > 200 ? `${a.url.slice(0, 200)}...` : a.url}`);
  }
  out.push('');

  const statics = new Map<string, number>();
  for (const r of log) if (r.class === 'static' && r.source === 'miss') statics.set(new URL(r.url).host, (statics.get(new URL(r.url).host) ?? 0) + 1);
  out.push('## Other requests', '');
  const byClass: Record<string, { total: number; miss: number }> = {};
  for (const r of log) {
    const c = (byClass[r.class] ??= { total: 0, miss: 0 });
    c.total++;
    if (r.source === 'miss') c.miss++;
  }
  for (const [c, v] of Object.entries(byClass)) out.push(`- ${c}: ${v.total} requests, ${v.miss} missed`);
  if (statics.size) out.push(`- static files missed by host: ${[...statics].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(', ')}`);
  out.push('');

  out.push('## All pages opened', '', '| site | status | answered by | times | URL |', '|---|---|---|---|---|');
  for (const p of pages) out.push(`| ${p.site} | ${p.status} | ${p.source} | ${p.count} | ${p.url.length > 120 ? `${p.url.slice(0, 120)}...` : p.url} |`);
  out.push('');
  return out.join('\n');
}

if (import.meta.main) {
  const dir = path.resolve(process.argv[2] ?? '');
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
  const { Repo, resolveTarget } = pab('tasks.js');
  const { loadTarget } = pab('cli.js');
  const target = await resolveTarget(run.task.id, new Repo(run.repo));
  const { bundle, rules } = loadTarget(target);
  const answerFile = path.join(dir, 'answer.md');
  console.log(await writeReport({
    dir,
    task: run.task,
    answer: fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf8') : undefined,
    logFile: path.join(dir, 'replay.jsonl'),
    rules,
    probes: Object.values(bundle.manifest().not_found ?? {}),
  }));
}
