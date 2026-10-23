import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATUS_CODES } from 'node:http';
import { WARCParser, WARCRecord, WARCSerializer } from 'warcio';
import type { Exchange, HeaderList, StoredResponse } from './types';
import { header } from './util';

export interface Span {
  offset: number;
  length: number;
}

const REVISIT_PROFILE = 'http://netpreserve.org/warc/1.1/revisit/identical-payload-digest';

/**
 * Appends WARC records to one file and reports where each landed. Records are written
 * uncompressed by default: bundles are compressed as a whole for transport, which shrinks them
 * far more than per-record gzip (cross-record redundancy); pass gzip for a standalone .warc.gz.
 */
export class WarcWriter {
  private readonly fd: number;
  private offset = 0;

  constructor(readonly file: string, private readonly opts: { gzip?: boolean } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
  }

  async writeInfo(info: Record<string, string>): Promise<Span> {
    const record = WARCRecord.createWARCInfo({ filename: path.basename(this.file), warcVersion: 'WARC/1.1' }, info);
    return this.write(record);
  }

  /** Writes a response (or a revisit pointing at an identical earlier payload) and its request. */
  async writeExchange(ex: Exchange, revisit?: { url: string; date: string; digest: string }): Promise<{ req: Span; resp: Span }> {
    const statusline = `HTTP/1.1 ${ex.status} ${ex.statusText || STATUS_CODES[ex.status] || ''}`.trim();
    const warcHeaders: Record<string, string> = { 'RR-Exchange-Id': ex.id };
    if (ex.originalContentEncoding) warcHeaders['RR-Original-Content-Encoding'] = ex.originalContentEncoding;
    if (ex.resourceType) warcHeaders['RR-Resource-Type'] = ex.resourceType;

    let respRecord: WARCRecord;
    if (revisit) {
      respRecord = WARCRecord.create(
        {
          url: ex.url,
          date: ex.ts,
          type: 'revisit',
          warcVersion: 'WARC/1.1',
          refersToUrl: revisit.url,
          refersToDate: revisit.date,
          warcHeaders: { ...warcHeaders, 'WARC-Profile': REVISIT_PROFILE, 'RR-Payload-Sha256': revisit.digest },
          httpHeaders: ex.respHeaders,
          statusline,
          keepHeadersCase: true,
        },
        [],
      );
    } else {
      respRecord = WARCRecord.create(
        {
          url: ex.url,
          date: ex.ts,
          type: 'response',
          warcVersion: 'WARC/1.1',
          warcHeaders,
          httpHeaders: ex.respHeaders,
          statusline,
          keepHeadersCase: true,
        },
        [ex.respBody],
      );
    }
    const respId = respRecord.warcHeader('WARC-Record-ID') ?? '';
    const resp = await this.write(respRecord);

    const u = new URL(ex.url);
    const reqHeaders: HeaderList = header(ex.reqHeaders, 'host') ? ex.reqHeaders : [['Host', u.host], ...ex.reqHeaders];
    const reqRecord = WARCRecord.create(
      {
        url: ex.url,
        date: ex.ts,
        type: 'request',
        warcVersion: 'WARC/1.1',
        warcHeaders: { 'WARC-Concurrent-To': respId, 'RR-Exchange-Id': ex.id },
        httpHeaders: reqHeaders,
        statusline: `${ex.method} ${u.pathname}${u.search} HTTP/1.1`,
        keepHeadersCase: true,
      },
      ex.reqBody && ex.reqBody.length ? [ex.reqBody] : [],
    );
    const req = await this.write(reqRecord);
    return { req, resp };
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  private async write(record: WARCRecord): Promise<Span> {
    const bytes = await WARCSerializer.serialize(record, { gzip: this.opts.gzip ?? false });
    fs.writeSync(this.fd, bytes);
    const span = { offset: this.offset, length: bytes.length };
    this.offset += bytes.length;
    return span;
  }
}

function headerList(record: WARCRecord): HeaderList {
  const out: HeaderList = [];
  const h = record.httpHeaders?.headers;
  if (!h) return out;
  for (const [k, v] of h as Iterable<[string, string]>) {
    if (k.toLowerCase() === 'set-cookie' && 'getMultiple' in h) {
      const multi = (h as { getMultiple(n: string): string[] | undefined }).getMultiple(k);
      if (multi && multi.length > 1) {
        for (const m of multi) out.push([k, m]);
        continue;
      }
    }
    out.push([k, v]);
  }
  return out;
}

/** Reads one record (plain or gzip member) at a known offset and returns its HTTP status, headers and payload. */
export async function readResponseAt(file: string, span: Span): Promise<StoredResponse & { type: string }> {
  const buf = readSpan(file, span);
  const record = await WARCParser.parse([buf], { keepHeadersCase: true });
  if (!record) throw new Error(`no WARC record at ${file}:${span.offset}`);
  const body = Buffer.from(await record.readFully(false));
  const hs = record.httpHeaders;
  return {
    type: record.warcType,
    status: Number(hs?.statusCode ?? 200),
    statusText: hs?.statusText ?? '',
    headers: headerList(record),
    body,
  };
}

export async function readRequestAt(file: string, span: Span): Promise<{ headers: HeaderList; body: Buffer }> {
  const buf = readSpan(file, span);
  const record = await WARCParser.parse([buf], { keepHeadersCase: true });
  if (!record) throw new Error(`no WARC record at ${file}:${span.offset}`);
  const body = Buffer.from(await record.readFully(false));
  return { headers: headerList(record), body };
}

function readSpan(file: string, span: Span): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(span.length);
    fs.readSync(fd, buf, 0, span.length, span.offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** Iterates request/response pairs of any WARC (e.g. from ArchiveWeb.page) as exchanges. */
export async function* readExchanges(file: string): AsyncGenerator<Exchange> {
  const stream = fs.createReadStream(file);
  let n = 0;
  const parser = new WARCParser(stream, { keepHeadersCase: true });
  const responses: Exchange[] = [];
  const byRespId = new Map<string, Exchange>();
  const requests: { concurrentTo?: string; url: string; method: string; headers: HeaderList; body: Buffer }[] = [];
  for await (const record of parser) {
    const type = record.warcType;
    if (type === 'response' || type === 'revisit') {
      const hs = record.httpHeaders;
      const body = type === 'response' ? Buffer.from(await record.readFully(false)) : Buffer.alloc(0);
      const headers = headerList(record);
      const enc = header(headers, 'content-encoding');
      const ex: Exchange = {
        id: `w${n++}`,
        ts: record.warcDate ?? new Date().toISOString(),
        method: 'GET',
        url: record.warcTargetURI ?? '',
        httpVersion: 'HTTP/1.1',
        reqHeaders: [],
        status: Number(hs?.statusCode ?? 200),
        statusText: hs?.statusText ?? '',
        respHeaders: headers,
        respBody: body,
        originalContentEncoding: enc,
      };
      responses.push(ex);
      byRespId.set(record.warcHeader('WARC-Record-ID') ?? '', ex);
    } else if (type === 'request') {
      const hs = record.httpHeaders;
      requests.push({
        concurrentTo: record.warcHeader('WARC-Concurrent-To') ?? undefined,
        url: record.warcTargetURI ?? '',
        method: hs?.method ?? 'GET',
        headers: headerList(record),
        body: Buffer.from(await record.readFully(false)),
      });
    } else {
      await record.skipFully();
    }
  }
  for (const r of requests) {
    const ex = (r.concurrentTo && byRespId.get(r.concurrentTo)) || responses.find((e) => e.url === r.url && e.reqHeaders.length === 0);
    if (!ex) continue;
    ex.method = r.method.toUpperCase();
    ex.reqHeaders = r.headers;
    ex.reqBody = r.body.length ? r.body : undefined;
  }
  for (const ex of responses) yield ex;
}
