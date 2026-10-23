import * as fs from 'node:fs';
import * as cheerio from 'cheerio';
import YAML from 'yaml';
import { parseBody, readField, type NormalizedRequest, type RequestInput } from '../normalize';
import type { IndexedEntry, RecordStore } from '../store';
import type { StoredResponse } from '../types';
import { globToRegExp, mimeOf, setHeader } from '../util';
import {
  addItem,
  computeTotals,
  emptyState,
  parseMoney,
  setQty,
  type CartState,
  type PricingRules,
  type Totals,
} from './pricing';
import { renderTemplate } from './template';

export interface FieldRef {
  from: 'query' | 'body' | 'capture' | 'const';
  /** Field name; for body fields `*` matches any characters, e.g. "quantity.*". */
  field?: string;
  value?: string | number;
  default?: string | number;
}

/** A request that changes the cart, e.g. add-to-cart or a quantity change. */
export interface StateOp {
  endpoint: string;
  op: 'add' | 'set_qty' | 'remove' | 'apply_code' | 'clear';
  item?: FieldRef;
  qty?: FieldRef;
  code?: FieldRef;
  /** "recorded": answer with the recorded response; "view": answer with a computed view. */
  respond?: 'recorded' | 'view';
  view?: string;
}

export interface SetOp {
  /** CSS selector; ":self" means the current line row. */
  selector: string;
  value?: string;
  attr?: string;
  html?: boolean;
  remove?: boolean;
}

export interface TemplateRef {
  url?: string;
  url_contains?: string;
  /** Only recordings whose body contains this text, e.g. to tell an empty cart from a full one. */
  contains?: string;
  method?: string;
  pick?: 'first' | 'last' | number;
}

/** A page or API response whose numbers depend on the cart; rendered from a recorded template. */
export interface View {
  name: string;
  endpoint: string;
  type: 'html' | 'json';
  template: TemplateRef;
  empty_template?: TemplateRef;
  status?: number;
  set?: SetOp[];
  lines?: { row: string; set: SetOp[] };
  json_set?: { path: string; value: string; as?: 'number' | 'string' }[];
  json_lines?: { path: string; item: Record<string, string> };
}

export interface Sample {
  name: string;
  state: CartState;
  expect?: Partial<Record<'subtotal' | 'discount' | 'shipping' | 'tax' | 'total' | 'count', number>>;
  page?: TemplateRef;
  extract?: Partial<Record<'subtotal' | 'discount' | 'shipping' | 'tax' | 'total' | 'count', string>>;
}

export interface ComputeConfig extends PricingRules {
  initial_state?: CartState;
  ops?: StateOp[];
  views?: View[];
  /** Set operations applied to every HTML document of a site, e.g. the header cart badge. */
  decorate?: { site?: string; set: SetOp[] }[];
  samples?: Sample[];
}

export interface SampleResult {
  name: string;
  ok: boolean;
  computed: Totals;
  checks: { field: string; expected: number; computed: number; ok: boolean; source: 'expect' | 'page' }[];
  error?: string;
}

/** Per-scenario computed endpoints: keeps cart state and renders cart/checkout pages from rules. */
export class ComputeModule {
  state: CartState;

  constructor(readonly config: ComputeConfig, private readonly store: RecordStore) {
    this.state = clone(config.initial_state ?? emptyState());
  }

  static load(store: RecordStore, file: string): ComputeModule | undefined {
    if (!fs.existsSync(file)) return undefined;
    const config = YAML.parse(fs.readFileSync(file, 'utf8')) as ComputeConfig;
    config.items = config.items ?? {};
    return new ComputeModule(config, store);
  }

  reset(): void {
    this.state = clone(this.config.initial_state ?? emptyState());
  }

  totals(): Totals {
    return computeTotals(this.state, this.config);
  }

  opFor(norm: NormalizedRequest): StateOp | undefined {
    const name = norm.endpoint?.name;
    return name ? this.config.ops?.find((o) => o.endpoint === name) : undefined;
  }

  viewFor(norm: NormalizedRequest): View | undefined {
    const name = norm.endpoint?.name;
    return name ? this.config.views?.find((v) => v.endpoint === name) : undefined;
  }

  view(name: string): View | undefined {
    return this.config.views?.find((v) => v.name === name);
  }

  apply(op: StateOp, input: RequestInput, norm: NormalizedRequest): string {
    const item = op.item ? str(this.field(op.item, input, norm)) : undefined;
    const qtyRaw = op.qty ? this.field(op.qty, input, norm) : undefined;
    const qty = qtyRaw === undefined || qtyRaw === '' ? 1 : Math.max(0, parseInt(String(qtyRaw), 10) || 0);
    switch (op.op) {
      case 'add':
        if (!item) return 'add: no item';
        addItem(this.state, item, qty);
        return `add ${item} x${qty}`;
      case 'set_qty':
        if (!item) return 'set_qty: no item';
        setQty(this.state, item, qty);
        return `set ${item} =${qty}`;
      case 'remove':
        if (!item) return 'remove: no item';
        setQty(this.state, item, 0);
        return `remove ${item}`;
      case 'apply_code': {
        const code = op.code ? str(this.field(op.code, input, norm)) : undefined;
        if (code && !this.state.codes.includes(code)) this.state.codes.push(code);
        return `code ${code ?? ''}`;
      }
      case 'clear':
        this.state = emptyState();
        return 'clear';
    }
  }

  async render(view: View): Promise<StoredResponse> {
    const totals = this.totals();
    const useEmpty = totals.count === 0 && view.empty_template;
    const ix = await this.pickTemplate(useEmpty ? view.empty_template! : view.template);
    if (!ix) throw new Error(`view ${view.name}: no recorded template matches`);
    const base = await this.store.response(ix);
    if (useEmpty) return base;
    const ctx = { ...totals, symbol: this.config.symbol ?? '$' };
    let body: string;
    if (view.type === 'json') {
      body = this.renderJson(view, base.body.toString('utf8'), ctx);
    } else {
      const $ = cheerio.load(base.body.toString('utf8'));
      for (const op of view.set ?? []) this.applySet($, null, op, ctx);
      if (view.lines) this.renderLines($, view.lines, totals, ctx);
      body = $.html();
    }
    const buf = Buffer.from(body, 'utf8');
    return { status: view.status ?? base.status, statusText: base.statusText, headers: setHeader(base.headers, 'Content-Length', String(buf.length)), body: buf };
  }

  /** Applies site-wide decorations (e.g. the cart badge) to a recorded HTML document. */
  decorate(norm: NormalizedRequest, resp: StoredResponse): StoredResponse {
    const rules = (this.config.decorate ?? []).filter((d) => !d.site || d.site === norm.site?.site);
    if (!rules.length || mimeOf(resp.headers) !== 'text/html') return resp;
    const $ = cheerio.load(resp.body.toString('utf8'));
    const ctx = { ...this.totals(), symbol: this.config.symbol ?? '$' };
    let touched = false;
    for (const d of rules) {
      for (const op of d.set) {
        if ($(op.selector).length) {
          this.applySet($, null, op, ctx);
          touched = true;
        }
      }
    }
    if (!touched) return resp;
    const buf = Buffer.from($.html(), 'utf8');
    return { ...resp, headers: setHeader(resp.headers, 'Content-Length', String(buf.length)), body: buf };
  }

  async checkSamples(): Promise<SampleResult[]> {
    const results: SampleResult[] = [];
    for (const sample of this.config.samples ?? []) {
      const computed = computeTotals(sample.state, this.config);
      const checks: SampleResult['checks'] = [];
      try {
        for (const [field, expected] of Object.entries(sample.expect ?? {})) {
          const got = Number((computed as unknown as Record<string, number>)[field]);
          checks.push({ field, expected: expected as number, computed: got, ok: Math.abs(got - (expected as number)) < 0.005, source: 'expect' });
        }
        if (sample.page && sample.extract) {
          const ix = await this.pickTemplate(sample.page);
          if (!ix) throw new Error('page not found in recording');
          const $ = cheerio.load((await this.store.response(ix)).body.toString('utf8'));
          for (const [field, selector] of Object.entries(sample.extract)) {
            const text = $(selector as string).first().text();
            const expected = parseMoney(text);
            if (expected === undefined) throw new Error(`no number at ${selector} (${field})`);
            const got = Number((computed as unknown as Record<string, number>)[field]);
            checks.push({ field, expected, computed: got, ok: Math.abs(got - expected) < 0.005, source: 'page' });
          }
        }
        results.push({ name: sample.name, ok: checks.length > 0 && checks.every((c) => c.ok), computed, checks });
      } catch (err) {
        results.push({ name: sample.name, ok: false, computed, checks, error: (err as Error).message });
      }
    }
    return results;
  }

  async pickTemplate(ref: TemplateRef): Promise<IndexedEntry | undefined> {
    const method = (ref.method ?? 'GET').toUpperCase();
    let hits = this.store.all.filter(
      (ix) =>
        ix.entry.method === method &&
        ix.entry.status >= 200 &&
        ix.entry.status < 300 &&
        (ref.url ? ix.entry.url === ref.url : true) &&
        (ref.url_contains ? ix.entry.url.includes(ref.url_contains) : true),
    );
    if (ref.contains) {
      const keep: IndexedEntry[] = [];
      for (const ix of hits) if ((await this.store.response(ix)).body.includes(ref.contains)) keep.push(ix);
      hits = keep;
    }
    if (!hits.length) return undefined;
    if (ref.pick === 'last') return hits[hits.length - 1];
    if (typeof ref.pick === 'number') return hits[Math.min(ref.pick, hits.length - 1)];
    return hits[0];
  }

  private field(ref: FieldRef, input: RequestInput, norm: NormalizedRequest): string | number | undefined {
    let v: string | number | undefined;
    if (ref.from === 'const') v = ref.value;
    else if (ref.from === 'capture') v = ref.field ? norm.captures[ref.field] : undefined;
    else if (ref.from === 'body' && ref.field?.includes('*')) {
      const body = parseBody(input.contentType, input.body);
      const re = globToRegExp(ref.field);
      if (body.kind === 'fields') {
        const key = Object.keys(body.fields).find((k) => re.test(k));
        const raw = key === undefined ? undefined : body.fields[key];
        v = Array.isArray(raw) ? String(raw[0]) : raw === undefined || raw === null ? undefined : String(raw);
      }
    } else v = ref.field ? readField(input, ref.from, ref.field) : undefined;
    return v === undefined || v === '' ? ref.default : v;
  }

  private applySet($: cheerio.CheerioAPI, root: cheerio.Cheerio<any> | null, op: SetOp, ctx: Record<string, unknown>): void {
    const els = op.selector === ':self' && root ? root : root ? root.find(op.selector) : $(op.selector);
    if (op.remove) {
      els.remove();
      return;
    }
    const value = renderTemplate(op.value ?? '', ctx, this.config.symbol ?? '$');
    els.each((_, el) => {
      const e = $(el);
      if (op.attr) e.attr(op.attr, value);
      else if (op.html) e.html(value);
      else e.text(value);
    });
  }

  private renderLines($: cheerio.CheerioAPI, spec: { row: string; set: SetOp[] }, totals: Totals, ctx: Record<string, unknown>): void {
    const rows = $(spec.row);
    if (!rows.length) return;
    const first = rows.first();
    const template = first.clone();
    for (const line of totals.lines) {
      const row = template.clone();
      for (const op of spec.set) this.applySet($, row, op, { ...ctx, line });
      first.before(row);
    }
    rows.remove();
  }

  private renderJson(view: View, text: string, ctx: Record<string, unknown>): string {
    const doc = JSON.parse(text);
    for (const s of view.json_set ?? []) {
      const raw = renderTemplate(s.value, ctx, this.config.symbol ?? '$');
      setPath(doc, s.path, s.as === 'number' ? Number(raw) : raw);
    }
    if (view.json_lines) {
      const lines = (ctx.lines as Totals['lines']).map((line) => {
        const out: Record<string, unknown> = {};
        for (const [k, tpl] of Object.entries(view.json_lines!.item)) {
          const raw = renderTemplate(tpl, { ...ctx, line }, this.config.symbol ?? '$');
          out[k] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
        }
        return out;
      });
      setPath(doc, view.json_lines.path, lines);
    }
    return JSON.stringify(doc);
  }
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function str(v: string | number | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
