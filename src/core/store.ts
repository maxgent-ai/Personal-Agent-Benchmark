import type { Bundle } from './bundle';
import { normalizeRequest, type NormalizedRequest } from './normalize';
import type { RuleSet } from './rules';
import type { Entry, StoredResponse } from './types';
import { readResponseAt } from './warc';

export interface IndexedEntry {
  entry: Entry;
  norm: NormalizedRequest;
  order: number;
}

const CACHE_LIMIT_BYTES = 256 * 1024 * 1024;

/** In-memory index over a bundle. Keys are recomputed from the current rules at load time. */
export class RecordStore {
  readonly byKey = new Map<string, IndexedEntry[]>();
  readonly byPathKey = new Map<string, IndexedEntry[]>();
  readonly byId = new Map<string, IndexedEntry>();
  readonly all: IndexedEntry[] = [];
  private readonly cache = new Map<string, StoredResponse>();
  private cacheBytes = 0;

  constructor(readonly bundle: Bundle, readonly rules: RuleSet) {
    const entries = bundle.entries().map((entry, i) => ({ entry, i }));
    entries.sort((a, b) => (a.entry.ts === b.entry.ts ? a.i - b.i : a.entry.ts < b.entry.ts ? -1 : 1));
    entries.forEach(({ entry }, order) => {
      const norm = this.normalizeEntry(entry);
      const ix: IndexedEntry = { entry, norm, order };
      this.all.push(ix);
      this.byId.set(entry.id, ix);
      push(this.byKey, norm.key, ix);
      push(this.byPathKey, norm.pathKey, ix);
    });
  }

  normalizeEntry(entry: Entry): NormalizedRequest {
    return normalizeRequest(
      {
        method: entry.method,
        url: entry.url,
        contentType: entry.reqContentType,
        body: entry.reqBody ? Buffer.from(entry.reqBody, 'base64') : undefined,
      },
      this.rules,
    );
  }

  /** Earliest recorded exchange for a URL (exact string match), optionally by method. */
  findByUrl(url: string, method = 'GET'): IndexedEntry | undefined {
    return this.all.find((ix) => ix.entry.url === url && ix.entry.method === method);
  }

  async response(ix: IndexedEntry): Promise<StoredResponse> {
    const cached = this.cache.get(ix.entry.id);
    if (cached) return cached;
    const own = await readResponseAt(this.bundle.archivePath, { offset: ix.entry.respOffset, length: ix.entry.respLength });
    let body = own.body;
    if (ix.entry.revisitOf) {
      const original = this.byId.get(ix.entry.revisitOf);
      if (!original) throw new Error(`revisit target missing: ${ix.entry.revisitOf}`);
      body = (await this.response(original)).body;
    }
    const resp: StoredResponse = { status: own.status, statusText: own.statusText, headers: own.headers, body };
    this.remember(ix.entry.id, resp);
    return resp;
  }

  private remember(id: string, resp: StoredResponse): void {
    this.cache.set(id, resp);
    this.cacheBytes += resp.body.length;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= CACHE_LIMIT_BYTES) break;
      this.cache.delete(k);
      this.cacheBytes -= v.body.length;
    }
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
