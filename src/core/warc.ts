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

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CRLFCRLF = Buffer.from('\r\n\r\n');

/**
 * Header lines as stored, as a header list. Recorders before record-replay 0.5.5 kept a header the
 * site sent several times (Set-Cookie above all) as one value joined by newlines, as DevTools
 * reports it, and wrote it that way: each further value is a line of its own after the header's
 * line, ended by a bare newline, or by CRLF once the recording was rewritten. A line that is not a
 * header is taken as a further value of the header before it; `malformed` counts those lines (lines
 * before any header are left out).
 */
export function parseHeaderLines(lines: string[]): { headers: HeaderList; malformed: number } {
  const headers: HeaderList = [];
  let malformed = 0;
  let last: string | undefined;
  for (const line of lines) {
    // values joined to a line by bare newlines are never headers of their own
    for (const [i, part] of line.split(/\r?\n|\r/).entries()) {
      const colon = part.indexOf(':');
      const name = colon > 0 ? part.slice(0, colon) : '';
      if (i === 0 && HEADER_NAME.test(name)) {
        headers.push([name, part.slice(colon + 1).trim()]);
        last = name;
        continue;
      }
      malformed++;
      if (last && part.trim()) headers.push([last, part.trim()]);
    }
  }
  return { headers, malformed };
}

interface HttpMessage {
  /** Status line of a response, request line of a request; empty when the record has none. */
  startLine: string;
  headers: HeaderList;
  /** Stored header lines that are not headers (see parseHeaderLines). */
  malformedHeaderLines: number;
  body: Buffer;
}

/**
 * The HTTP message stored in a record, read by its bytes: warcio's own parsing drops header lines
 * without a colon, so a malformed header could be neither repaired nor seen.
 */
function httpMessage(content: Buffer): HttpMessage {
  const end = content.indexOf(CRLFCRLF);
  const [startLine = '', ...lines] = (end < 0 ? content : content.subarray(0, end)).toString('utf8').split('\r\n');
  const { headers, malformed } = parseHeaderLines(lines.filter(Boolean));
  return { startLine, headers, malformedHeaderLines: malformed, body: end < 0 ? Buffer.alloc(0) : content.subarray(end + 4) };
}

/** Status of a stored response; a request that got no response is stored with status -1. */
function statusOf(startLine: string): { status: number; statusText: string } {
  const m = /^HTTP\/\S+ (-?\d+) ?(.*)$/.exec(startLine);
  return m ? { status: Number(m[1]), statusText: m[2] } : { status: 200, statusText: '' };
}

async function readRecordAt(file: string, span: Span): Promise<{ type: string; http: HttpMessage }> {
  const record = await WARCParser.parse([readSpan(file, span)], { keepHeadersCase: true, parseHttp: false });
  if (!record) throw new Error(`no WARC record at ${file}:${span.offset}`);
  return { type: record.warcType ?? '', http: httpMessage(Buffer.from(await record.readFully(false))) };
}

/** Reads one record (plain or gzip member) at a known offset and returns its HTTP status, headers and payload. */
export async function readResponseAt(file: string, span: Span): Promise<StoredResponse & { type: string; malformedHeaderLines: number }> {
  const { type, http } = await readRecordAt(file, span);
  return { type, ...statusOf(http.startLine), headers: http.headers, malformedHeaderLines: http.malformedHeaderLines, body: http.body };
}

export async function readRequestAt(file: string, span: Span): Promise<{ headers: HeaderList; malformedHeaderLines: number; body: Buffer }> {
  const { http } = await readRecordAt(file, span);
  return { headers: http.headers, malformedHeaderLines: http.malformedHeaderLines, body: http.body };
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
  const parser = new WARCParser(stream, { keepHeadersCase: true, parseHttp: false });
  const responses: Exchange[] = [];
  const byRespId = new Map<string, Exchange>();
  const requests: { concurrentTo?: string; url: string; method: string; headers: HeaderList; malformedHeaderLines: number; body: Buffer }[] = [];
  for await (const record of parser) {
    const type = record.warcType;
    if (type === 'response' || type === 'revisit') {
      const http = httpMessage(Buffer.from(await record.readFully(false)));
      const ex: Exchange = {
        id: `w${n++}`,
        ts: record.warcDate ?? new Date().toISOString(),
        method: 'GET',
        url: record.warcTargetURI ?? '',
        httpVersion: 'HTTP/1.1',
        reqHeaders: [],
        ...statusOf(http.startLine),
        respHeaders: http.headers,
        respBody: type === 'response' ? http.body : Buffer.alloc(0),
        originalContentEncoding: header(http.headers, 'content-encoding'),
        malformedHeaderLines: http.malformedHeaderLines,
      };
      responses.push(ex);
      byRespId.set(record.warcHeader('WARC-Record-ID') ?? '', ex);
    } else if (type === 'request') {
      const http = httpMessage(Buffer.from(await record.readFully(false)));
      requests.push({
        concurrentTo: record.warcHeader('WARC-Concurrent-To') ?? undefined,
        url: record.warcTargetURI ?? '',
        method: http.startLine.split(' ')[0] || 'GET',
        headers: http.headers,
        malformedHeaderLines: http.malformedHeaderLines,
        body: http.body,
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
    ex.malformedHeaderLines = (ex.malformedHeaderLines ?? 0) + r.malformedHeaderLines;
    ex.reqBody = r.body.length ? r.body : undefined;
  }
  for (const ex of responses) yield ex;
}
