import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RuleSet } from './core/rules';
import { globToRegExp } from './core/util';
import type { FieldType, Grading, Requirement, RequestMatch } from './grading';
import type { Judge } from './judge';
import { renderReport } from './report';

/**
 * Scores one agent run (docs/grading.md) and lists the pages the agent opened in the replay, so
 * pages that came back 404 can be added to the recording.
 */

/** A line of the replay request log (ReplayEngine.record). */
export interface LogLine {
  t: string;
  method: string;
  url: string;
  key: string;
  class: string;
  /** sec-fetch-dest; absent in logs written before it was recorded and for non-browser clients. */
  dest?: string;
  source: string;
  status: number;
}

export interface ItemResult {
  kind: 'require' | 'check' | 'trace';
  id: string;
  /** What was tested: the question, the expected value or the request. */
  test: string;
  required: boolean;
  weight?: number;
  passed: boolean;
  reason: string;
}

/** A page (one normalized key) opened in a browser tab during the replay. */
export interface PageResult {
  site: string;
  /** The normalized key without its method: host, path and the query parameters that matter. */
  route: string;
  method: string;
  /** The first URL the agent opened for it. */
  url: string;
  count: number;
  status: number;
  /** How replay answered: exact, fuzzy, search, promo, blocked, or miss (not in the recording). */
  source: string;
  first: string;
}

export interface RunResult {
  task: { id: string; title?: string; prompt?: string };
  graded_at: string;
  replay_log?: string;
  answer?: string;
  grader?: { via: string; model: string };
  /** 0 to 1; absent when the run could not be graded (see notes). */
  score?: number;
  fields: Record<string, unknown>;
  items: ItemResult[];
  /** Pages in browser tabs, not frames, scripts or styles. not_found: those answered with 404. */
  pages: { opened: PageResult[]; not_found: PageResult[] };
  notes: string[];
}

export interface RunInput {
  task: RunResult['task'];
  grading?: Grading;
  answer?: string;
  log: LogLine[];
  logFile?: string;
  rules: RuleSet;
  /** Each site's recorded 404 page (manifest not_found): recorder probes, not pages anyone opened. */
  probes?: string[];
  judge?: Judge;
}

export async function scoreRun(input: RunInput): Promise<RunResult> {
  const { grading, answer } = input;
  const result: RunResult = {
    task: input.task,
    graded_at: new Date().toISOString(),
    replay_log: input.logFile,
    answer,
    fields: {},
    items: [],
    pages: pagesOf(input.log, input.rules, new Set(input.probes ?? [])),
    notes: [],
  };
  if (!grading) {
    result.notes.push('not graded: the task has no grading.yaml');
    return result;
  }
  if (answer === undefined) {
    result.notes.push('not graded: no answer was given (--answer)');
    return result;
  }
  const extract = grading.extract ?? {};
  const checks = grading.checks ?? [];
  let reply: JudgeReply = { fields: {}, checks: {} };
  if (Object.keys(extract).length || checks.length) {
    if (!input.judge) throw new Error('grading needs a judge');
    result.grader = { via: input.judge.via, model: input.judge.model };
    try {
      const asked = await input.judge.ask(judgeRequest(input.task, grading, answer));
      reply = asked.output as JudgeReply;
      result.grader.model = asked.model;
    } catch (err) {
      result.notes.push(`not graded: the grader failed (${(err as Error).message})`);
      return result;
    }
  }
  result.fields = reply.fields ?? {};

  for (const r of grading.require ?? []) {
    const type = extract[r.field]?.type ?? 'text';
    result.items.push({ kind: 'require', id: r.field, test: describe(r), required: true, ...compare(r, type, result.fields[r.field]) });
  }
  for (const c of checks) {
    const got = reply.checks?.[c.id];
    const weighted = c.weight !== undefined;
    result.items.push({
      kind: 'check',
      id: c.id,
      test: c.question,
      required: !weighted,
      ...(weighted ? { weight: c.weight } : {}),
      passed: got?.pass === true,
      reason: got?.reason ?? 'the grader gave no answer',
    });
  }
  for (const t of grading.trace ?? []) {
    const rule = (t.must ?? t.must_not)!;
    const found = input.log.filter((r) => matches(r, rule));
    const first = found[0] && `${found[0].method} ${found[0].url}${found.length > 1 ? ` (and ${found.length - 1} more)` : ''}`;
    const passed = t.must ? found.length > 0 : found.length === 0;
    result.items.push({ kind: 'trace', id: t.id, test: `${t.must ? 'must' : 'must not'} request ${matchText(rule)}`, required: true, passed, reason: first ?? 'no such request' });
  }
  result.score = score(result.items);
  return result;
}

/** 0 when a required item failed; otherwise the passed share of the weighted checks, or 1. */
export function score(items: ItemResult[]): number {
  if (items.some((i) => i.required && !i.passed)) return 0;
  const weighted = items.filter((i) => i.weight !== undefined);
  const total = weighted.reduce((s, i) => s + i.weight!, 0);
  return total ? weighted.filter((i) => i.passed).reduce((s, i) => s + i.weight!, 0) / total : 1;
}

/** Writes result.json and report.html (rendered from it) into `dir`. */
export function writeRun(result: RunResult, dir: string): { json: string; html: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, 'result.json');
  const html = path.join(dir, 'report.html');
  fs.writeFileSync(json, JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(html, renderReport(result));
  return { json, html };
}

// ---- pages

const ASSET = /\.(m?js|css|map|json|xml|txt|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wasm)$/i;
const NOT_REPLAYED = new Set(['control', 'preflight']);

export function isPage(r: LogLine): boolean {
  if (NOT_REPLAYED.has(r.source)) return false;
  // a request without sec-fetch-dest (older logs, non-browser clients) counts when replay classed it as a page
  if (r.dest !== undefined ? r.dest !== 'document' : r.class !== 'document') return false;
  try {
    return !ASSET.test(new URL(r.url).pathname);
  } catch {
    return false;
  }
}

function pagesOf(log: LogLine[], rules: RuleSet, probes: Set<string>): RunResult['pages'] {
  const byKey = new Map<string, PageResult>();
  for (const r of log) {
    if (!isPage(r) || probes.has(r.url)) continue;
    const id = `${r.status} ${r.key}`;
    const seen = byKey.get(id);
    if (seen) {
      seen.count++;
      continue;
    }
    const host = new URL(r.url).host;
    const route = r.key ? r.key.slice(r.key.indexOf(' ') + 1) : host + new URL(r.url).pathname;
    byKey.set(id, { site: rules.siteFor(host)?.site ?? host, route, method: r.method, url: r.url, count: 1, status: r.status, source: r.source, first: r.t });
  }
  const opened = [...byKey.values()];
  return { opened, not_found: opened.filter((p) => p.status === 404) };
}

// ---- the grader's part

interface JudgeReply {
  fields?: Record<string, unknown>;
  checks?: Record<string, { reason: string; pass: boolean }>;
}

const SYSTEM = [
  'You grade the answer a personal AI agent gave to a task it was set.',
  'Extract the listed fields from the answer and answer each yes/no question about the answer.',
  'Take values only from what the answer says; when the answer does not state a field, return null for it.',
  'For each question give a short reason first, quoting or pointing to the part of the answer it rests on, then pass: true for yes and false for no.',
].join(' ');

const JSON_TYPE: Record<FieldType, string> = { money: 'number', number: 'number', text: 'string', boolean: 'boolean' };

function judgeRequest(task: RunResult['task'], g: Grading, answer: string) {
  const extract = Object.entries(g.extract ?? {});
  const checks = g.checks ?? [];
  const properties: Record<string, unknown> = {};
  if (extract.length) {
    properties.fields = {
      type: 'object',
      properties: Object.fromEntries(extract.map(([name, f]) => [name, { anyOf: [{ type: JSON_TYPE[f.type] }, { type: 'null' }], ...(f.description ? { description: f.description } : {}) }])),
      required: extract.map(([name]) => name),
      additionalProperties: false,
    };
  }
  if (checks.length) {
    const verdict = { type: 'object', properties: { reason: { type: 'string' }, pass: { type: 'boolean' } }, required: ['reason', 'pass'], additionalProperties: false };
    properties.checks = { type: 'object', properties: Object.fromEntries(checks.map((c) => [c.id, verdict])), required: checks.map((c) => c.id), additionalProperties: false };
  }
  const lines = [`<task>\n${task.prompt ?? task.title ?? task.id}\n</task>`, `<answer>\n${answer}\n</answer>`];
  if (extract.length) lines.push('Fields to extract (money and number as plain numbers, without currency signs):', ...extract.map(([name, f]) => `- ${name} (${f.type})${f.description ? `: ${f.description}` : ''}`));
  if (checks.length) lines.push('Questions:', ...checks.map((c) => `- ${c.id}: ${c.question}`));
  return { system: SYSTEM, prompt: lines.join('\n\n'), schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } };
}

// ---- program-checked items

const squash = (s: unknown) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

function describe(r: Requirement): string {
  const parts: string[] = [];
  if (r.equals !== undefined) parts.push(`equals ${r.equals}${r.tolerance !== undefined ? ` (±${r.tolerance})` : ''}`);
  if (r.min !== undefined) parts.push(`at least ${r.min}`);
  if (r.max !== undefined) parts.push(`at most ${r.max}`);
  if (r.one_of !== undefined) parts.push(`one of ${r.one_of.join(', ')}`);
  if (r.contains !== undefined) parts.push(`contains "${r.contains}"`);
  return `${r.field} ${parts.join(', ')}`;
}

function compare(r: Requirement, type: FieldType, value: unknown): { passed: boolean; reason: string } {
  if (value === null || value === undefined) return { passed: false, reason: 'not stated in the answer' };
  const got = `got ${JSON.stringify(value)}`;
  if (type === 'money' || type === 'number') {
    const v = Number(value);
    const tol = r.tolerance ?? 0.01;
    const near = (x: unknown) => Math.abs(v - Number(x)) <= tol + 1e-9;
    const ok = !Number.isNaN(v) && (r.equals === undefined || near(r.equals)) && (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max) && (r.one_of === undefined || r.one_of.some(near));
    return { passed: ok, reason: got };
  }
  if (type === 'boolean') return { passed: value === r.equals, reason: got };
  const v = squash(value);
  const ok = (r.equals === undefined || v === squash(r.equals)) && (r.one_of === undefined || r.one_of.some((o) => v === squash(o))) && (r.contains === undefined || v.includes(squash(r.contains)));
  return { passed: ok, reason: got };
}

const NOT_FROM_RECORDING = new Set(['miss', 'blocked', 'preflight', 'control']);

function matches(r: LogLine, m: RequestMatch): boolean {
  if (m.method && r.method.toUpperCase() !== m.method.toUpperCase()) return false;
  if (m.hit && NOT_FROM_RECORDING.has(r.source)) return false;
  return globToRegExp(m.url).test(r.url);
}

const matchText = (m: RequestMatch) => `${m.method ? `${m.method.toUpperCase()} ` : ''}${m.url}${m.hit ? ' (answered from the recording)' : ''}`;
