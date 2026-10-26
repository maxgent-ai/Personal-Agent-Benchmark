import * as fs from 'node:fs';
import * as path from 'node:path';
import { Bundle } from '../core/bundle';
import { lookup } from '../core/lookup';
import { normalizeRequest, type NormalizedRequest, type RequestInput } from '../core/normalize';
import { RuleSet } from '../core/rules';
import { RecordStore } from '../core/store';
import type { Manifest, ReplayRequest, ReplayResponse, ResourceClass, Source, StoredResponse } from '../core/types';
import { headerFromRecord, mimeOf, setHeader, withoutHeaders } from '../core/util';
import { injectClock } from './clock';

export const CONTROL_HOST = 'rr.control';

export interface EngineOptions {
  logFile?: string;
  /** Extra rule directories layered over the bundle's own rules (later wins). */
  rulesDirs?: string[];
  /** "recorded" (default) shifts page clocks to the recording time; "off" leaves them alone. */
  clock?: 'recorded' | 'off';
}

export interface ReplayStats {
  requests: number;
  bySource: Record<string, number>;
  byClass: Record<ResourceClass, { total: number; hit: number; miss: number }>;
  misses: Record<string, { count: number; resourceClass: ResourceClass; url: string }>;
}

const STATIC_DESTS = new Set(['image', 'font', 'style', 'script', 'audio', 'video', 'track', 'manifest', 'object', 'embed', 'worker', 'sharedworker', 'serviceworker', 'paintworklet', 'audioworklet']);
const DROP_RESPONSE_HEADERS = ['content-encoding', 'transfer-encoding', 'content-length', 'alt-svc', 'connection', 'keep-alive'];

/**
 * Answers every request from a recording bundle. It never opens a network connection:
 * misses are answered locally and logged.
 */
export class ReplayEngine {
  readonly bundle: Bundle;
  readonly rules: RuleSet;
  readonly store: RecordStore;
  readonly manifest: Manifest;
  private stats: ReplayStats = emptyStats();
  private readonly logFile?: string;
  private readonly clockMs?: number;

  constructor(bundleDir: string, opts: EngineOptions = {}) {
    this.bundle = new Bundle(path.resolve(bundleDir));
    if (!this.bundle.isPacked()) throw new Error(`not a recording bundle: ${bundleDir}`);
    this.manifest = this.bundle.manifest();
    this.rules = RuleSet.load([this.bundle.rulesDir, ...(opts.rulesDirs ?? [])]);
    this.store = new RecordStore(this.bundle, this.rules);
    this.logFile = opts.logFile;
    if ((opts.clock ?? 'recorded') === 'recorded') this.clockMs = Date.parse(this.manifest.captured_from);
    if (this.logFile) fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
  }

  getStats(): ReplayStats {
    return JSON.parse(JSON.stringify(this.stats)) as ReplayStats;
  }

  reset(): void {
    this.stats = emptyStats();
  }

  async handle(req: ReplayRequest): Promise<ReplayResponse> {
    const started = Date.now();
    const url = new URL(req.url);
    if (url.hostname === CONTROL_HOST) return this.control(url);

    const method = req.method.toUpperCase();
    const input: RequestInput = {
      method: method === 'HEAD' ? 'GET' : method,
      url: req.url,
      contentType: headerFromRecord(req.headers, 'content-type'),
      body: req.body,
    };
    const norm = normalizeRequest(input, this.rules);
    const resourceClass = classify(req, norm);

    let result: { resp: StoredResponse; source: Source; entryId?: string; detail?: string };
    try {
      result = await this.resolve(req, input, norm, resourceClass);
    } catch (err) {
      result = { resp: this.missResponse(resourceClass, norm, req), source: 'miss', detail: `error: ${(err as Error).message}` };
    }

    let resp = result.resp;
    if (this.clockMs !== undefined && resourceClass === 'document' && mimeOf(resp.headers) === 'text/html' && method !== 'HEAD') {
      const shifted = injectClock(resp.body.toString('utf8'), resp.headers, this.clockMs);
      resp = { ...resp, headers: shifted.headers, body: Buffer.from(shifted.html, 'utf8') };
    }
    const body = method === 'HEAD' ? Buffer.alloc(0) : resp.body;
    const headers = setHeader(withoutHeaders(resp.headers, DROP_RESPONSE_HEADERS), 'Content-Length', String(resp.body.length));
    const out: ReplayResponse = {
      status: resp.status,
      statusText: resp.statusText,
      headers,
      body,
      source: result.source,
      key: norm.key,
      kind: norm.kind,
      resourceClass,
      entryId: result.entryId,
      detail: result.detail,
    };
    this.record(req, out, Date.now() - started);
    return out;
  }

  private async resolve(
    req: ReplayRequest,
    input: RequestInput,
    norm: NormalizedRequest,
    resourceClass: ResourceClass,
  ): Promise<{ resp: StoredResponse; source: Source; entryId?: string; detail?: string }> {
    if (norm.kind === 'block') return { resp: empty(204), source: 'blocked' };

    const found = lookup(this.store, norm);
    if (found) return { resp: await this.store.response(found.ix), source: found.source, entryId: found.ix.entry.id, detail: found.detail };

    if (input.method === 'OPTIONS') return { resp: preflight(req), source: 'preflight' };
    return { resp: this.missResponse(resourceClass, norm, req), source: 'miss' };
  }

  private missResponse(resourceClass: ResourceClass, norm: NormalizedRequest, req: ReplayRequest): StoredResponse {
    if (resourceClass === 'tracker') return empty(204);
    if (resourceClass === 'static') return { status: 404, statusText: 'Not Found', headers: [['Content-Type', 'text/plain']], body: Buffer.alloc(0) };
    if (resourceClass === 'document') {
      const notFound = this.notFoundPage(norm);
      if (notFound) return notFound;
      const html = '<!doctype html><html><head><title>Page Not Found</title></head><body><h1>Page Not Found</h1></body></html>';
      return { status: 404, statusText: 'Not Found', headers: [['Content-Type', 'text/html; charset=utf-8']], body: Buffer.from(html) };
    }
    const custom = norm.site?.xhr_not_found;
    if (custom) return { status: 404, statusText: 'Not Found', headers: [['Content-Type', custom.content_type]], body: Buffer.from(custom.body) };
    const wantsJson = (headerFromRecord(req.headers, 'accept') ?? '').includes('json');
    return wantsJson ? jsonResponse(404, {}) : { status: 404, statusText: 'Not Found', headers: [['Content-Type', 'text/plain']], body: Buffer.alloc(0) };
  }

  private cachedNotFound = new Map<string, StoredResponse | null>();

  private notFoundPage(norm: NormalizedRequest): StoredResponse | undefined {
    const site = norm.site?.site;
    if (!site) return undefined;
    const cached = this.cachedNotFound.get(site);
    if (cached !== undefined) return cached ?? undefined;
    return undefined;
  }

  /** Loads each site's recorded 404 page once; call before serving. */
  async warmUp(): Promise<void> {
    for (const [site, url] of Object.entries(this.manifest.not_found ?? {})) {
      const ix = this.store.findByUrl(url);
      if (!ix) {
        this.cachedNotFound.set(site, null);
        continue;
      }
      const resp = await this.store.response(ix);
      this.cachedNotFound.set(site, { ...resp, status: 404, statusText: 'Not Found' });
    }
  }

  private control(url: URL): ReplayResponse {
    let body: unknown;
    switch (url.pathname) {
      case '/health':
        body = { ok: true, task: this.manifest.task_id, entries: this.store.all.length, captured_from: this.manifest.captured_from };
        break;
      case '/stats':
        body = this.getStats();
        break;
      case '/reset':
        this.reset();
        body = { ok: true };
        break;
      default:
        body = { error: 'unknown control path' };
    }
    const resp = jsonResponse(200, body);
    return { ...resp, source: 'control', key: url.href, kind: 'browse', resourceClass: 'xhr' };
  }

  private record(req: ReplayRequest, out: ReplayResponse, ms: number): void {
    const s = this.stats;
    s.requests++;
    s.bySource[out.source] = (s.bySource[out.source] ?? 0) + 1;
    const c = s.byClass[out.resourceClass];
    c.total++;
    if (out.source === 'miss') {
      c.miss++;
      const m = (s.misses[out.key] ??= { count: 0, resourceClass: out.resourceClass, url: req.url });
      m.count++;
    } else {
      c.hit++;
    }
    if (this.logFile) {
      const line = {
        t: new Date().toISOString(),
        method: req.method,
        url: req.url,
        key: out.key,
        kind: out.kind,
        class: out.resourceClass,
        source: out.source,
        status: out.status,
        entry: out.entryId,
        detail: out.detail,
        ms,
        // a missed request in full, so a rule fix can be worked out from the log
        ...(out.source === 'miss' && req.body?.length ? { contentType: headerFromRecord(req.headers, 'content-type'), body: req.body.toString('base64') } : {}),
      };
      fs.appendFileSync(this.logFile, JSON.stringify(line) + '\n');
    }
  }
}

export function classify(req: ReplayRequest, norm: NormalizedRequest): ResourceClass {
  if (norm.kind === 'block') return 'tracker';
  const dest = (headerFromRecord(req.headers, 'sec-fetch-dest') ?? '').toLowerCase();
  if (dest === 'document' || dest === 'iframe' || dest === 'frame') return 'document';
  if (STATIC_DESTS.has(dest)) return 'static';
  if (dest === 'empty') return 'xhr';
  if (norm.kind === 'static') return 'static';
  const accept = headerFromRecord(req.headers, 'accept') ?? '';
  if (req.method.toUpperCase() === 'GET' && accept.includes('text/html')) return 'document';
  return 'xhr';
}

function emptyStats(): ReplayStats {
  return {
    requests: 0,
    bySource: {},
    byClass: {
      document: { total: 0, hit: 0, miss: 0 },
      xhr: { total: 0, hit: 0, miss: 0 },
      static: { total: 0, hit: 0, miss: 0 },
      tracker: { total: 0, hit: 0, miss: 0 },
    },
    misses: {},
  };
}

function empty(status: number): StoredResponse {
  return { status, statusText: '', headers: [], body: Buffer.alloc(0) };
}

function jsonResponse(status: number, value: unknown): StoredResponse {
  return { status, statusText: '', headers: [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store']], body: Buffer.from(JSON.stringify(value)) };
}

function preflight(req: ReplayRequest): StoredResponse {
  const origin = headerFromRecord(req.headers, 'origin') ?? '*';
  const headers: [string, string][] = [
    ['Access-Control-Allow-Origin', origin],
    ['Access-Control-Allow-Credentials', 'true'],
    ['Access-Control-Allow-Methods', headerFromRecord(req.headers, 'access-control-request-method') ?? 'GET, POST, PUT, DELETE, OPTIONS'],
    ['Access-Control-Max-Age', '600'],
    ['Vary', 'Origin'],
  ];
  const reqHeaders = headerFromRecord(req.headers, 'access-control-request-headers');
  if (reqHeaders) headers.push(['Access-Control-Allow-Headers', reqHeaders]);
  return { status: 204, statusText: 'No Content', headers, body: Buffer.alloc(0) };
}

