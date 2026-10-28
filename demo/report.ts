// What a run says about the recording: pages and API calls the replay could not answer properly,
// i.e. what to record again. Pages come from the benchmark's own scoring (src/scoring.ts).
//   node report.ts runs/<run>        rebuild the report of an earlier run
import fs from 'node:fs';
import path from 'node:path';
import { pab } from './pab.ts';

const { readJsonl } = pab('core/util.js');
const { scoreRun, writeRun } = pab('scoring.js');
const { parseGrading, validateGrading } = pab('grading.js');
const { pickJudge } = pab('judge.js');

interface LogLine { t: string; method: string; url: string; key: string; class: string; dest?: string; source: string; status: number; entry?: string; detail?: string }
interface Page { site: string; route: string; method: string; url: string; count: number; status: number; source: string }

export interface ReportInput {
  dir: string;
  task: { id: string; title?: string; prompt?: string };
  answer?: string;
  logFile: string;
  rules: { siteFor(host: string): { site: string } | undefined };
  probes: string[];
  /** The task's grading.yaml; when it exists the answer is graded, as `pab grade` does. */
  gradingFile?: string;
  /** The run's times, steps, tokens and cost (runStats). */
  run?: RunStats;
}

interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } }
/** A line of transcript.jsonl: what runAgent reported, with the time. */
export interface AgentEvent { t: string; type: string; usage?: Usage }
type RunStats = { started: string; finished: string; steps: number; model: string; tokens: { input: number; output: number; cache_read: number; cache_write: number; total: number }; cost_usd: number };

/**
 * The run in figures, from the agent's events: from the prompt (`start`, or `started` for runs
 * recorded before that event) to its last reply, the tool calls, and tokens and cost summed over
 * every model call.
 */
export function runStats(events: AgentEvent[], model: string, started: string): RunStats {
  const replies = events.filter((e) => e.type === 'assistant');
  const sum = (f: (u: Usage) => number | undefined) => replies.reduce((s, e) => s + (e.usage ? (f(e.usage) ?? 0) : 0), 0);
  return {
    started: events.find((e) => e.type === 'start')?.t ?? started,
    finished: (replies.at(-1) ?? events.at(-1))?.t ?? started,
    steps: events.filter((e) => e.type === 'tool_call').length,
    model,
    tokens: { input: sum((u) => u.input), output: sum((u) => u.output), cache_read: sum((u) => u.cacheRead), cache_write: sum((u) => u.cacheWrite), total: sum((u) => u.totalTokens) },
    cost_usd: Math.round(sum((u) => u.cost?.total) * 1e6) / 1e6,
  };
}

/** Writes result.json and report.html (the benchmark's run report) and coverage.md; returns coverage.md. */
export async function writeReport(o: ReportInput): Promise<string> {
  const log: LogLine[] = fs.existsSync(o.logFile) ? readJsonl(o.logFile) : [];
  const grading = o.gradingFile && fs.existsSync(o.gradingFile) ? parseGrading(fs.readFileSync(o.gradingFile, 'utf8')) : undefined;
  const errors: string[] = grading ? validateGrading(grading) : [];
  if (errors.length) throw new Error(`${o.gradingFile}:\n  ${errors.join('\n  ')}`);
  const judge = grading && o.answer !== undefined ? pickJudge() : undefined;
  const result = await scoreRun({ task: o.task, grading, answer: o.answer, log, logFile: o.logFile, rules: o.rules, probes: o.probes, judge, run: o.run });
  writeRun(result, o.dir);
  const md = coverage(result.pages.opened as Page[], log, o.rules);
  const file = path.join(o.dir, 'coverage.md');
  fs.writeFileSync(file, md);
  return md;
}

function problem(p: Page): string | undefined {
  if (p.source === 'miss') return '录制里没有（显示的是网站的 404 页面）';
  if (p.status <= 0) return '录制的副本没有响应（录制时请求就失败了）';
  if ([403, 429, 503].includes(p.status)) return `录制的副本是 ${p.status} 页面（很可能是机器人验证）`;
  return undefined;
}

function coverage(pages: Page[], log: LogLine[], rules: ReportInput['rules']): string {
  const out: string[] = ['# 录制覆盖情况', ''];
  const bad = pages.map((p) => ({ p, why: problem(p) })).filter((x) => x.why);
  const near = pages.filter((p) => !problem(p) && p.source !== 'exact');
  const ok = pages.length - bad.length - near.length;
  out.push(`打开的页面：${pages.length} 个；录制原样应答：${ok} 个；用相近的录制页应答：${near.length} 个；没有正常应答：${bad.length} 个。`, '');

  out.push('## 回放没有正常应答的页面', '');
  if (!bad.length) out.push('无。');
  for (const { p, why } of bad) out.push(`- **${p.site}** ${why}${p.count > 1 ? `（打开了 ${p.count} 次）` : ''}  \n  ${p.url}`);
  out.push('');

  if (near.length) {
    out.push('## 用相近的录制页应答的页面', '', '请确认内容符合 agent 要找的东西（搜索词、商品）。', '');
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

  out.push('## 录制里没有的接口请求', '');
  if (!api.size) out.push('无。');
  for (const [id, a] of [...api].sort((x, y) => x[1].site.localeCompare(y[1].site) || y[1].count - x[1].count)) {
    out.push(`- **${a.site}** ${id}（${a.count} 次）  \n  ${a.url.length > 200 ? `${a.url.slice(0, 200)}...` : a.url}`);
  }
  out.push('');

  const statics = new Map<string, number>();
  for (const r of log) if (r.class === 'static' && r.source === 'miss') statics.set(new URL(r.url).host, (statics.get(new URL(r.url).host) ?? 0) + 1);
  out.push('## 其他请求', '');
  const byClass: Record<string, { total: number; miss: number }> = {};
  for (const r of log) {
    const c = (byClass[r.class] ??= { total: 0, miss: 0 });
    c.total++;
    if (r.source === 'miss') c.miss++;
  }
  for (const [c, v] of Object.entries(byClass)) out.push(`- ${c}：${v.total} 个请求，${v.miss} 个没有命中`);
  if (statics.size) out.push(`- 没有命中的静态文件（按域名）：${[...statics].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join('，')}`);
  out.push('');

  out.push('## 打开过的全部页面', '', '| 站点 | 状态 | 应答方式 | 次数 | URL |', '|---|---|---|---|---|');
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
  const transcriptFile = path.join(dir, 'transcript.jsonl');
  const events: AgentEvent[] = fs.existsSync(transcriptFile) ? readJsonl(transcriptFile) : [];
  console.log(await writeReport({
    dir,
    task: run.task,
    answer: fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf8') : undefined,
    logFile: path.join(dir, 'replay.jsonl'),
    rules,
    probes: Object.values(bundle.manifest().not_found ?? {}),
    gradingFile: target.task?.gradingPath,
    run: events.length ? runStats(events, run.model, run.started) : undefined,
  }));
}
