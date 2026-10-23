import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';

/**
 * Bundles travel as one gzip-compressed tar file. Git hosts reject large files (GitHub: 100 MB,
 * with a warning from 50 MB), so archives above PART_BYTES are split into numbered parts:
 * bundle.tar.gz.000, bundle.tar.gz.001, ... which are read back in order as one stream.
 */
export const PART_BYTES = 45 * 1024 * 1024;

/** Files of a bundle that can be replayed and published; everything else stays with the recorder. */
export const PUBLIC_BUNDLE_FILES = [
  'manifest.json',
  'datapackage.json',
  'archive/data.warc',
  'indexes/entries.jsonl',
  'indexes/index.cdxj',
  'pages/pages.jsonl',
];

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
