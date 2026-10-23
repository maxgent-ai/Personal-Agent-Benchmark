import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSurt } from 'warcio';
import type { Bundle, PageRecord } from './bundle';
import type { RuleSet } from './rules';
import type { Entry, Exchange, Manifest } from './types';
import { cdxTimestamp, header, mimeOf, sha256, writeJson, writeJsonl } from './util';
import { WarcWriter } from './warc';

/** Who and where a recording was made; copied into manifest.json. */
export interface BundleMeta {
  scenario_id: string;
  task_id?: string;
  start_url?: string;
  region?: { country?: string; zip?: string };
  egress?: string;
  accounts?: string[];
  browser?: string;
  recorder?: string;
  timezone?: string;
  locale?: string;
}

export interface WriteBundleOptions {
  meta: BundleMeta;
  /** Decides site names and which page is each site's 404 page. */
  rules: RuleSet;
  /** Top-level pages visited while recording; defaults to every HTML document. */
  pages?: PageRecord[];
  /** Input files the exchanges came from. */
  sources?: string[];
  /** Counts of exchanges dropped before writing, for the manifest. */
  skipped?: number;
  excluded?: number;
  /** Payloads at least this large are stored once and referenced by revisit records. */
  dedupeMinBytes?: number;
  software?: string;
}

export interface WriteBundleResult {
  entries: Entry[];
  manifest: Manifest;
  revisits: number;
  bytes: number;
}

/**
 * Writes the replayable part of a bundle from exchanges that are already safe to store:
 * archive/data.warc, indexes/{entries.jsonl,index.cdxj}, pages/pages.jsonl, manifest.json and
 * datapackage.json. Exchanges are stored in the given order and get ids e000001, e000002, ...
 */
export async function writeBundle(bundle: Bundle, exchanges: Exchange[], o: WriteBundleOptions): Promise<WriteBundleResult> {
  if (!exchanges.length) throw new Error('no exchanges to write');
  const software = o.software ?? 'personal-agent-benchmark';
  exchanges.forEach((ex, i) => (ex.id = 'e' + String(i + 1).padStart(6, '0')));

  fs.rmSync(path.join(bundle.dir, 'archive'), { recursive: true, force: true });
  const writer = new WarcWriter(path.join(bundle.dir, 'archive', 'data.warc'));
  await writer.writeInfo({ software, format: 'WARC File Format 1.1', scenario: o.meta.scenario_id });
  const firstByDigest = new Map<string, Exchange>();
  const minDedupe = o.dedupeMinBytes ?? 1024;
  const entries: Entry[] = [];
  let revisits = 0;
  let bytes = 0;
  for (const ex of exchanges) {
    const digest = sha256(ex.respBody);
    const first = ex.respBody.length >= minDedupe ? firstByDigest.get(digest) : undefined;
    const spans = await writer.writeExchange(ex, first ? { url: first.url, date: first.ts, digest } : undefined);
    if (first) revisits++;
    else {
      bytes += ex.respBody.length;
      if (ex.respBody.length >= minDedupe) firstByDigest.set(digest, ex);
    }
    entries.push({
      id: ex.id,
      ts: ex.ts,
      method: ex.method,
      url: ex.url,
      status: ex.status,
      mime: mimeOf(ex.respHeaders),
      resourceType: ex.resourceType,
      reqContentType: header(ex.reqHeaders, 'content-type'),
      reqBody: ex.reqBody && ex.reqBody.length ? ex.reqBody.toString('base64') : undefined,
      digest,
      size: ex.respBody.length,
      reqOffset: spans.req.offset,
      reqLength: spans.req.length,
      respOffset: spans.resp.offset,
      respLength: spans.resp.length,
      revisitOf: first?.id,
    });
  }
  writer.close();
  writeJsonl(bundle.entriesPath, entries);
  writeCdxj(bundle, entries);

  const pages: PageRecord[] = o.pages?.length
    ? o.pages
    : entries
        .filter((e) => e.method === 'GET' && e.status === 200 && e.mime === 'text/html' && (e.resourceType ?? 'document') === 'document')
        .map((e) => ({ id: e.id, url: e.url, ts: e.ts }));
  const getUrls = new Set(entries.filter((e) => e.method === 'GET').map((e) => e.url));
  const otherUrls = new Set(entries.filter((e) => e.method !== 'GET').map((e) => e.url));
  for (const p of pages) p.fetched = getUrls.has(p.url) ? 'GET' : otherUrls.has(p.url) ? 'POST' : 'none';
  writeJsonl(bundle.pagesPath, pages);

  const siteOf = (url: string) => {
    const host = new URL(url).hostname;
    return o.rules.siteFor(host)?.site ?? host;
  };
  const notFound: Record<string, string> = {};
  for (const p of pages.filter((pg) => pg.note === 'not-found-probe')) notFound[siteOf(p.url)] ??= p.url;
  const sites: Record<string, { requests: number }> = {};
  for (const e of entries) {
    const site = siteOf(e.url);
    sites[site] = { requests: (sites[site]?.requests ?? 0) + 1 };
  }

  const manifest: Manifest = {
    ...o.meta,
    created_at: new Date().toISOString(),
    captured_from: entries[0].ts,
    captured_to: entries[entries.length - 1].ts,
    sources: o.sources ?? [],
    sites,
    not_found: notFound,
    stats: {
      exchanges: entries.length,
      responses_stored: entries.length - revisits,
      revisits,
      bytes_payload: bytes,
      skipped: o.skipped ?? 0,
      excluded: o.excluded ?? 0,
    },
  };
  writeJson(bundle.manifestPath, manifest);
  writeDatapackage(bundle, manifest, software);
  return { entries, manifest, revisits, bytes };
}

function writeCdxj(bundle: Bundle, entries: Entry[]): void {
  const lines = entries.map((e) => {
    const fields: Record<string, string | number> = {
      url: e.url,
      mime: e.mime || 'unk',
      status: String(e.status),
      digest: 'sha256:' + e.digest,
      length: String(e.respLength),
      offset: String(e.respOffset),
      filename: path.basename(bundle.archivePath),
    };
    if (e.method !== 'GET') fields.method = e.method;
    if (e.revisitOf) fields.mime = 'warc/revisit';
    let surt: string;
    try {
      surt = getSurt(e.url);
    } catch {
      surt = e.url;
    }
    return `${surt} ${cdxTimestamp(e.ts)} ${JSON.stringify(fields)}`;
  });
  lines.sort();
  fs.mkdirSync(path.dirname(bundle.cdxjPath), { recursive: true });
  fs.writeFileSync(bundle.cdxjPath, lines.join('\n') + '\n');
}

function writeDatapackage(bundle: Bundle, manifest: Manifest, software: string): void {
  const files = [bundle.archivePath, bundle.cdxjPath, bundle.pagesPath].filter((f) => fs.existsSync(f));
  const resources = files.map((f) => {
    const data = fs.readFileSync(f);
    return { name: path.basename(f), path: path.relative(bundle.dir, f), hash: 'sha256:' + sha256(data), bytes: data.length };
  });
  writeJson(path.join(bundle.dir, 'datapackage.json'), {
    profile: 'data-package',
    wacz_version: '1.1.1',
    title: manifest.scenario_id,
    created: manifest.created_at,
    software,
    resources,
  });
}
