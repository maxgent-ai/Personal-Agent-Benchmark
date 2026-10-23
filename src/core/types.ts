export type HeaderList = [string, string][];

/** One HTTP request/response pair as captured from a real site. */
export interface Exchange {
  id: string;
  ts: string;
  method: string;
  url: string;
  httpVersion: string;
  reqHeaders: HeaderList;
  reqBody?: Buffer;
  status: number;
  statusText: string;
  respHeaders: HeaderList;
  respBody: Buffer;
  /** Content-Encoding the site used on the wire; the stored body is already decoded. */
  originalContentEncoding?: string;
  resourceType?: string;
}

/** Index row for one exchange inside a bundle (indexes/entries.jsonl). */
export interface Entry {
  id: string;
  ts: string;
  method: string;
  url: string;
  status: number;
  mime: string;
  resourceType?: string;
  reqContentType?: string;
  /** Request body, base64, kept inline so keys can be recomputed without reading the WARC. */
  reqBody?: string;
  digest: string;
  size: number;
  reqOffset: number;
  reqLength: number;
  respOffset: number;
  respLength: number;
  /** Set when this response was stored as a revisit of an identical earlier payload. */
  revisitOf?: string;
}

export type Kind = 'browse' | 'search' | 'promo' | 'stateful' | 'computed' | 'block' | 'static';

export interface EndpointRule {
  name: string;
  /** "METHOD /path/pattern" or "/path/pattern"; `*` one segment, `**` any segments, `{x}` captures one segment. */
  match: string;
  /** Host glob this endpoint is limited to; defaults to any host of the site. */
  host?: string;
  /** Template for the normalized path, e.g. "/dp/{asin}". */
  key?: string;
  kind?: Kind;
  keep_params?: string[];
  drop_params?: string[];
  body_keep?: string[];
  body_drop?: string[];
  /** Query or body field holding free text (search) or a code (promo). */
  text_param?: string;
  /** Minimum token similarity for search matching (0-1). */
  similarity?: number;
  /** Allow same-path matching when the exact key is missing. GET defaults to true, bodies to false. */
  fuzzy?: boolean;
  /** Minimum share of query parameters that must agree for a fuzzy match. */
  fuzzy_min?: number;
  /** For promo endpoints: a code recorded as invalid, whose response answers unknown codes. */
  invalid_code?: string;
}

export interface SiteRules {
  site: string;
  hosts: string[];
  drop_params?: string[];
  body_drop?: string[];
  block?: string[];
  /** Never stored: bot checks and other pages that must not be replayed ("host/path" globs). */
  exclude?: string[];
  endpoints?: EndpointRule[];
  /** URL of this site's own 404 page recorded during capture. */
  not_found?: string;
  /** Body returned for missed API requests of this site. */
  xhr_not_found?: { content_type: string; body: string };
}

/** manifest.json: only what replay and import read. */
export interface Manifest {
  /** Benchmark task this recording belongs to (tasks/<task_id>/). */
  task_id: string;
  /** Page clocks start here during replay. */
  captured_from: string;
  captured_to: string;
  /** Each site's own 404 page, answered for documents replay cannot find. */
  not_found: Record<string, string>;
  /** Replay opens this page when nothing else is given. */
  start_url?: string;
  /** Replay browsers use the recording's language and time zone. */
  locale?: string;
  timezone?: string;
}

export interface StoredResponse {
  status: number;
  statusText: string;
  headers: HeaderList;
  body: Buffer;
}

export type Source =
  | 'exact'
  | 'fuzzy'
  | 'search'
  | 'promo'
  | 'computed'
  | 'blocked'
  | 'preflight'
  | 'control'
  | 'miss';

export type ResourceClass = 'document' | 'xhr' | 'static' | 'tracker';

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export interface ReplayResponse extends StoredResponse {
  source: Source;
  key: string;
  kind: Kind;
  resourceClass: ResourceClass;
  entryId?: string;
  detail?: string;
}
