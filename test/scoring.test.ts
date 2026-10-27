import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Bundle } from '../src/core/bundle';
import { RuleSet } from '../src/core/rules';
import { readJsonl } from '../src/core/util';
import type { Grading } from '../src/grading';
import type { Judge, JudgeRequest } from '../src/judge';
import { ReplayEngine } from '../src/replay/engine';
import { scoreRun, writeRun, type LogLine } from '../src/scoring';
import { tmpDir } from './helpers';
import { buildShopBundle } from './shop-fixture';

const line = (l: Partial<LogLine> & { url: string }): LogLine => {
  const u = new URL(l.url);
  return { t: '2026-11-05T10:00:00.000Z', method: 'GET', key: `${l.method ?? 'GET'} ${u.host}${u.pathname}`, class: 'document', dest: 'document', source: 'exact', status: 200, ...l };
};

const LOG: LogLine[] = [
  line({ url: 'https://shop.test/' }),
  line({ url: 'https://shop.test/p/123?utm=a', key: 'GET shop.test/p/123', source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/p/123?utm=b', key: 'GET shop.test/p/123', source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/gone', status: 404 }),
  line({ url: 'https://shop.test/rr-not-found-x', status: 404 }),
  line({ url: 'https://shop.test/old-log-page', dest: undefined, source: 'miss', status: 404 }),
  line({ url: 'https://ads.test/frame', dest: 'iframe', source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/app.js', class: 'static', dest: 'script', source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/site.css', class: 'static', dest: 'style', source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/bundle.js', dest: undefined, source: 'miss', status: 404 }),
  line({ url: 'https://shop.test/api/price', class: 'xhr', dest: 'empty', source: 'miss', status: 404 }),
  line({ url: 'https://track.test/go', class: 'tracker', source: 'blocked', status: 204 }),
  line({ method: 'POST', url: 'https://shop.test/cart/add', class: 'xhr', dest: 'empty' }),
];

const GRADING: Grading = {
  extract: { price: { type: 'money', description: 'lowest price' } },
  require: [{ field: 'price', equals: 278 }],
  checks: [
    { id: 'right_product', question: 'Is it the right product?' },
    { id: 'shipping', question: 'Does it mention shipping?', weight: 1 },
    { id: 'coupons', question: 'Does it look for coupons?', weight: 1 },
  ],
  trace: [
    { id: 'added_to_cart', must: { method: 'POST', url: '*/cart/add*', hit: true } },
    { id: 'no_order', must_not: { method: 'POST', url: '*/checkout/place*' } },
  ],
};

function stubJudge(output: unknown, asked: JudgeRequest[] = []): Judge {
  return { via: 'stub', model: 'stub-model', ask: async (req) => (asked.push(req), { output, model: 'stub-model-1' }) };
}

const run = (judge: Judge, answer: string | undefined = 'Best Buy has it for $278.00 <b>with free shipping</b>.') =>
  scoreRun({ task: { id: 'shop', prompt: 'Find the lowest price.' }, grading: GRADING, answer, log: LOG, rules: RuleSet.load([]), probes: ['https://shop.test/rr-not-found-x'], judge });

test('a run is scored from the answer and the replay log; only pages in tabs that came back 404 are listed', async () => {
  const asked: JudgeRequest[] = [];
  const reply = { fields: { price: 278.004 }, checks: { right_product: { reason: 'names the model', pass: true }, shipping: { reason: 'says free shipping', pass: true }, coupons: { reason: 'no coupons', pass: false } } };
  const r = await run(stubJudge(reply, asked));

  assert.equal(r.score, 0.5);
  assert.deepEqual(r.grader, { via: 'stub', model: 'stub-model-1' });
  assert.deepEqual(r.items.map((i) => `${i.id}:${i.passed}`), ['price:true', 'right_product:true', 'shipping:true', 'coupons:false', 'added_to_cart:true', 'no_order:true']);
  // the grader is asked for every field and question, each answer required by the schema
  const schema = asked[0].schema as { properties: { fields: { required: string[] }; checks: { required: string[] } } };
  assert.deepEqual(schema.properties.fields.required, ['price']);
  assert.deepEqual(schema.properties.checks.required, ['right_product', 'shipping', 'coupons']);
  assert.match(asked[0].prompt, /Find the lowest price/);

  const notFound = r.pages.not_found.map((p) => `${p.route} x${p.count} ${p.source}`);
  assert.deepEqual(notFound, ['shop.test/p/123 x2 miss', 'shop.test/gone x1 exact', 'shop.test/old-log-page x1 miss']);
  assert.equal(r.pages.not_found[0].url, 'https://shop.test/p/123?utm=a');
  // a blocked navigation is still a page the agent opened, though not a 404
  assert.deepEqual(r.pages.opened.map((p) => p.route), ['shop.test/', 'shop.test/p/123', 'shop.test/gone', 'shop.test/old-log-page', 'track.test/go']);
});

test('a failed required item scores 0; a missing value fails its requirement', async () => {
  const r = await run(stubJudge({ fields: { price: null }, checks: { right_product: { reason: 'ok', pass: true }, shipping: { reason: 'ok', pass: true }, coupons: { reason: 'ok', pass: true } } }));
  assert.equal(r.score, 0);
  assert.deepEqual(r.items[0], { kind: 'require', id: 'price', test: 'price equals 278', required: true, passed: false, reason: 'not stated in the answer' });
});

test('result.json and report.html are written together, even when the run could not be graded', async () => {
  const failing: Judge = { via: 'stub', model: 'stub-model', ask: async () => { throw new Error('network down'); } };
  const r = await run(failing);
  assert.equal(r.score, undefined);
  assert.match(r.notes.join(), /the grader failed \(network down\)/);
  assert.equal(r.pages.not_found.length, 3);

  const dir = tmpDir();
  const files = writeRun(r, path.join(dir, 'run'));
  const saved = JSON.parse(fs.readFileSync(files.json, 'utf8'));
  assert.deepEqual(saved.pages, r.pages);
  const html = fs.readFileSync(files.html, 'utf8');
  assert.match(html, /Pages that returned 404/);
  assert.match(html, /shop\.test\/p\/123/);
  assert.match(html, /not recorded/);
  assert.match(html, /recorded as 404/);
  assert.match(html, /&lt;b&gt;with free shipping&lt;\/b&gt;/);
  assert.doesNotMatch(html, /app\.js|site\.css|ads\.test/);

  const ungraded = await scoreRun({ task: { id: 'shop' }, log: LOG, rules: RuleSet.load([]) });
  assert.match(ungraded.notes.join(), /no grading\.yaml/);
});

test('the replay log tells pages in tabs from frames, so a replay run lists its own 404 pages', async () => {
  const dir = await buildShopBundle();
  const logFile = path.join(tmpDir(), 'replay.jsonl');
  const engine = new ReplayEngine(dir, { logFile });
  await engine.warmUp();
  const open = (url: string, dest: string) => engine.handle({ method: 'GET', url, headers: { accept: 'text/html', 'sec-fetch-dest': dest } });
  await open('https://shop.test/', 'document');
  await open('https://shop.test/never-recorded', 'document');
  await open('https://shop.test/widget-frame', 'iframe');
  await open('https://shop.test/missing.css', 'style');

  const log = readJsonl<LogLine>(logFile);
  assert.deepEqual(log.map((l) => l.dest), ['document', 'document', 'iframe', 'style']);
  const r = await scoreRun({ task: { id: 'shop' }, log, rules: RuleSet.load([new Bundle(dir).rulesDir]), probes: Object.values(engine.manifest.not_found) });
  assert.deepEqual(r.pages.opened.map((p) => `${p.status} ${p.route}`), ['200 shop.test/', '404 shop.test/never-recorded']);
  assert.deepEqual(r.pages.not_found.map((p) => `${p.site} ${p.source}`), ['shop miss']);
});
