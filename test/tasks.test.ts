import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { createArchive, PUBLIC_BUNDLE_FILES } from '../src/core/archive';
import { auditBundle } from '../src/core/audit';
import { Bundle } from '../src/core/bundle';
import { RuleSet } from '../src/core/rules';
import { writeBundle } from '../src/core/writer';
import { ReplayEngine } from '../src/replay/engine';
import { Repo, resolveTarget } from '../src/tasks';
import { exchanges, REPO_ROOT, tmpDir, writeFile } from './helpers';
import { buildShopBundle, COMPUTE, SHOP_RULES } from './shop-fixture';

/** A repository with sites/ and one task whose recording is the shop bundle. */
async function shopRepo(): Promise<{ repo: Repo; bundleDir: string }> {
  const bundleDir = await buildShopBundle();
  const root = tmpDir();
  writeFile(path.join(root, 'sites', 'shop.yaml'), SHOP_RULES);
  fs.copyFileSync(path.join(REPO_ROOT, 'sites', '_default.yaml'), path.join(root, 'sites', '_default.yaml'));
  const task = path.join(root, 'tasks', 'shop-earbuds');
  writeFile(path.join(task, 'task.yaml'), 'id: shop-earbuds\ntitle: Buy earbuds\nstart_url: https://shop.test/\n');
  writeFile(path.join(task, 'compute.yaml'), COMPUTE);
  // a task-level correction on top of the shared site rules
  writeFile(path.join(task, 'rules', 'shop.yaml'), 'site: shop\nhosts: ["shop.test"]\nblock: ["shop.test/api/offers"]\n');
  await createArchive(bundleDir, PUBLIC_BUNDLE_FILES, path.join(task, 'bundle.tar.gz'));
  process.env.PAB_CACHE = path.join(root, '.cache');
  return { repo: new Repo(root), bundleDir };
}

test('a task replays from its archive with shared and task rules and its compute.yaml', async () => {
  const { repo } = await shopRepo();
  assert.deepEqual(repo.taskIds(), ['shop-earbuds']);
  const target = await resolveTarget('shop-earbuds', repo);
  assert.equal(target.startUrl, 'https://shop.test/');
  assert.ok(target.bundleDir.startsWith(path.join(repo.cacheDir, 'bundles', 'shop-earbuds-')));
  assert.equal(await (await resolveTarget(path.join(repo.tasksDir, 'shop-earbuds'), repo)).bundleDir, target.bundleDir, 'unpacked once');

  const engine = new ReplayEngine(target.bundleDir, { rulesDirs: target.rulesDirs, computePath: target.computePath });
  await engine.warmUp();
  const doc = { accept: 'text/html', 'sec-fetch-dest': 'document' };
  const product = await engine.handle({ method: 'GET', url: 'https://shop.test/Other/dp/B0TEST/ref=x', headers: doc });
  assert.equal(product.source, 'exact', 'endpoints from sites/ apply');
  const offers = await engine.handle({ method: 'GET', url: 'https://shop.test/api/offers?asin=B0TEST', headers: { 'sec-fetch-dest': 'empty' } });
  assert.equal(offers.source, 'blocked', 'task rules apply on top');
  await engine.handle({ method: 'POST', url: 'https://shop.test/cart/add', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: Buffer.from('ASIN=B0TEST&quantity=3') });
  const cart = await engine.handle({ method: 'GET', url: 'https://shop.test/cart', headers: doc });
  assert.ok(cart.body.toString().includes('$597.00'), "the task's compute.yaml is used");
});

test('audit passes a clean bundle and reports credentials, live cookies and the recorder', async () => {
  const { bundleDir } = await shopRepo();
  const rules = RuleSet.load([path.join(bundleDir, 'rules')]);
  assert.deepEqual(await auditBundle(new Bundle(bundleDir), rules), []);

  const dirty = await buildShopBundle();
  const [ex] = exchanges([{ url: 'https://shop.test/', body: 'x' }]);
  ex.reqHeaders.push(['Cookie', 'session=abc']);
  ex.respHeaders = [['Set-Cookie', 'session=live; Path=/']];
  await writeBundle(new Bundle(dirty), [ex], { meta: { scenario_id: 'dirty', recorder: 'someone' }, rules });
  const checks = (await auditBundle(new Bundle(dirty), rules)).map((f) => f.check).sort();
  assert.deepEqual(checks, ['manifest', 'request-credentials', 'response-cookies']);
});
