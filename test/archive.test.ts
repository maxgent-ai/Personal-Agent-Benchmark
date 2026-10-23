import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as tar from 'tar';
import { archiveParts, createArchive, extractArchive, hashParts, PUBLIC_BUNDLE_FILES } from '../src/core/archive';
import { tmpDir, writeFile } from './helpers';
import { buildShopBundle } from './shop-fixture';

test('bundle archives are reproducible and round-trip', async () => {
  const dir = await buildShopBundle();
  const out = tmpDir();
  const [a] = await createArchive(dir, PUBLIC_BUNDLE_FILES, path.join(out, 'a', 'bundle.tar.gz'));
  const [b] = await createArchive(dir, PUBLIC_BUNDLE_FILES, path.join(out, 'b', 'bundle.tar.gz'));
  assert.equal(hashParts([a]), hashParts([b]), 'same files, same bytes');
  const dest = tmpDir();
  const files = await extractArchive([a], dest, (p) => PUBLIC_BUNDLE_FILES.includes(p));
  assert.deepEqual(files.sort(), [...PUBLIC_BUNDLE_FILES].sort());
  assert.ok(!fs.existsSync(path.join(dest, 'rules')), 'only the listed files travel');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'archive', 'data.warc')), fs.readFileSync(path.join(dir, 'archive', 'data.warc')));
});

test('large archives are split into parts and read back as one', async () => {
  const src = tmpDir();
  writeFile(path.join(src, 'blob.bin'), require('node:crypto').randomBytes(300_000).toString('base64'));
  const out = path.join(tmpDir(), 'bundle.tar.gz');
  const parts = await createArchive(src, ['blob.bin'], out, 100_000);
  assert.ok(parts.length >= 3);
  assert.deepEqual(archiveParts(out), parts);
  assert.ok(!fs.existsSync(out));
  const dest = tmpDir();
  await extractArchive(parts, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'blob.bin'), 'utf8'), fs.readFileSync(path.join(src, 'blob.bin'), 'utf8'));
  // writing a small archive to the same place removes the old parts
  writeFile(path.join(src, 'small.txt'), 'x');
  assert.deepEqual(await createArchive(src, ['small.txt'], out), [out]);
  assert.deepEqual(archiveParts(out), [out]);
});

test('extraction refuses links and files outside the allowed list', async () => {
  const src = tmpDir();
  writeFile(path.join(src, 'manifest.json'), '{}');
  fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
  const file = path.join(tmpDir(), 'evil.tar.gz');
  await tar.c({ file, cwd: src, gzip: true }, ['manifest.json', 'link']);
  await assert.rejects(extractArchive([file], tmpDir()), /unexpected entries: link/);
  const other = path.join(tmpDir(), 'other.tar.gz');
  await tar.c({ file: other, cwd: src, gzip: true }, ['manifest.json']);
  await assert.rejects(extractArchive([other], tmpDir(), (p) => p === 'archive/data.warc'), /unexpected entries: manifest.json/);
});
