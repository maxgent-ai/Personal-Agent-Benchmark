import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { proxiedRequest, startReplayServer } from '../src/replay/launcher';
import type { ReplayStats } from '../src/replay/engine';
import { buildShopBundle } from './shop-fixture';

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
