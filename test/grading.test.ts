import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { Bundle } from '../src/core/bundle';
import { RuleSet } from '../src/core/rules';
import { RecordStore } from '../src/core/store';
import { checkSources, parseGrading, validateGrading } from '../src/grading';
import { REPO_ROOT } from './helpers';
import { buildShopBundle } from './shop-fixture';

const example = () => {
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'grading.md'), 'utf8');
  return parseGrading(/```yaml\n([\s\S]*?)```/.exec(doc)![1]);
};

test('the documented grading is valid; mistakes are named', () => {
  assert.deepEqual(validateGrading(example()), []);
  const errors = validateGrading({
    extract: { price: { type: 'money' }, store: { type: 'text' } },
    require: [{ field: 'price', equals: '278' }, { field: 'total' }, { field: 'store', min: 1 }] as never,
    checks: [{ id: 'a', question: 'Is it new?', required: true, weight: 1 }, { id: 'a', question: '' }],
    trace: [{ id: 'b', must: { url: '*/cart*' }, must_not: { url: '*/checkout*' } }],
  });
  const has = (re: RegExp) => assert.ok(errors.some((e) => re.test(e)), `${re} in ${errors.join(' | ')}`);
  has(/require\[0\]: equals must be a number/);
  has(/require\[1\]: field "total" is not in extract/);
  has(/require\[2\]: min, max and tolerance are for number/);
  has(/checks\[0\]: a check is either required or weighted/);
  has(/checks\[1\]: id "a" is used twice/);
  has(/checks\[1\]: question is missing/);
  has(/trace\[0\]: give exactly one of must or must_not/);
  assert.deepEqual(validateGrading({ extract: {} }), ['nothing to grade: add require, checks or trace']);
  assert.match(validateGrading({ rubric: 'x', checks: [{ id: 'a', question: 'Is it new?' }] } as never).join(), /unknown key "rubric"/);
});

test('an answer key must be readable in the recording', async () => {
  const bundle = new Bundle(await buildShopBundle());
  const store = new RecordStore(bundle, RuleSet.load([bundle.rulesDir]));
  const grading = (url: string, text: string) => ({ extract: { price: { type: 'money' as const } }, require: [{ field: 'price', equals: 199, source: { url, text } }] });
  assert.deepEqual(await checkSources(grading('https://shop.test/cart', '$199.00'), store), []);
  assert.deepEqual(await checkSources(grading('https://shop.test/api/offers?asin=B0TEST', '"price":199'), store), [], 'data a page script shows');
  assert.match((await checkSources(grading('https://shop.test/cart', '$149.00'), store)).join(), /does not appear/);
  assert.match((await checkSources(grading('https://shop.test/never', '$199.00'), store)).join(), /not in the recording/);
});
