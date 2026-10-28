import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Bundle } from '../src/core/bundle';
import { RuleSet } from '../src/core/rules';
import { writeBundle } from '../src/core/writer';
import { proxiedRequest, startReplayServer } from '../src/replay/launcher';
import type { ReplayStats } from '../src/replay/engine';
import { exchanges, REPO_ROOT, tmpDir, writeFile } from './helpers';
import { buildShopBundle, SHOP_RULES } from './shop-fixture';

test('whistle with the replay plugin answers from the bundle and nothing else', { timeout: 90_000 }, async () => {
  const dir = await buildShopBundle();
  const port = 19000 + Math.floor(Math.random() * 500);
  const server = await startReplayServer({ bundleDir: dir, port });
  try {
    const doc = { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' };
    const product = await proxiedRequest(port, 'http://shop.test/Some-Name/dp/B0TEST/ref=abc?qid=1', doc);
    assert.equal(product.status, 200);
    assert.ok(product.body.toString().includes('Test Earbuds'));

    const missing = await proxiedRequest(port, 'http://shop.test/not/recorded', doc);
    assert.equal(missing.status, 404);
    assert.ok(missing.body.toString().includes('dogs of shop'));

    // a host that was never recorded: answered locally, never resolved or fetched
    const outside = await proxiedRequest(port, 'http://example.com/', doc);
    assert.equal(outside.status, 404);

    const stats = await server.control<ReplayStats>('/stats');
    assert.equal(stats.requests, 3);
    assert.equal(stats.byClass.document.hit, 1);
    assert.equal(stats.byClass.document.miss, 2);
  } finally {
    await server.stop();
  }
});

test('a page whose recorded headers whistle cannot send as they are is still served', { timeout: 90_000 }, async () => {
  const dir = tmpDir();
  writeFile(path.join(dir, 'rules', 'shop.yaml'), SHOP_RULES);
  fs.copyFileSync(path.join(REPO_ROOT, 'sites', '_default.yaml'), path.join(dir, 'rules', '_default.yaml'));
  const [page] = exchanges([{ url: 'https://shop.test/', body: '<html><body>Welcome</body></html>' }]);
  page.respHeaders = [
    ['Content-Type', 'text/html; charset=utf-8'],
    // as recorders before record-replay 0.5.5 stored two cookies
    ['Set-Cookie', 'a=REDACTED; Path=/\nb=REDACTED; Expires=Wed, 27-Oct-2027 11:45:09 GMT; Path=/'],
    ['Content-Disposition', 'inline; filename="商品.html"'],
    ['X-Broken', 'one\u0000two'],
    // as some CDNs send it: Node refuses a Trailer on a response with a length
    ['Trailer', 'server-timing'],
  ];
  await writeBundle(new Bundle(dir), [page], { meta: { task_id: 'headers' }, rules: RuleSet.load([path.join(dir, 'rules')]) });
  const port = 19000 + Math.floor(Math.random() * 500);
  const server = await startReplayServer({ bundleDir: dir, port });
  try {
    const res = await proxiedRequest(port, 'http://shop.test/', { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' });
    assert.equal(res.status, 200, res.body.toString());
    assert.ok(res.body.toString().includes('Welcome'));
    assert.deepEqual(res.headers['set-cookie']?.map((c) => c.split(';')[0]), ['a=REDACTED', 'b=REDACTED']);
    assert.equal(res.headers['content-disposition'], undefined, 'a header Node cannot send is left out');
    assert.equal(res.headers['x-broken'], undefined);
    assert.equal(res.headers.trailer, undefined);
  } finally {
    await server.stop();
  }
});

test('whistle starts without any node on PATH (an app opened from Finder)', { timeout: 90_000 }, async () => {
  const dir = await buildShopBundle();
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-no-node-'));
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  const port = 19500 + Math.floor(Math.random() * 400);
  try {
    const server = await startReplayServer({ bundleDir: dir, port });
    try {
      const product = await proxiedRequest(port, 'http://shop.test/Some-Name/dp/B0TEST/ref=abc', { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' });
      assert.equal(product.status, 200);
    } finally {
      await server.stop();
    }
  } finally {
    process.env.PATH = savedPath;
  }
});
