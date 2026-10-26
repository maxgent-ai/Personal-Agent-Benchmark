import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Bundle } from '../src/core/bundle';
import { RuleSet } from '../src/core/rules';
import { writeBundle } from '../src/core/writer';
import { exchanges, REPO_ROOT, tmpDir, writeFile, type FakeExchange } from './helpers';

export const SHOP_RULES = `
site: shop
hosts: ["shop.test", "*.shop.test"]
drop_params: [ref, qid, sr]
block: ["metrics.shop.test"]
endpoints:
  - name: product
    match: "GET /*/dp/{asin}/**"
    key: "/dp/{asin}"
  - name: product_plain
    match: "GET /dp/{asin}/**"
    key: "/dp/{asin}"
  - name: search
    match: "GET /s"
    keep_params: [k, page]
    kind: search
    text_param: k
  - name: cart_add
    match: "POST /cart/add"
    kind: stateful
    body_keep: [ASIN, quantity]
  - name: promo
    match: "POST /cart/promo"
    kind: promo
    text_param: code
    invalid_code: BADCODE
`;

export const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(2048), 'hex');

export const SHOP_EXCHANGES: FakeExchange[] = [
  { url: 'https://shop.test/', body: '<html><body><span id="nav-cart-count">0</span>Hello Alex Example</body></html>' },
  { url: 'https://shop.test/s?k=AirPods+Pro&qid=1730000000&ref=nb', body: '<html><body>results for airpods pro</body></html>' },
  { url: 'https://shop.test/Apple-AirPods/dp/B0TEST/ref=sr_1_1?qid=1730000001', body: '<html><body><span id="nav-cart-count">0</span><h1>Test Earbuds</h1></body></html>' },
  { url: 'https://shop.test/Apple-AirPods/dp/B0TEST/ref=sr_1_1?qid=1730000999', body: '<html><body><span id="nav-cart-count">0</span><h1>Test Earbuds</h1></body></html>' },
  { url: 'https://shop.test/api/offers?asin=B0TEST&_=1730000002', contentType: 'application/json', body: '{"offers":[{"price":199}]}' },
  { url: 'https://img.shop.test/a.png', contentType: 'image/png', body: PNG },
  { url: 'https://img.shop.test/b.png', contentType: 'image/png', body: PNG },
  { url: 'https://shop.test/rr-not-found-abc', status: 404, body: '<html><body>Sorry, dogs of shop</body></html>' },
  // the cart before and after adding: replay answers carts with the last recording
  { url: 'https://shop.test/cart', body: '<html><body><span id="nav-cart-count">0</span>Your cart is empty</body></html>' },
  { method: 'POST', url: 'https://shop.test/cart/add', reqContentType: 'application/x-www-form-urlencoded', reqBody: 'ASIN=B0TEST&quantity=1&csrfToken=zzz', contentType: 'application/json', body: '{"ok":true}' },
  { url: 'https://shop.test/cart', body: '<html><body><span id="nav-cart-count">1</span><div class="line"><span class="title">Test Earbuds</span><span class="qty">1</span></div>Subtotal <span id="subtotal">$199.00</span> (<span id="count">1</span>)</body></html>' },
  { method: 'POST', url: 'https://shop.test/cart/promo', reqContentType: 'application/json', reqBody: '{"code":"BADCODE"}', contentType: 'application/json', body: '{"valid":false,"message":"not a valid code"}' },
];

/** A small shop bundle with its own rules/, as the recorder would write it. */
export async function buildShopBundle(): Promise<string> {
  const dir = tmpDir();
  writeFile(path.join(dir, 'rules', 'shop.yaml'), SHOP_RULES);
  fs.copyFileSync(path.join(REPO_ROOT, 'sites', '_default.yaml'), path.join(dir, 'rules', '_default.yaml'));
  const result = await writeBundle(new Bundle(dir), exchanges(SHOP_EXCHANGES), {
    meta: { task_id: 'shop' },
    rules: RuleSet.load([path.join(dir, 'rules')]),
    pages: [
      { id: 'p1', url: 'https://shop.test/', ts: '2026-11-05T10:00:00Z' },
      { id: 'p2', url: 'https://shop.test/rr-not-found-abc', ts: '2026-11-05T10:00:07Z', note: 'not-found-probe' },
    ],
  });
  assert.equal(result.entries.length, 12);
  assert.equal(result.revisits, 1, 'identical image payload is stored once');
  return dir;
}
