import * as cheerio from 'cheerio';
import YAML from 'yaml';
import { lookup } from './core/lookup';
import { normalizeRequest } from './core/normalize';
import type { RecordStore } from './core/store';

/**
 * tasks/<id>/grading.yaml: how an agent's answer to the task is scored (docs/grading.md).
 * An LLM extracts fields from the answer and answers yes/no questions; the program compares the
 * extracted fields with the expected ones and checks the requests the agent made in the replay.
 */

export type FieldType = 'money' | 'number' | 'text' | 'boolean';

export interface Grading {
  /** Fields an LLM extracts from the agent's answer. */
  extract?: Record<string, { type: FieldType; description?: string }>;
  /** Compared by the program; any failure scores 0. */
  require?: Requirement[];
  /** Yes/no questions an LLM answers about the answer. */
  checks?: Check[];
  /** Requests the agent must or must not have made, from the replay log. */
  trace?: TraceRule[];
}

export interface Requirement {
  field: string;
  equals?: number | string | boolean;
  min?: number;
  max?: number;
  one_of?: (string | number)[];
  contains?: string;
  /** For numbers: how far the answer may be from equals (default 0.01). */
  tolerance?: number;
  /** Where the expected value appears in the recording: a page and its text as shown there. */
  source?: { url: string; text: string };
}

export interface Check {
  id: string;
  question: string;
  /** A "no" scores 0 (the default when no weight is given). */
  required?: boolean;
  /** Partial credit instead: counts toward the score once every required item passed. */
  weight?: number;
}

export interface TraceRule {
  id: string;
  must?: RequestMatch;
  must_not?: RequestMatch;
}

export interface RequestMatch {
  method?: string;
  /** Glob over the full URL; * matches anything. */
  url: string;
  /** Only requests the replay answered from the recording (not misses). */
  hit?: boolean;
}

const TYPES: FieldType[] = ['money', 'number', 'text', 'boolean'];
const KEYS = ['extract', 'require', 'checks', 'trace'];
const ID = /^[a-z][a-z0-9_]*$/;

export function parseGrading(text: string): Grading {
  const value = YAML.parse(text) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('grading.yaml must be a mapping');
  return value as Grading;
}

/** What is wrong with a grading, as sentences; empty when it can be used. */
export function validateGrading(g: Grading): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(g)) if (!KEYS.includes(k)) errors.push(`unknown key "${k}" (expected ${KEYS.join(', ')})`);
  const fields = g.extract ?? {};
  if (typeof fields !== 'object' || Array.isArray(fields)) errors.push('extract must map field names to { type, description }');
  for (const [name, f] of Object.entries(fields)) {
    if (!ID.test(name)) errors.push(`extract: field name "${name}" must be lowercase letters, digits and _`);
    if (!f || !TYPES.includes(f.type)) errors.push(`extract.${name}: type must be one of ${TYPES.join(', ')}`);
    if (f?.description !== undefined && typeof f.description !== 'string') errors.push(`extract.${name}: description must be text (quote it if it has a colon)`);
  }
  const list = <T>(key: string, v: T[] | undefined): T[] => {
    if (v !== undefined && !Array.isArray(v)) errors.push(`${key} must be a list`);
    return Array.isArray(v) ? v : [];
  };
  const require = list('require', g.require);
  const checks = list('checks', g.checks);
  const trace = list('trace', g.trace);
  if (!require.length && !checks.length && !trace.length) errors.push('nothing to grade: add require, checks or trace');

  require.forEach((r, i) => {
    const at = `require[${i}]`;
    const f = fields[r?.field];
    if (!f) return errors.push(`${at}: field "${r?.field}" is not in extract`);
    const tests = (['equals', 'min', 'max', 'one_of', 'contains'] as const).filter((k) => r[k] !== undefined);
    if (!tests.length) errors.push(`${at}: give equals, min/max, one_of or contains`);
    if (r.equals !== undefined && (r.min !== undefined || r.max !== undefined || r.one_of !== undefined || r.contains !== undefined)) errors.push(`${at}: equals cannot be combined with other tests`);
    const numeric = f.type === 'money' || f.type === 'number';
    if (numeric) {
      for (const k of ['equals', 'min', 'max'] as const) if (r[k] !== undefined && typeof r[k] !== 'number') errors.push(`${at}: ${k} must be a number for a ${f.type} field`);
      if (r.contains !== undefined) errors.push(`${at}: contains is for text fields`);
      if (r.tolerance !== undefined && !(typeof r.tolerance === 'number' && r.tolerance >= 0)) errors.push(`${at}: tolerance must be a number of 0 or more`);
    } else {
      if (r.min !== undefined || r.max !== undefined || r.tolerance !== undefined) errors.push(`${at}: min, max and tolerance are for number and money fields`);
      if (f.type === 'boolean' && (typeof r.equals !== 'boolean' || tests.length > 1)) errors.push(`${at}: a boolean field takes equals: true or false`);
      if (f.type === 'text' && r.equals !== undefined && typeof r.equals !== 'string') errors.push(`${at}: equals must be text for a text field`);
    }
    if (r.one_of !== undefined && (!Array.isArray(r.one_of) || !r.one_of.length)) errors.push(`${at}: one_of must be a non-empty list`);
    if (r.source !== undefined && !(typeof r.source?.url === 'string' && /^https?:\/\//.test(r.source.url) && typeof r.source.text === 'string' && r.source.text.trim())) errors.push(`${at}: source needs an http(s) url and the text shown there`);
  });

  const ids = new Set<string>();
  const id = (at: string, v: unknown) => {
    if (typeof v !== 'string' || !ID.test(v)) errors.push(`${at}: id must be lowercase letters, digits and _`);
    else if (ids.has(v)) errors.push(`${at}: id "${v}" is used twice`);
    else ids.add(v);
  };
  checks.forEach((c, i) => {
    const at = `checks[${i}]`;
    id(at, c?.id);
    if (typeof c?.question !== 'string' || !c.question.trim()) errors.push(`${at}: question is missing`);
    if (c?.weight !== undefined && !(typeof c.weight === 'number' && c.weight > 0)) errors.push(`${at}: weight must be a positive number`);
    if (c?.weight !== undefined && c.required) errors.push(`${at}: a check is either required or weighted`);
  });
  trace.forEach((t, i) => {
    const at = `trace[${i}]`;
    id(at, t?.id);
    const rules = [t?.must, t?.must_not].filter(Boolean);
    if (rules.length !== 1) errors.push(`${at}: give exactly one of must or must_not`);
    for (const m of rules) if (typeof m?.url !== 'string' || !m.url) errors.push(`${at}: url is missing`);
  });
  return errors;
}

/**
 * Expected values whose source page is not in the recording, or does not show the text: the
 * answer could not have been read during replay.
 */
export async function checkSources(g: Grading, store: RecordStore): Promise<string[]> {
  const errors: string[] = [];
  for (const [i, r] of (g.require ?? []).entries()) {
    if (!r.source) continue;
    const norm = normalizeRequest({ method: 'GET', url: r.source.url }, store.rules);
    // the copy replay would answer with (the last one for carts and checkouts)
    const ix = lookup(store, norm)?.ix ?? store.findByUrl(r.source.url);
    if (!ix) {
      errors.push(`require[${i}] (${r.field}): ${r.source.url} is not in the recording`);
      continue;
    }
    // the text a page shows, or the response itself: prices are often filled in by page scripts
    // from data in the response, such as "currentPrice":228
    const body = (await store.response(ix)).body.toString('utf8');
    const shown = /html/i.test(ix.entry.mime) ? cheerio.load(body)('body').text() : '';
    const want = squash(r.source.text);
    if (!squash(shown).includes(want) && !squash(body).includes(want)) errors.push(`require[${i}] (${r.field}): "${r.source.text}" does not appear on ${r.source.url}`);
  }
  return errors;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
