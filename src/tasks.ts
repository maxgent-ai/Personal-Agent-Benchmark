import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { archiveParts, extractArchive, hashParts, isBundleFile } from './core/archive';
import { PACKAGE_ROOT } from './paths';

/**
 * tasks/<id>/ in this repository:
 *   task.yaml        the task card (what the agent is asked)
 *   bundle.tar.gz    the recording (or bundle.tar.gz.000, .001, ... when split)
 *   bundle.json      the recordings merged into it (time ranges), written on import
 *   rules/           site rules for this task: <site>.auto.yaml inferred from the recording,
 *                    <site>.yaml written by people (wins over auto and over sites/)
 *   compute.yaml     cart and checkout computation, when the task needs one
 */
export interface TaskCard {
  id: string;
  title?: string;
  /** The instruction given to the agent. */
  prompt?: string;
  /** The browser's language and time zone while recording; replay keeps them. */
  capture?: { locale?: string; timezone?: string };
}

/** Everything a replay needs: the recording, the rules layered over it, and the compute rules. */
export interface ReplayTarget {
  name: string;
  bundleDir: string;
  /** Rule directories layered over the bundle's own rules/ (later wins). */
  rulesDirs: string[];
  /** compute.yaml replacing the bundle's own; undefined uses the bundle's. */
  computePath?: string;
  task?: Task;
}

export class Repo {
  constructor(readonly root: string) {}

  /** $PAB_REPO, or the checkout this code runs from. */
  static default(): Repo {
    return new Repo(path.resolve(process.env.PAB_REPO ?? PACKAGE_ROOT));
  }

  get sitesDir(): string { return path.join(this.root, 'sites'); }
  get tasksDir(): string { return path.join(this.root, 'tasks'); }
  /** Unpacked bundles and replay logs ($PAB_CACHE, default .cache/ in the repository). */
  get cacheDir(): string { return path.resolve(process.env.PAB_CACHE ?? path.join(this.root, '.cache')); }

  taskIds(): string[] {
    if (!fs.existsSync(this.tasksDir)) return [];
    return fs
      .readdirSync(this.tasksDir)
      .filter((name) => fs.existsSync(path.join(this.tasksDir, name, 'task.yaml')))
      .sort();
  }

  task(id: string): Task {
    const dir = path.join(this.tasksDir, id);
    if (!fs.existsSync(path.join(dir, 'task.yaml'))) throw new Error(`no task "${id}" in ${this.tasksDir}`);
    return new Task(this, dir);
  }
}

export class Task {
  constructor(readonly repo: Repo, readonly dir: string) {}

  get id(): string { return path.basename(this.dir); }
  get cardPath(): string { return path.join(this.dir, 'task.yaml'); }
  get archivePath(): string { return path.join(this.dir, 'bundle.tar.gz'); }
  /** bundle.json: the recordings merged into bundle.tar.gz, written on import. */
  get summaryPath(): string { return path.join(this.dir, 'bundle.json'); }
  get rulesDir(): string { return path.join(this.dir, 'rules'); }
  get computePath(): string { return path.join(this.dir, 'compute.yaml'); }

  card(): TaskCard {
    const card = YAML.parse(fs.readFileSync(this.cardPath, 'utf8')) as TaskCard;
    return { ...card, id: card?.id ?? this.id };
  }

  archiveParts(): string[] {
    return archiveParts(this.archivePath);
  }

  /** Unpacks the recording into the cache (once per archive content) and returns its directory. */
  async bundleDir(): Promise<string> {
    const parts = this.archiveParts();
    if (!parts.length) throw new Error(`task ${this.id} has no recording (${this.archivePath})`);
    const digest = hashParts(parts).slice(0, 16);
    const bundlesDir = path.join(this.repo.cacheDir, 'bundles');
    const dest = path.join(bundlesDir, `${this.id}-${digest}`);
    if (fs.existsSync(path.join(dest, 'manifest.json'))) return dest;
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      await extractArchive(parts, tmp, isBundleFile);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // older unpacked versions of this task
    for (const name of fs.readdirSync(bundlesDir)) {
      if (name.startsWith(`${this.id}-`) && path.join(bundlesDir, name) !== dest && !name.includes('.tmp-')) {
        fs.rmSync(path.join(bundlesDir, name), { recursive: true, force: true });
      }
    }
    return dest;
  }

  async target(): Promise<ReplayTarget> {
    return {
      name: this.id,
      bundleDir: await this.bundleDir(),
      rulesDirs: [this.repo.sitesDir, this.rulesDir],
      computePath: this.computePath,
      task: this,
    };
  }
}

/**
 * Resolves a command-line argument to a replay target: a task id, a task directory, or a bundle
 * directory (one with manifest.json, replayed with its own rules/ and compute/).
 */
export async function resolveTarget(arg: string, repo = Repo.default()): Promise<ReplayTarget> {
  const asPath = path.resolve(arg);
  if (fs.existsSync(path.join(asPath, 'manifest.json'))) {
    return { name: path.basename(asPath), bundleDir: asPath, rulesDirs: [] };
  }
  if (fs.existsSync(path.join(asPath, 'task.yaml'))) {
    // a task inside a repository uses that repository's sites/; a lone task directory uses ours
    const parent = path.dirname(asPath);
    const owner = path.basename(parent) === 'tasks' && fs.existsSync(path.join(parent, '..', 'sites')) ? new Repo(path.dirname(parent)) : repo;
    return new Task(owner, asPath).target();
  }
  return repo.task(arg).target();
}
