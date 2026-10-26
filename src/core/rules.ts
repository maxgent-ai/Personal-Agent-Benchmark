import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import type { EndpointRule, SiteRules } from './types';
import { globToRegExp, matchesAny } from './util';

const DEFAULT_SITE = '_default';

export interface EndpointMatch {
  endpoint: EndpointRule;
  captures: Record<string, string>;
}

/** Site rules for one bundle: `_default.yaml` plus one file per site. */
export class RuleSet {
  readonly defaults: SiteRules;
  readonly sites: SiteRules[];

  constructor(sites: SiteRules[]) {
    this.defaults = sites.find((s) => s.site === DEFAULT_SITE) ?? { site: DEFAULT_SITE, hosts: [] };
    this.sites = sites.filter((s) => s.site !== DEFAULT_SITE);
  }

  /**
   * Files for the same site are merged. Hand-written files (`<site>.yaml`) take precedence over
   * generated ones (`<site>.auto.yaml`) from any directory; among files of the same kind, later
   * directories win. Winning files' endpoints are tried first and their scalar settings kept;
   * lists are combined.
   */
  static load(dirs: string[]): RuleSet {
    const files: { file: string; rank: number }[] = [];
    dirs.forEach((dir, d) => {
      if (!dir || !fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/\.ya?ml$/.test(name) || name.includes('.draft.')) continue;
        files.push({ file: path.join(dir, name), rank: (/\.auto\.ya?ml$/.test(name) ? 0 : dirs.length) + d });
      }
    });
    files.sort((a, b) => b.rank - a.rank);
    const bySite = new Map<string, SiteRules>();
    for (const { file } of files) {
      const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as SiteRules;
      if (!parsed || !parsed.site) throw new Error(`rules file without "site": ${file}`);
      parsed.hosts = parsed.hosts ?? [];
      const prev = bySite.get(parsed.site);
      bySite.set(parsed.site, prev ? mergeSite(prev, parsed) : parsed);
    }
    return new RuleSet([...bySite.values()]);
  }

  siteFor(host: string): SiteRules | undefined {
    return this.sites.find((s) => matchesAny(host, s.hosts));
  }

  dropParams(site?: SiteRules, endpoint?: EndpointRule): string[] {
    return [...(this.defaults.drop_params ?? []), ...(site?.drop_params ?? []), ...(endpoint?.drop_params ?? [])];
  }

  bodyDrop(site?: SiteRules, endpoint?: EndpointRule): string[] {
    return [...(this.defaults.body_drop ?? []), ...(site?.body_drop ?? []), ...(endpoint?.body_drop ?? [])];
  }

  isBlocked(host: string, pathname: string, site?: SiteRules): boolean {
    const patterns = [...(this.defaults.block ?? []), ...(site?.block ?? [])];
    return patterns.some((p) => (p.includes('/') ? globToRegExp(p).test(host + pathname) : globToRegExp(p).test(host)));
  }

  /** True for URLs that must never be stored or replayed, such as bot-check pages. */
  isExcluded(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    const host = u.hostname.toLowerCase();
    const patterns = [...(this.defaults.exclude ?? []), ...(this.siteFor(host)?.exclude ?? [])];
    return patterns.some((p) => (p.includes('/') ? globToRegExp(p).test(host + u.pathname) : globToRegExp(p).test(host)));
  }

  /** True for pages answered with their last recording (see SiteRules.latest). */
  prefersLatest(host: string, pathname: string, site?: SiteRules): boolean {
    const patterns = [...(this.defaults.latest ?? []), ...(site?.latest ?? [])];
    return patterns.some((p) => (p.includes('/') ? globToRegExp(p).test(host + pathname) : globToRegExp(p).test(host)));
  }

  matchEndpoint(site: SiteRules | undefined, method: string, host: string, pathname: string): EndpointMatch | undefined {
    for (const endpoint of site?.endpoints ?? []) {
      if (endpoint.host && !globToRegExp(endpoint.host).test(host)) continue;
      const { method: m, pattern } = parseMatch(endpoint.match);
      if (m && m !== method) continue;
      const captures = matchPath(pattern, pathname);
      if (captures) return { endpoint, captures };
    }
    return undefined;
  }

  allEndpoints(): { site: SiteRules; endpoint: EndpointRule }[] {
    return this.sites.flatMap((site) => (site.endpoints ?? []).map((endpoint) => ({ site, endpoint })));
  }
}

/** `high` wins: its endpoints are tried first and its single values are kept; lists are unioned. */
function mergeSite(high: SiteRules, low: SiteRules): SiteRules {
  const union = (a?: string[], b?: string[]) => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);
  const names = new Set((high.endpoints ?? []).map((e) => e.name));
  return {
    ...low,
    ...high,
    hosts: union(high.hosts, low.hosts) ?? [],
    drop_params: union(high.drop_params, low.drop_params),
    body_drop: union(high.body_drop, low.body_drop),
    block: union(high.block, low.block),
    exclude: union(high.exclude, low.exclude),
    latest: union(high.latest, low.latest),
    endpoints: [...(high.endpoints ?? []), ...(low.endpoints ?? []).filter((e) => !names.has(e.name))],
  };
}

export function parseMatch(match: string): { method?: string; pattern: string } {
  const parts = match.trim().split(/\s+/);
  if (parts.length === 2) return { method: parts[0].toUpperCase(), pattern: parts[1] };
  return { pattern: parts[0] };
}

/** Match a path against a pattern; returns captured `{name}` segments or undefined. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
  const pat = pattern.split('/').filter(Boolean);
  const segs = pathname.split('/').filter(Boolean);
  const captures: Record<string, string> = {};
  const walk = (i: number, j: number): boolean => {
    if (i === pat.length) return j === segs.length;
    const p = pat[i];
    if (p === '**') {
      for (let k = j; k <= segs.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    if (j >= segs.length) return false;
    const capture = /^\{(\w+)\}$/.exec(p);
    if (capture) {
      captures[capture[1]] = decodeURIComponent(segs[j]);
      return walk(i + 1, j + 1);
    }
    if (p === '*' || globToRegExp(p).test(segs[j])) return walk(i + 1, j + 1);
    return false;
  };
  return walk(0, 0) ? captures : undefined;
}

export function fillTemplate(template: string, captures: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => captures[name] ?? '');
}
