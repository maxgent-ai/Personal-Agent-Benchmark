import { formatMoney } from './pricing';

/**
 * Tiny value templates for computed pages: "{{money subtotal}}", "{{count}}",
 * "{{plural count 'item' 'items'}}", "{{line.qty}}", "{{number tax_rate}}",
 * "{{money_sub subtotal 50}}" (difference, not below zero).
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>, symbol = '$'): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => evaluate(expr, ctx, symbol));
}

function evaluate(expr: string, ctx: Record<string, unknown>, symbol: string): string {
  const parts = splitArgs(expr);
  const [head, ...args] = parts;
  switch (head) {
    case 'money':
      return formatMoney(Number(resolve(args[0], ctx) ?? 0), symbol);
    case 'money_sub':
      return formatMoney(Math.max(0, Number(resolve(args[0], ctx) ?? 0) - Number(resolve(args[1], ctx) ?? 0)), symbol);
    case 'number':
      return String(Number(resolve(args[0], ctx) ?? 0));
    case 'fixed':
      return Number(resolve(args[0], ctx) ?? 0).toFixed(2);
    case 'plural':
      return Number(resolve(args[0], ctx)) === 1 ? unquote(args[1]) : unquote(args[2]);
    default: {
      const v = resolve(head, ctx);
      return v === undefined || v === null ? '' : String(v);
    }
  }
}

function splitArgs(expr: string): string[] {
  const out: string[] = [];
  const re = /'[^']*'|"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) out.push(m[0]);
  return out;
}

function unquote(s: string | undefined): string {
  if (!s) return '';
  return s.replace(/^['"]|['"]$/g, '');
}

function resolve(pathExpr: string | undefined, ctx: Record<string, unknown>): unknown {
  if (!pathExpr) return undefined;
  if (/^['"]/.test(pathExpr)) return unquote(pathExpr);
  if (/^-?\d+(\.\d+)?$/.test(pathExpr)) return Number(pathExpr);
  let cur: unknown = ctx;
  for (const part of pathExpr.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
