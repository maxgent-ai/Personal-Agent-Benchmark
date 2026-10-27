import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import * as tar from 'tar';
import type { Manifest } from './types';
import { readJson, writeJson } from './util';

/**
 * Large files travel as gzip-compressed tar files: the WARC of a published recording (below) and
 * the recording tool's hand-off archive. Git hosts reject large files (GitHub: 100 MB, with a
 * warning from 50 MB), so archives above PART_BYTES are split into numbered parts:
 * warc.tar.gz.000, warc.tar.gz.001, ... which are read back in order as one stream.
 */
export const PART_BYTES = 45 * 1024 * 1024;

/** Files of a bundle that can be replayed and published; everything else stays with the recorder. */
export const PUBLIC_BUNDLE_FILES = ['manifest.json', 'archive/data.warc', 'indexes/entries.jsonl', 'pages/pages.jsonl'];

/** Written by earlier versions and never read by replay; still accepted when unpacking old archives. */
const LEGACY_BUNDLE_FILES = ['datapackage.json', 'indexes/index.cdxj'];

export const isBundleFile = (p: string) => PUBLIC_BUNDLE_FILES.includes(p) || LEGACY_BUNDLE_FILES.includes(p);

// a fixed timestamp keeps archives of the same files byte-identical
const ARCHIVE_MTIME = new Date('2000-01-01T00:00:00Z');

/**
 * Writes `files` (paths relative to `srcDir`, in this order) to `outFile`, a .tar.gz, replacing
 * any earlier archive or parts there. Returns the files written: `outFile` or its parts.
 */
export async function createArchive(srcDir: string, files: string[], outFile: string, partBytes = PART_BYTES): Promise<string[]> {
  for (const f of files) if (!fs.existsSync(path.join(srcDir, f))) throw new Error(`missing ${f} in ${srcDir}`);
  for (const old of archiveParts(outFile)) fs.rmSync(old);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  await tar.c({ file: tmp, cwd: srcDir, gzip: { level: 9 }, portable: true, mtime: ARCHIVE_MTIME }, files);
  const size = fs.statSync(tmp).size;
  if (size <= partBytes) {
    fs.renameSync(tmp, outFile);
    return [outFile];
  }
  const fd = fs.openSync(tmp, 'r');
  const parts: string[] = [];
  try {
    const buf = Buffer.alloc(partBytes);
    for (let offset = 0, n = 0; offset < size; offset += partBytes, n++) {
      const read = fs.readSync(fd, buf, 0, partBytes, offset);
      const part = `${outFile}.${String(n).padStart(3, '0')}`;
      fs.writeFileSync(part, buf.subarray(0, read));
      parts.push(part);
    }
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp);
  }
  return parts;
}

/** The archive at `file` as stored: the file itself, or its numbered parts in order. */
export function archiveParts(file: string): string[] {
  if (fs.existsSync(file)) return [file];
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(file);
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(base + '.') && /^\d{3}$/.test(name.slice(base.length + 1)))
    .sort()
    .map((name) => path.join(dir, name));
}

export function hashParts(parts: string[]): string {
  const hash = createHash('sha256');
  for (const p of parts) hash.update(fs.readFileSync(p));
  return hash.digest('hex');
}

/**
 * Extracts an archive (one file or its parts) into `destDir`. Only regular files and directories
 * are extracted, and only paths accepted by `allow`; tar itself refuses absolute paths and "..".
 */
export async function extractArchive(parts: string[], destDir: string, allow: (p: string) => boolean = () => true): Promise<string[]> {
  if (!parts.length) throw new Error('no archive to extract');
  fs.mkdirSync(destDir, { recursive: true });
  const extracted: string[] = [];
  const rejected: string[] = [];
  const source = Readable.from(
    (async function* () {
      for (const p of parts) yield* fs.createReadStream(p);
    })(),
  );
  await pipeline(
    source,
    tar.x({
      cwd: destDir,
      strict: true,
      filter: (p, entry) => {
        const type = 'type' in entry ? entry.type : 'File';
        const name = p.replace(/^\.\//, '');
        const ok = (type === 'File' || type === 'Directory') && !name.split('/').includes('..') && !path.isAbsolute(name) && (type === 'Directory' || allow(name));
        if (ok && type === 'File') extracted.push(name);
        if (!ok) rejected.push(name);
        return ok;
      },
    }),
  );
  if (rejected.length) throw new Error(`archive holds unexpected entries: ${rejected.slice(0, 5).join(', ')}`);
  return extracted;
}

/**
 * Layout version of a recording published in a task. Replay reads only this version: a change to
 * the layout or to the files in it bumps the number, and existing tasks are rewritten to match.
 */
export const RECORDING_FORMAT = 2;

/**
 * A bundle as published in a task (tasks/<id>/recording/):
 *   manifest.json      the bundle's manifest plus "format"
 *   pages.jsonl        pages/pages.jsonl
 *   entries.jsonl.gz   indexes/entries.jsonl, gzip-compressed
 *   warc.tar.gz        archive/data.warc (warc.tar.gz.000, .001, ... above PART_BYTES)
 * The WARC sits apart from the files whose layout may change, so a new format rewrites only the
 * small files and leaves the large archive as it was.
 */
export const RECORDING_FILES = {
  manifest: 'manifest.json',
  pages: 'pages.jsonl',
  entries: 'entries.jsonl.gz',
  warc: 'warc.tar.gz',
} as const;

/** Writes the bundle at `bundleDir` to `outDir` in the published layout, replacing what is there. */
export async function publishRecording(bundleDir: string, outDir: string): Promise<string[]> {
  for (const f of PUBLIC_BUNDLE_FILES) if (!fs.existsSync(path.join(bundleDir, f))) throw new Error(`missing ${f} in ${bundleDir}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  const out = (name: string) => path.join(outDir, name);
  writeJson(out(RECORDING_FILES.manifest), { ...readJson<Manifest>(path.join(bundleDir, 'manifest.json')), format: RECORDING_FORMAT });
  fs.copyFileSync(path.join(bundleDir, 'pages', 'pages.jsonl'), out(RECORDING_FILES.pages));
  fs.writeFileSync(out(RECORDING_FILES.entries), zlib.gzipSync(fs.readFileSync(path.join(bundleDir, 'indexes', 'entries.jsonl')), { level: 9 }));
  const warc = await createArchive(bundleDir, ['archive/data.warc'], out(RECORDING_FILES.warc));
  return [out(RECORDING_FILES.manifest), out(RECORDING_FILES.pages), out(RECORDING_FILES.entries), ...warc];
}

/** Files of the recording published in `dir`, in a fixed order; empty when there is none. */
export function recordingFiles(dir: string): string[] {
  const manifest = path.join(dir, RECORDING_FILES.manifest);
  if (!fs.existsSync(manifest)) return [];
  return [manifest, path.join(dir, RECORDING_FILES.pages), path.join(dir, RECORDING_FILES.entries), ...archiveParts(path.join(dir, RECORDING_FILES.warc))];
}

/** Turns the recording published in `dir` back into a bundle at `destDir`; refuses other formats. */
export async function unpackRecording(dir: string, destDir: string): Promise<void> {
  const manifest = readJson<Manifest>(path.join(dir, RECORDING_FILES.manifest));
  if (manifest.format !== RECORDING_FORMAT) {
    throw new Error(`${dir} is recording format ${manifest.format ?? '(none)'}; this version reads format ${RECORDING_FORMAT} (docs/bundle-format.md)`);
  }
  const warc = archiveParts(path.join(dir, RECORDING_FILES.warc));
  for (const f of [RECORDING_FILES.pages, RECORDING_FILES.entries]) if (!fs.existsSync(path.join(dir, f))) throw new Error(`missing ${f} in ${dir}`);
  if (!warc.length) throw new Error(`missing ${RECORDING_FILES.warc} in ${dir}`);
  await extractArchive(warc, destDir, (p) => p === 'archive/data.warc');
  fs.mkdirSync(path.join(destDir, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(destDir, 'indexes'), { recursive: true });
  fs.copyFileSync(path.join(dir, RECORDING_FILES.manifest), path.join(destDir, 'manifest.json'));
  fs.copyFileSync(path.join(dir, RECORDING_FILES.pages), path.join(destDir, 'pages', 'pages.jsonl'));
  fs.writeFileSync(path.join(destDir, 'indexes', 'entries.jsonl'), zlib.gunzipSync(fs.readFileSync(path.join(dir, RECORDING_FILES.entries))));
}
