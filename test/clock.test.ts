import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';
import { allowScriptHash, clockScript, injectClock } from '../src/replay/clock';
import { ReplayEngine } from '../src/replay/engine';
import { buildShopBundle } from './shop-fixture';

test('clock shim shifts Date to the recording time and keeps it flowing', () => {
  const recorded = Date.parse('2026-11-05T10:00:00Z');
  const sandbox: Record<string, unknown> = { Date };
  sandbox.window = sandbox;
  vm.runInNewContext(clockScript(recorded), sandbox);
  const ShiftedDate = sandbox.Date as DateConstructor;
  assert.ok(Math.abs(ShiftedDate.now() - recorded) < 1000);
  assert.ok(Math.abs(new ShiftedDate().getTime() - recorded) < 1000);
  assert.equal(new ShiftedDate(0).getTime(), 0, 'explicit dates are untouched');
  assert.equal(new ShiftedDate(2020, 0, 2).getFullYear(), 2020);
  assert.ok(new ShiftedDate() instanceof ShiftedDate);
  assert.equal(typeof ShiftedDate(), 'string');
});

test('clock shim goes first in <head> and through a strict CSP', () => {
  const out = injectClock('<html><head><title>x</title></head><body></body></html>', [['Content-Security-Policy', "default-src 'self'; script-src 'self' 'nonce-abc'"]], 0);
  assert.ok(out.html.startsWith('<html><head><script>(function(){if(window.__rrClock)'));
  assert.match(out.headers[0][1], /script-src 'self' 'nonce-abc' 'sha256-/);
  assert.equal(allowScriptHash("script-src 'self' 'unsafe-inline'", "'sha256-x'"), "script-src 'self' 'unsafe-inline'", 'unsafe-inline stays in force');
  assert.equal(allowScriptHash("default-src 'self'", "'sha256-x'"), "default-src 'self'; script-src 'self' 'sha256-x'");
  assert.equal(injectClock(out.html, [], 0).html, out.html, 'injected once');
});

test('replay engine injects the clock into documents only, unless turned off', async () => {
  const dir = await buildShopBundle();
  const doc = { accept: 'text/html', 'sec-fetch-dest': 'document' };
  const on = new ReplayEngine(dir);
  const page = await on.handle({ method: 'GET', url: 'https://shop.test/', headers: doc });
  assert.ok(page.body.toString().includes('__rrClock'));
  assert.ok(page.body.toString().includes(String(Date.parse(on.manifest.captured_from))));
  const xhr = await on.handle({ method: 'GET', url: 'https://shop.test/api/offers?asin=B0TEST', headers: { 'sec-fetch-dest': 'empty' } });
  assert.ok(!xhr.body.toString().includes('__rrClock'));
  const off = new ReplayEngine(dir, { clock: 'off' });
  assert.ok(!(await off.handle({ method: 'GET', url: 'https://shop.test/', headers: doc })).body.toString().includes('__rrClock'));
});
