import { createHash } from 'node:crypto';
import type { HeaderList } from '../core/types';

/**
 * Page clock shim: shifts `Date` in replayed HTML documents to the recording time, so countdowns
 * and "deal ends in" logic behave as they did during capture. Time keeps flowing from that point.
 * Done in the proxy rather than with libfaketime, which breaks Chromium's CDP in practice and
 * would not reach agents that bring their own browser.
 */
export function clockScript(recordedMs: number): string {
  return (
    '(function(){if(window.__rrClock)return;window.__rrClock=1;' +
    `var D=Date,o=${recordedMs}-D.now();` +
    'function F(){if(!(this instanceof F))return new D(D.now()+o).toString();' +
    'if(arguments.length===0)return new D(D.now()+o);' +
    'return new (Function.prototype.bind.apply(D,[null].concat([].slice.call(arguments))))();}' +
    'F.prototype=D.prototype;F.now=function(){return D.now()+o};F.parse=D.parse;F.UTC=D.UTC;' +
    "try{Object.defineProperty(F,'name',{value:'Date'})}catch(e){}window.Date=F;})();"
  );
}

/** Inserts the shim at the top of <head> (or the document) and lets it through any CSP. */
export function injectClock(html: string, headers: HeaderList, recordedMs: number): { html: string; headers: HeaderList } {
  if (html.includes('__rrClock')) return { html, headers };
  const script = clockScript(recordedMs);
  const tag = `<script>${script}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  const out = head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
  const hash = `'sha256-${createHash('sha256').update(script).digest('base64')}'`;
  const patched = headers.map(([k, v]): [string, string] => (k.toLowerCase() === 'content-security-policy' ? [k, allowScriptHash(v, hash)] : [k, v]));
  return { html: out, headers: patched };
}

/**
 * Lets the shim through script-src / script-src-elem. When a directive allows 'unsafe-inline' and
 * has no hash or nonce, it is left alone: adding a hash would switch 'unsafe-inline' off for the
 * page's own inline scripts.
 */
export function allowScriptHash(csp: string, hash: string): string {
  const directives = csp.split(';').map((d) => d.trim()).filter(Boolean);
  if (!directives.some((d) => /^script-src(-elem)?(\s|$)/i.test(d))) {
    const fallback = directives.find((d) => /^default-src(\s|$)/i.test(d));
    // only default-src governs scripts: derive a script-src from it that also allows the shim
    if (fallback && !/'unsafe-inline'/i.test(fallback)) directives.push(fallback.replace(/^default-src/i, 'script-src') + ' ' + hash);
    return directives.join('; ');
  }
  return directives
    .map((d) => {
      const directive = d.trim();
      if (!/^script-src(-elem)?(\s|$)/i.test(directive)) return directive;
      const hasHashOrNonce = /'(nonce|sha256|sha384|sha512)-/i.test(directive);
      if (/'unsafe-inline'/i.test(directive) && !hasHashOrNonce) return directive;
      return `${directive} ${hash}`;
    })
    .join('; ');
}
