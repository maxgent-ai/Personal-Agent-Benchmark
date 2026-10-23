/** Cart state kept for one replay run, and the pricing rules that turn it into totals. */

export interface CartLine {
  item: string;
  qty: number;
}

export interface CartState {
  lines: CartLine[];
  codes: string[];
}

export interface PricingItem {
  title?: string;
  price: number;
}

export interface Promotion {
  /** Without a code the promotion applies automatically. */
  code?: string;
  type: 'percent' | 'amount';
  value: number;
  min_subtotal?: number;
  /** Limit to these item ids; default all items. */
  items?: string[];
  /** Only the largest discount within one group applies. */
  group?: string;
}

export interface PricingRules {
  currency?: string;
  symbol?: string;
  items: Record<string, PricingItem>;
  tax?: { rate: number; rounding?: 'total' | 'line'; include_shipping?: boolean };
  shipping?: { fee: number; free_threshold?: number };
  promotions?: Promotion[];
}

export interface LineTotal {
  item: string;
  title: string;
  qty: number;
  unit: number;
  amount: number;
}

export interface Totals {
  lines: LineTotal[];
  count: number;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  codes: string[];
  unknownItems: string[];
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;

export function emptyState(): CartState {
  return { lines: [], codes: [] };
}

export function addItem(state: CartState, item: string, qty: number): void {
  const line = state.lines.find((l) => l.item === item);
  if (line) line.qty += qty;
  else state.lines.push({ item, qty });
  state.lines = state.lines.filter((l) => l.qty > 0);
}

export function setQty(state: CartState, item: string, qty: number): void {
  const line = state.lines.find((l) => l.item === item);
  if (line) line.qty = qty;
  else if (qty > 0) state.lines.push({ item, qty });
  state.lines = state.lines.filter((l) => l.qty > 0);
}

export function computeTotals(state: CartState, rules: PricingRules): Totals {
  const unknownItems: string[] = [];
  const lines: LineTotal[] = [];
  for (const l of state.lines) {
    const p = rules.items[l.item];
    if (!p) {
      unknownItems.push(l.item);
      continue;
    }
    lines.push({ item: l.item, title: p.title ?? l.item, qty: l.qty, unit: p.price, amount: dollars(cents(p.price) * l.qty) });
  }
  const subtotalC = lines.reduce((s, l) => s + cents(l.amount), 0);

  const applied: { promo: Promotion; amountC: number }[] = [];
  for (const promo of rules.promotions ?? []) {
    if (promo.code && !state.codes.some((c) => c.toLowerCase() === promo.code!.toLowerCase())) continue;
    if (promo.min_subtotal !== undefined && subtotalC < cents(promo.min_subtotal)) continue;
    const baseC = promo.items ? lines.filter((l) => promo.items!.includes(l.item)).reduce((s, l) => s + cents(l.amount), 0) : subtotalC;
    if (baseC <= 0) continue;
    const amountC = promo.type === 'percent' ? Math.round((baseC * promo.value) / 100) : Math.min(baseC, cents(promo.value));
    applied.push({ promo, amountC });
  }
  const byGroup = new Map<string, { promo: Promotion; amountC: number }>();
  const ungrouped: { promo: Promotion; amountC: number }[] = [];
  for (const a of applied) {
    if (!a.promo.group) ungrouped.push(a);
    else if (!byGroup.has(a.promo.group) || byGroup.get(a.promo.group)!.amountC < a.amountC) byGroup.set(a.promo.group, a);
  }
  const chosen = [...ungrouped, ...byGroup.values()];
  const discountC = Math.min(subtotalC, chosen.reduce((s, a) => s + a.amountC, 0));
  const afterDiscountC = subtotalC - discountC;

  let shippingC = 0;
  if (rules.shipping && lines.length) {
    const free = rules.shipping.free_threshold !== undefined && afterDiscountC >= cents(rules.shipping.free_threshold);
    shippingC = free ? 0 : cents(rules.shipping.fee);
  }

  let taxC = 0;
  if (rules.tax && rules.tax.rate) {
    const rate = rules.tax.rate;
    const shipBase = rules.tax.include_shipping ? shippingC : 0;
    if (rules.tax.rounding === 'line') {
      const lineTax = lines.reduce((s, l) => s + Math.round(cents(l.amount) * rate), 0);
      taxC = lineTax - Math.round(discountC * rate) + Math.round(shipBase * rate);
    } else {
      taxC = Math.round((afterDiscountC + shipBase) * rate);
    }
  }

  return {
    lines,
    count: lines.reduce((s, l) => s + l.qty, 0),
    subtotal: dollars(subtotalC),
    discount: dollars(discountC),
    shipping: dollars(shippingC),
    tax: dollars(taxC),
    total: dollars(afterDiscountC + shippingC + taxC),
    codes: chosen.map((a) => a.promo.code).filter((c): c is string => !!c),
    unknownItems,
  };
}

export function formatMoney(value: number, symbol = '$'): string {
  const fixed = Math.abs(value).toFixed(2);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (value < 0 ? '-' : '') + symbol + grouped + '.' + frac;
}

/** "$1,234.56" -> 1234.56 */
export function parseMoney(text: string): number | undefined {
  const m = /-?[\d,]+(?:\.\d+)?/.exec(text.replace(/\s/g, ''));
  if (!m) return undefined;
  return Number(m[0].replace(/,/g, ''));
}
