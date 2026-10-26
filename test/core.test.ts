import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Bundle } from '../src/core/bundle';
import { normalizeRequest } from '../src/core/normalize';
import { fillTemplate, matchPath, RuleSet } from '../src/core/rules';
import { RecordStore } from '../src/core/store';
import { readRequestAt, readResponseAt } from '../src/core/warc';
import { ReplayEngine } from '../src/replay/engine';
import { REPO_ROOT, tmpDir, writeFile } from './helpers';
import { buildShopBundle, PNG, SHOP_RULES } from './shop-fixture';

test('path patterns capture segments and fill key templates', () => {
  assert.deepEqual(matchPath('/*/dp/{asin}/**', '/Apple-AirPods/dp/B0TEST/ref=sr_1_1'), { asin: 'B0TEST' });
  assert.deepEqual(matchPath('/dp/{asin}/**', '/dp/B0TEST'), { asin: 'B0TEST' });
  assert.equal(matchPath('/dp/{asin}', '/gp/B0TEST'), undefined);
  assert.equal(fillTemplate('/dp/{asin}', { asin: 'X1' }), '/dp/X1');
});

test('normalization drops volatile params, applies key templates and keeps chosen body fields', () => {
  const dir = tmpDir();
  writeFile(path.join(dir, 'shop.yaml'), SHOP_RULES);
  fs.copyFileSync(path.join(REPO_ROOT, 'sites', '_default.yaml'), path.join(dir, '_default.yaml'));
  const rules = RuleSet.load([dir]);
  const a = normalizeRequest({ method: 'GET', url: 'https://shop.test/Foo/dp/B0TEST/ref=x?qid=1&th=1' }, rules);
  assert.equal(a.key, 'GET shop.test/dp/B0TEST?th=1');
  const s = normalizeRequest({ method: 'GET', url: 'https://shop.test/s?k=AirPods++PRO&ref=nb&qid=9' }, rules);
  assert.equal(s.key, 'GET shop.test/s?k=airpods pro');
  assert.equal(s.kind, 'search');
  const post = normalizeRequest({ method: 'POST', url: 'https://shop.test/cart/add', contentType: 'application/x-www-form-urlencoded', body: Buffer.from('quantity=2&ASIN=B0TEST&csrfToken=a') }, rules);
  assert.equal(post.key, 'POST shop.test/cart/add #body:{"ASIN":"B0TEST","quantity":"2"}');
  const json = normalizeRequest({ method: 'POST', url: 'https://shop.test/api/x', contentType: 'application/json', body: Buffer.from('{"q":1,"csrf_token":"z","nested":{"requestId":"r","v":2}}') }, rules);
  assert.equal(json.bodyKey, '{"nested":{"v":2},"q":1}');
  assert.equal(normalizeRequest({ method: 'GET', url: 'https://metrics.shop.test/p' }, rules).kind, 'block');
  assert.equal(normalizeRequest({ method: 'GET', url: 'https://www.google-analytics.com/collect?v=1' }, rules).kind, 'block');
  assert.equal(normalizeRequest({ method: 'GET', url: 'https://img.shop.test/a.png?_=5' }, rules).kind, 'static');
});

test('amazon page components match whether page script filled in page-type or not', () => {
  const rules = RuleSet.load([path.join(REPO_ROOT, 'sites')]);
  const widget = (pageType: string) =>
    normalizeRequest(
      {
        method: 'POST',
        url: `https://www.amazon.com/acp/apple-brand-showcase/apple-brand-showcase-5aef1594-1792731058544/getAjaxContentHTML?page-type=${pageType}&stamp=1792746171596`,
        contentType: 'application/json',
        body: Buffer.from('{"asin":"B0D1WXVQTN"}'),
      },
      rules,
    ).key;
  assert.equal(widget('undefined'), widget('Detail'));
  assert.notEqual(widget('Detail'), normalizeRequest({ method: 'POST', url: 'https://www.amazon.com/acp/apple-brand-showcase/apple-brand-showcase-5aef1594-1792731058544/getAjaxContentHTML?page-type=Detail', contentType: 'application/json', body: Buffer.from('{"asin":"B0OTHER000"}') }, rules).key, 'the body still selects the content');
});

test('hand-written rules win over inferred ones from any directory; later directories win among equals', () => {
  const shared = tmpDir();
  const task = tmpDir();
  writeFile(path.join(shared, 'shop.yaml'), 'site: shop\nhosts: ["shop.test"]\nendpoints:\n  - { name: product, match: "GET /dp/{id}/**", key: "/shared/{id}" }\n');
  writeFile(path.join(task, 'shop.auto.yaml'), 'site: shop\nhosts: ["shop.test"]\ndrop_params: [x]\nendpoints:\n  - { name: auto_page_1, match: "GET /dp/{id}/**", key: "/auto/{id}" }\n');
  let rules = RuleSet.load([shared, task]);
  assert.equal(normalizeRequest({ method: 'GET', url: 'https://shop.test/dp/A1?x=1' }, rules).key, 'GET shop.test/shared/A1', 'shared hand-written beats task auto');
  writeFile(path.join(task, 'shop.yaml'), 'site: shop\nhosts: ["shop.test"]\nendpoints:\n  - { name: product, match: "GET /dp/{id}/**", key: "/task/{id}" }\n');
  rules = RuleSet.load([shared, task]);
  assert.equal(normalizeRequest({ method: 'GET', url: 'https://shop.test/dp/A1?x=1' }, rules).key, 'GET shop.test/task/A1', 'task hand-written beats shared');
});

test('writeBundle stores a deduplicated, uncompressed WARC with indexes', async () => {
  const dir = await buildShopBundle();
  const bundle = new Bundle(dir);
  assert.ok(bundle.isPacked());
  assert.equal(path.basename(bundle.archivePath), 'data.warc');
  const manifest = bundle.manifest();
  assert.equal(manifest.not_found.shop, 'https://shop.test/rr-not-found-abc');
  assert.deepEqual(Object.keys(manifest).sort(), ['captured_from', 'captured_to', 'not_found', 'task_id'], 'only what replay reads');
  assert.ok(!fs.existsSync(path.join(dir, 'datapackage.json')) && !fs.existsSync(path.join(dir, 'indexes', 'index.cdxj')));
  const entries = bundle.entries();
  const home = entries.find((e) => e.url === 'https://shop.test/')!;
  const resp = await readResponseAt(bundle.archivePath, { offset: home.respOffset, length: home.respLength });
  assert.ok(resp.body.toString().includes('Alex Example'));
  const req = await readRequestAt(bundle.archivePath, { offset: home.reqOffset, length: home.reqLength });
  assert.ok(req.headers.some(([k]) => k.toLowerCase() === 'accept'));
  const png = entries.find((e) => e.url.endsWith('b.png'))!;
  assert.ok(png.revisitOf);
  const store = new RecordStore(bundle, RuleSet.load([bundle.rulesDir]));
  assert.equal((await store.response(store.byId.get(png.id)!)).body.length, PNG.length, 'revisit resolves to original payload');
  assert.deepEqual(bundle.pages().map((p) => p.fetched), ['GET', 'GET']);
});

test('replay engine walks the lookup ladder and never needs the network', async () => {
  const dir = await buildShopBundle();
  const engine = new ReplayEngine(dir);
  await engine.warmUp();
  const doc = { accept: 'text/html', 'sec-fetch-dest': 'document' };
  const get = (url: string, headers: Record<string, string> = doc) => engine.handle({ method: 'GET', url, headers });

  const product = await get('https://shop.test/Other-Name/dp/B0TEST/ref=sr_9?qid=42');
  assert.equal(product.source, 'exact');
  assert.equal(product.status, 200);
  assert.ok(product.body.toString().includes('Test Earbuds'));

  const search = await get('https://shop.test/s?k=pro+airpods');
  assert.equal(search.source, 'search', 'different word order still finds the recorded search');

  const xhr = await get('https://shop.test/api/offers?asin=B0TEST&_=999', { accept: 'application/json', 'sec-fetch-dest': 'empty' });
  assert.equal(xhr.source, 'exact');

  const missXhr = await get('https://shop.test/api/unknown', { accept: 'application/json', 'sec-fetch-dest': 'empty' });
  assert.equal(missXhr.source, 'miss');
  assert.equal(missXhr.status, 404);

  const missDoc = await get('https://shop.test/never/recorded');
  assert.equal(missDoc.status, 404);
  assert.ok(missDoc.body.toString().includes('dogs of shop'), "site's own 404 page");

  const tracker = await get('https://metrics.shop.test/beacon', {});
  assert.equal(tracker.source, 'blocked');
  assert.equal(tracker.status, 204);

  const img = await get('https://img.shop.test/b.png?v=7', { 'sec-fetch-dest': 'image' });
  assert.equal(img.source, 'fuzzy');
  assert.equal(img.body.length, PNG.length);

  const promo = await engine.handle({ method: 'POST', url: 'https://shop.test/cart/promo', headers: { 'content-type': 'application/json' }, body: Buffer.from('{"code":"WHATEVER"}') });
  assert.equal(promo.source, 'promo');
  assert.ok(promo.body.toString().includes('not a valid code'));

  // what was recorded replays; anything else misses, with no cart arithmetic behind it
  const addForm = (body: string) => engine.handle({ method: 'POST', url: 'https://shop.test/cart/add', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from(body) });
  assert.equal((await addForm('ASIN=B0TEST&quantity=1&csrfToken=new')).source, 'exact');
  const two = await addForm('ASIN=B0TEST&quantity=2&csrfToken=new');
  assert.equal(two.source, 'miss', 'a quantity that was never recorded');
  assert.equal((await addForm('ASIN=B0OTHER&quantity=1')).source, 'miss', 'an item that was never added');
  const cart = await get('https://shop.test/cart');
  assert.equal(cart.source, 'exact');
  assert.ok(cart.body.toString().includes('<span id="subtotal">$199.00</span>'), 'the cart is answered with its last recording, not the empty one');
  assert.equal(Number(cart.headers.find(([k]) => k === 'Content-Length')![1]), cart.body.length);

  const options = await engine.handle({ method: 'OPTIONS', url: 'https://shop.test/api/unknown', headers: { origin: 'https://shop.test', 'access-control-request-method': 'POST' } });
  assert.equal(options.source, 'preflight');

  const health = await engine.handle({ method: 'GET', url: 'http://rr.control/health', headers: {} });
  assert.equal(JSON.parse(health.body.toString()).ok, true);
  const stats = engine.getStats();
  assert.ok(stats.byClass.xhr.miss >= 1);
});
