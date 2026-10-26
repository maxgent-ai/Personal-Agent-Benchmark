import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bundle, PageRecord } from './bundle';
import type { RuleSet } from './rules';
import type { Entry, Exchange, Manifest } from './types';
import { header, mimeOf, sha256, writeJson, writeJsonl } from './util';
import { WarcWriter } from './warc';

/** The manifest fields a recorder knows before writing; the rest come from the exchanges. */
export type BundleMeta = Pick<Manifest, 'task_id' | 'locale' | 'timezone'>;

export interface WriteBundleOptions {
  meta: BundleMeta;
  /** Decides site names and which page is each site's 404 page. */
  rules: RuleSet;
  /** Top-level pages visited while recording; defaults to every HTML document. */
  pages?: PageRecord[];
  /** Payloads at least this large are stored once and referenced by revisit records. */
  dedupeMinBytes?: number;
}

export interface WriteBundleResult {
  entries: Entry[];
  manifest: Manifest;
  revisits: number;
  bytes: number;
}

/** Files of earlier bundle versions that replay never read; removed when a bundle is rewritten. */
const LEGACY_FILES = ['datapackage.json', path.join('indexes', 'index.cdxj')];

/**
 * Writes the replayable part of a bundle from exchanges that are already safe to store:
 * archive/data.warc, indexes/entries.jsonl, pages/pages.jsonl and manifest.json. Exchanges are
 * stored in the given order and get ids e000001, e000002, ...
 */
export async function writeBundle(bundle: Bundle, exchanges: Exchange[], o: WriteBundleOptions): Promise<WriteBundleResult> {
  if (!exchanges.length) throw new Error('no exchanges to write');
  exchanges.forEach((ex, i) => (ex.id = 'e' + String(i + 1).padStart(6, '0')));

  fs.rmSync(path.join(bundle.dir, 'archive'), { recursive: true, force: true });
  for (const f of LEGACY_FILES) fs.rmSync(path.join(bundle.dir, f), { force: true });
  const writer = new WarcWriter(path.join(bundle.dir, 'archive', 'data.warc'));
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

  const pages: PageRecord[] = o.pages?.length
    ? o.pages
    : entries
        .filter((e) => e.method === 'GET' && e.status === 200 && e.mime === 'text/html' && (e.resourceType ?? 'document') === 'document')
        .map((e) => ({ id: e.id, url: e.url, ts: e.ts }));
  const getUrls = new Set(entries.filter((e) => e.method === 'GET').map((e) => e.url));
  const otherUrls = new Set(entries.filter((e) => e.method !== 'GET').map((e) => e.url));
  for (const p of pages) p.fetched = getUrls.has(p.url) ? 'GET' : otherUrls.has(p.url) ? 'POST' : 'none';
  writeJsonl(bundle.pagesPath, pages);

  const notFound: Record<string, string> = {};
  for (const p of pages.filter((pg) => pg.note === 'not-found-probe')) {
    const host = new URL(p.url).hostname;
    notFound[o.rules.siteFor(host)?.site ?? host] ??= p.url;
  }
  const manifest: Manifest = {
    task_id: o.meta.task_id,
    captured_from: entries[0].ts,
    captured_to: entries[entries.length - 1].ts,
    not_found: notFound,
    locale: o.meta.locale,
    timezone: o.meta.timezone,
  };
  writeJson(bundle.manifestPath, manifest);
  return { entries, manifest, revisits, bytes };
}
