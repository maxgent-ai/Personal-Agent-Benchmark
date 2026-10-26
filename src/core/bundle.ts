import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Entry, Manifest } from './types';
import { readJson, readJsonl } from './util';

/**
 * A recording bundle on disk. One recording, one directory:
 *   manifest.json, archive/data.warc, indexes/entries.jsonl, pages/pages.jsonl;
 *   optionally rules/*.yaml.
 * The recorder also keeps working files next to them (raw/, review/, check/, report.json);
 * those never leave the recording machine.
 */
export class Bundle {
  constructor(readonly dir: string) {}

  get manifestPath(): string { return path.join(this.dir, 'manifest.json'); }
  /** archive/data.warc; bundles written before the switch to uncompressed records use data.warc.gz. */
  get archivePath(): string {
    const plain = path.join(this.dir, 'archive', 'data.warc');
    const gz = plain + '.gz';
    return !fs.existsSync(plain) && fs.existsSync(gz) ? gz : plain;
  }
  get entriesPath(): string { return path.join(this.dir, 'indexes', 'entries.jsonl'); }
  get pagesPath(): string { return path.join(this.dir, 'pages', 'pages.jsonl'); }
  get rulesDir(): string { return path.join(this.dir, 'rules'); }
  get reviewDir(): string { return path.join(this.dir, 'review'); }
  get rawDir(): string { return path.join(this.dir, 'raw'); }
  get checkDir(): string { return path.join(this.dir, 'check'); }
  get reportPath(): string { return path.join(this.dir, 'report.json'); }

  isPacked(): boolean {
    return fs.existsSync(this.manifestPath) && fs.existsSync(this.entriesPath) && fs.existsSync(this.archivePath);
  }

  manifest(): Manifest {
    return readJson<Manifest>(this.manifestPath);
  }

  entries(): Entry[] {
    return readJsonl<Entry>(this.entriesPath);
  }

  pages(): PageRecord[] {
    return readJsonl<PageRecord>(this.pagesPath);
  }
}

/** A top-level page visited during capture (WACZ pages.jsonl shape plus capture notes). */
export interface PageRecord {
  id: string;
  url: string;
  ts: string;
  title?: string;
  /** e.g. "not-found-probe", "reload", "after-add-to-cart" */
  note?: string;
  /** Saved accessibility snapshot / screenshot names under raw/snapshots. */
  snapshot?: string;
  /**
   * How the page's URL was fetched during capture: "GET" (a real document load), "POST" (form
   * result), or "none" (the address bar was rewritten by page script, nothing was requested).
   */
  fetched?: 'GET' | 'POST' | 'none';
}
