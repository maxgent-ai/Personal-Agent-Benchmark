import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HeaderList } from './types';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON.stringify with sorted object keys, so equal objects give equal strings. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Glob with `*` (anything) and `?` (one char); case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$', 'i');
}

export function matchesAny(value: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  return globs.some((g) => globToRegExp(g).test(value));
}

export function header(headers: HeaderList, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function headerFromRecord(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() !== lower) continue;
    const v = headers[k];
    return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}

export function withoutHeaders(headers: HeaderList, names: string[]): HeaderList {
  const drop = new Set(names.map((n) => n.toLowerCase()));
  return headers.filter(([k]) => !drop.has(k.toLowerCase()));
}

export function setHeader(headers: HeaderList, name: string, value: string): HeaderList {
  return [...withoutHeaders(headers, [name]), [name, value]];
}

export function mimeOf(headers: HeaderList): string {
  return (header(headers, 'content-type') || '').split(';')[0].trim().toLowerCase();
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    /(json|javascript|xml|x-www-form-urlencoded|svg)/.test(mime)
  );
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/** 14-digit WARC/CDX timestamp from an ISO date. */
export function cdxTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
