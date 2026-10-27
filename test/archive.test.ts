import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import * as tar from 'tar';
import {
  archiveParts,
  createArchive,
  extractArchive,
  hashParts,
  publishRecording,
  PUBLIC_BUNDLE_FILES,
  RECORDING_FILES,
  RECORDING_FORMAT,
  recordingFiles,
  unpackRecording,
} from '../src/core/archive';
import { tmpDir, writeFile } from './helpers';
import { buildShopBundle } from './shop-fixture';

test('a published recording unpacks to the bundle it came from', async () => {
  const dir = await buildShopBundle();
  const out = path.join(tmpDir(), 'recording');
  const written = await publishRecording(dir, out);
  assert.deepEqual(written, recordingFiles(out));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, RECORDING_FILES.manifest), 'utf8'));
  assert.equal(manifest.format, RECORDING_FORMAT);
  const dest = tmpDir();
  await unpackRecording(out, dest);
  for (const f of PUBLIC_BUNDLE_FILES.filter((f) => f !== 'manifest.json')) {
    assert.deepEqual(fs.readFileSync(path.join(dest, f)), fs.readFileSync(path.join(dir, f)), f);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8')), manifest);
});

test('rewriting the small files of a recording leaves its WARC archive as it was', async () => {
  const dir = await buildShopBundle();
  const out = path.join(tmpDir(), 'recording');
  await publishRecording(dir, out);
  const warc = fs.readFileSync(path.join(out, RECORDING_FILES.warc));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), locale: 'de-DE' }));
  await publishRecording(dir, out);
  assert.deepEqual(fs.readFileSync(path.join(out, RECORDING_FILES.warc)), warc);
});

test('replay refuses a recording in another format', async () => {
  const out = path.join(tmpDir(), 'recording');
  await publishRecording(await buildShopBundle(), out);
  const manifestPath = path.join(out, RECORDING_FILES.manifest);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')), format: RECORDING_FORMAT + 1 }));
  await assert.rejects(unpackRecording(out, tmpDir()), /recording format 3; this version reads format 2/);
});

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
