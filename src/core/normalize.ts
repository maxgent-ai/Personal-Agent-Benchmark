import type { EndpointRule, Kind, SiteRules } from './types';
import { fillTemplate, RuleSet } from './rules';
import { matchesAny, sha256, stableStringify } from './util';

export interface RequestInput {
  method: string;
  url: string;
  contentType?: string;
  body?: Buffer;
}

export interface NormalizedRequest {
  method: string;
  host: string;
  /** Path after applying the endpoint key template. */
  path: string;
  /** Kept query parameters, sorted. */
  params: [string, string][];
  bodyKey: string;
  /** METHOD host/path?query #body:... — the exact-match key. */
  key: string;
  /** METHOD host/path — groups requests for fuzzy matching. */
  pathKey: string;
  kind: Kind;
  site?: SiteRules;
  endpoint?: EndpointRule;
  captures: Record<string, string>;
  /** Normalized free text for search and promo endpoints. */
  text?: string;
  /** Answer with the last recording of this request rather than the first (carts). */
  latest: boolean;
}

const STATIC_EXT = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|map)$/i;

export function normalizeText(value: string): string {
  return value.replace(/\+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeRequest(input: RequestInput, rules: RuleSet): NormalizedRequest {
  const method = input.method.toUpperCase();
  const url = new URL(input.url);
  const host = url.hostname.toLowerCase() + (url.port && !isDefaultPort(url) ? ':' + url.port : '');
  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  const site = rules.siteFor(url.hostname.toLowerCase());
  const match = rules.matchEndpoint(site, method, url.hostname.toLowerCase(), pathname);
  const endpoint = match?.endpoint;
  const captures = match?.captures ?? {};
  const path = endpoint?.key ? fillTemplate(endpoint.key, captures) : pathname;

  let kind: Kind = endpoint?.kind ?? (STATIC_EXT.test(pathname) ? 'static' : 'browse');
  if (rules.isBlocked(url.hostname.toLowerCase(), pathname, site)) kind = 'block';

  const textParam = endpoint?.text_param;
  let text: string | undefined;
  const drop = rules.dropParams(site, endpoint);
  const params: [string, string][] = [];
  for (const [k, v] of url.searchParams) {
    if (endpoint?.keep_params ? !endpoint.keep_params.includes(k) : matchesAny(k, drop)) continue;
    if (textParam && k === textParam) {
      text = normalizeText(v);
      params.push([k, text]);
    } else {
      params.push([k, v]);
    }
  }
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));

  const body = parseBody(input.contentType, input.body);
  let bodyKey = '';
  if (body.kind === 'fields') {
    const kept = filterFields(body.fields, endpoint?.body_keep, rules.bodyDrop(site, endpoint));
    if (textParam && typeof kept[textParam] === 'string') {
      text = normalizeText(kept[textParam] as string);
      kept[textParam] = text;
    }
    bodyKey = Object.keys(kept).length ? stableStringify(kept) : '';
  } else if (body.kind === 'raw') {
    bodyKey = 'sha256:' + sha256(body.raw).slice(0, 16);
  }

  const query = params.map(([k, v]) => `${k}=${v}`).join('&');
  const pathKey = `${method} ${host}${path}`;
  const key = pathKey + (query ? '?' + query : '') + (bodyKey ? ' #body:' + bodyKey : '');
  const latest = rules.prefersLatest(url.hostname.toLowerCase(), pathname, site);
  return { method, host, path, params, bodyKey, key, pathKey, kind, site, endpoint, captures, text, latest };
}

function isDefaultPort(url: URL): boolean {
  return (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80');
}

type ParsedBody = { kind: 'none' } | { kind: 'fields'; fields: Record<string, unknown> } | { kind: 'raw'; raw: Buffer };

export function parseBody(contentType: string | undefined, body: Buffer | undefined): ParsedBody {
  if (!body || body.length === 0) return { kind: 'none' };
  const ct = (contentType ?? '').toLowerCase();
  const text = body.toString('utf8');
  if (ct.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { kind: 'fields', fields: parsed };
      return { kind: 'fields', fields: { _: parsed } };
    } catch {
      // not JSON after all
    }
  }
  if (ct.includes('x-www-form-urlencoded') || (!ct && /^[\w.%[\]-]+=/.test(text))) {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) {
      const prev = fields[k];
      fields[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return { kind: 'fields', fields };
  }
  return { kind: 'raw', raw: body };
}

/** Keep listed top-level fields (dot paths allowed) or drop volatile ones recursively. */
function filterFields(fields: Record<string, unknown>, keep: string[] | undefined, drop: string[]): Record<string, unknown> {
  if (keep && keep.length) {
    const out: Record<string, unknown> = {};
    for (const p of keep) {
      const v = getPath(fields, p);
      if (v !== undefined) out[p] = v;
    }
    return out;
  }
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!matchesAny(k, drop)) out[k] = strip(v);
      }
      return out;
    }
    return value;
  };
  return strip(fields) as Record<string, unknown>;
}

export function getPath(obj: unknown, dotted: string): unknown {
  if (obj && typeof obj === 'object' && dotted in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[dotted];
  }
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Read a field from the query string or a parsed body. */
export function readField(input: RequestInput, from: 'query' | 'body', field: string): string | undefined {
  if (from === 'query') return new URL(input.url).searchParams.get(field) ?? undefined;
  const body = parseBody(input.contentType, input.body);
  if (body.kind !== 'fields') return undefined;
  const v = getPath(body.fields, field);
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  return v === undefined || v === null ? undefined : String(v);
}
