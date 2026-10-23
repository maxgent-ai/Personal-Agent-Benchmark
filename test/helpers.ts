import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Exchange } from '../src/core/types';

export interface FakeExchange {
  method?: string;
  url: string;
  status?: number;
  body: string | Buffer;
  contentType?: string;
  reqBody?: string;
  reqContentType?: string;
  ts?: string;
  headers?: [string, string][];
}

export function tmpDir(prefix = 'pab-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Exchanges one second apart from 2026-11-05T10:00:00Z, shaped like the recorder stores them. */
export function exchanges(list: FakeExchange[]): Exchange[] {
  const base = Date.parse('2026-11-05T10:00:00Z');
  return list.map((ex, i) => ({
    id: '',
    ts: ex.ts ?? new Date(base + i * 1000).toISOString(),
    method: ex.method ?? 'GET',
    url: ex.url,
    httpVersion: 'HTTP/1.1',
    reqHeaders: [['Accept', '*/*'], ...(ex.reqContentType ? ([['Content-Type', ex.reqContentType]] as [string, string][]) : [])],
    reqBody: ex.reqBody !== undefined ? Buffer.from(ex.reqBody, 'utf8') : undefined,
    status: ex.status ?? 200,
    statusText: 'OK',
    respHeaders: [['Content-Type', ex.contentType ?? 'text/html; charset=utf-8'], ['Set-Cookie', 'session=REDACTED; Path=/; HttpOnly'], ...(ex.headers ?? [])],
    respBody: Buffer.isBuffer(ex.body) ? ex.body : Buffer.from(ex.body, 'utf8'),
  }));
}

export const REPO_ROOT = path.join(__dirname, '..', '..');
