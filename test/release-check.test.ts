import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { changedDependencies, importedModules, usedFiles } from '../scripts/release-check';
import { main } from '../src/cli';

const ROOT = path.resolve(__dirname, '..', '..');

test('the modules a consumer imports are read from its code, whatever the import form', () => {
  const sources = [
    `import { main, type Args } from 'personal-agent-benchmark/cli';\nconst rules = require("personal-agent-benchmark/core/rules");`,
    `await import('personal-agent-benchmark/cli');\nconst root = require.resolve('personal-agent-benchmark/package.json');`,
  ];
  assert.deepEqual(importedModules(sources), ['cli', 'core/rules']);
});

test('the CLI loads neither scoring nor the judge: pab grade is required only when it runs', async () => {
  const used = usedFiles(ROOT, ['cli']);
  for (const f of ['src/cli.ts', 'src/tasks.ts', 'src/replay/whistle-plugin.ts', 'plugins/whistle.bench-replay/index.js']) assert.ok(used.includes(f), f);
  for (const f of ['src/grade.ts', 'src/scoring.ts', 'src/report.ts', 'src/judge.ts']) assert.ok(!used.includes(f), f);
  await assert.rejects(main(['grade']), /usage: pab grade/);
});

test('a module the consumer sees only as types is used too', () => {
  // scoring imports the judge's types only, so judge.js is not loaded, but scoring.d.ts refers to it
  const used = usedFiles(ROOT, ['scoring']);
  assert.ok(used.includes('src/report.ts'));
  assert.ok(used.includes('src/judge.ts'));
});

test('dependencies that were added, removed or given another range', () => {
  assert.deepEqual(changedDependencies({ a: '^1.0.0', b: '^2.0.0', c: '1.0.0' }, { a: '^1.0.0', b: '^3.0.0', d: '^1.0.0' }), [
    'b ^2.0.0 -> ^3.0.0',
    'c 1.0.0 -> (none)',
    'd (none) -> ^1.0.0',
  ]);
});
