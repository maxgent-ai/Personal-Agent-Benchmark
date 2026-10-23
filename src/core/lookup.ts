import { normalizeText, type NormalizedRequest } from './normalize';
import type { IndexedEntry, RecordStore } from './store';
import { jaccard, tokens } from './util';

export interface LookupResult {
  source: 'exact' | 'fuzzy' | 'search' | 'promo';
  ix: IndexedEntry;
  detail?: string;
}

const DEFAULT_SIMILARITY = 0.6;
const DEFAULT_FUZZY_MIN = 0.5;

/**
 * The lookup ladder: exact key, then free-text (search / promo), then same-path fuzzy.
 * When a key was recorded several times, the earliest recording wins ("browse first, act later").
 */
export function lookup(store: RecordStore, norm: NormalizedRequest): LookupResult | undefined {
  const exact = store.byKey.get(norm.key);
  if (exact && exact.length) return { source: 'exact', ix: exact[0] };

  const sameEndpoint = (store.byPathKey.get(norm.pathKey) ?? []).filter((ix) => ix.entry.status !== 0);

  if (norm.kind === 'search' && norm.text !== undefined) {
    const found = bestSearch(sameEndpoint, norm);
    if (found) return found;
  }

  if (norm.kind === 'promo') {
    const code = norm.text ?? '';
    const same = sameEndpoint.find((ix) => ix.norm.text === code);
    if (same) return { source: 'promo', ix: same, detail: 'known-code' };
    const invalid = norm.endpoint?.invalid_code ? normalizeText(norm.endpoint.invalid_code) : undefined;
    const fallback = invalid !== undefined ? sameEndpoint.find((ix) => ix.norm.text === invalid) : undefined;
    if (fallback) return { source: 'promo', ix: fallback, detail: 'unknown-code' };
    return undefined;
  }

  const fuzzyAllowed = norm.endpoint?.fuzzy ?? norm.bodyKey === '';
  if (!fuzzyAllowed || sameEndpoint.length === 0) return undefined;
  const min = norm.endpoint?.fuzzy_min ?? (norm.kind === 'static' ? 0 : DEFAULT_FUZZY_MIN);
  let best: { ix: IndexedEntry; score: number } | undefined;
  for (const ix of sameEndpoint) {
    const score = paramOverlap(norm.params, ix.norm.params);
    if (score < min) continue;
    if (!best || score > best.score) best = { ix, score };
  }
  return best ? { source: 'fuzzy', ix: best.ix, detail: `overlap=${best.score.toFixed(2)}` } : undefined;
}

function bestSearch(candidates: IndexedEntry[], norm: NormalizedRequest): LookupResult | undefined {
  const want = tokens(norm.text ?? '');
  const textParam = norm.endpoint?.text_param;
  const others = norm.params.filter(([k]) => k !== textParam);
  const threshold = norm.endpoint?.similarity ?? DEFAULT_SIMILARITY;
  let best: { ix: IndexedEntry; score: number } | undefined;
  for (const ix of candidates) {
    if (ix.norm.text === undefined) continue;
    const sim = jaccard(want, tokens(ix.norm.text));
    if (sim < threshold) continue;
    const rest = paramOverlap(others, ix.norm.params.filter(([k]) => k !== textParam));
    const score = sim + rest * 0.01;
    if (!best || score > best.score) best = { ix, score };
  }
  return best ? { source: 'search', ix: best.ix, detail: `similarity=${best.score.toFixed(2)}` } : undefined;
}

/** Share of parameters (by name) whose values agree; 1 when neither side has parameters. */
export function paramOverlap(a: [string, string][], b: [string, string][]): number {
  const ma = new Map(a);
  const mb = new Map(b);
  const names = new Set([...ma.keys(), ...mb.keys()]);
  if (names.size === 0) return 1;
  let same = 0;
  for (const n of names) if (ma.has(n) && ma.get(n) === mb.get(n)) same++;
  return same / names.size;
}
