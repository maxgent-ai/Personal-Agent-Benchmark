import * as fs from 'node:fs';
import type { Bundle } from './bundle';
import type { RuleSet } from './rules';
import type { Manifest } from './types';
import { readExchanges } from './warc';

export interface AuditFinding {
  check: string;
  detail: string;
}

const MANIFEST_KEYS: string[] = ['task_id', 'captured_from', 'captured_to', 'not_found', 'locale', 'timezone', 'format'] satisfies (keyof Manifest)[];
/** Written by recordings made before 2026-10-26; replay ignores it and the next import drops it. */
const LEGACY_MANIFEST_KEYS = ['start_url'];
const CREDENTIAL_REQUEST_HEADERS = ['cookie', 'authorization', 'proxy-authorization', 'x-amz-access-token'];

/**
 * Checks that a bundle is safe to publish: no credentials in stored requests, no live cookie
 * values in stored responses, no stored header lines that are not headers (a header sent several
 * times stored as one value joined by newlines hides every cookie after the first from the cookie
 * check), no pages the rules exclude (bot checks), and nothing in the manifest beyond what replay
 * reads (such as who recorded it).
 * Returns one finding per problem; an empty list means the bundle passed.
 */
export async function auditBundle(bundle: Bundle, rules: RuleSet): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  for (const f of [bundle.manifestPath, bundle.archivePath, bundle.entriesPath]) {
    if (!fs.existsSync(f)) findings.push({ check: 'files', detail: `missing ${f}` });
  }
  if (findings.length) return findings;

  const extra = Object.keys(bundle.manifest()).filter((k) => !MANIFEST_KEYS.includes(k) && !LEGACY_MANIFEST_KEYS.includes(k));
  if (extra.length) findings.push({ check: 'manifest', detail: `manifest.json records fields replay does not use: ${extra.join(', ')}` });

  const add = (check: string, detail: string) => {
    if (findings.filter((f) => f.check === check).length < 20) findings.push({ check, detail });
  };
  for await (const ex of readExchanges(bundle.archivePath)) {
    for (const [name] of ex.reqHeaders) {
      if (CREDENTIAL_REQUEST_HEADERS.includes(name.toLowerCase())) add('request-credentials', `${name} header on ${ex.method} ${ex.url}`);
    }
    if (ex.malformedHeaderLines) add('header-lines', `${ex.malformedHeaderLines} stored header lines are not headers (values joined by newlines?) on ${ex.method} ${ex.url}`);
    for (const [name, value] of ex.respHeaders) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      const cookieValue = value.split(';')[0].split('=').slice(1).join('=').trim();
      if (cookieValue && cookieValue !== 'REDACTED') add('response-cookies', `unredacted Set-Cookie on ${ex.url}`);
    }
    if (rules.isExcluded(ex.url)) add('excluded-pages', `excluded URL stored: ${ex.url}`);
  }
  return findings;
}
