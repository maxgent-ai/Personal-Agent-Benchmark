import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether the recording tool needs a new version of this package: what changed since the version
 * on npm, in what the tool uses. The tool's imports are read from its checkout; those modules are
 * loaded from dist/ and every file they load counts, with the declarations the tool's compiler
 * reads and the files it reads from the package directly (DATA). Run after a build.
 *   node dist/scripts/release-check.js [--consumer DIR]   report (npm run release-check)
 *   node dist/scripts/release-check.js --guard            prepublishOnly: exits 1 when nothing it uses changed
 */

const NAME = 'personal-agent-benchmark';
const ROOT = path.resolve(__dirname, '..', '..');
/**
 * Read by the recording tool from the installed package besides the modules it imports: the
 * whistle plugin (replay/launcher starts it), the site rules its app starts from, and the docs its
 * review agents are given.
 */
const DATA = ['plugins/', 'sites/', 'docs/site-rules.md', 'docs/grading.md'];
const CODE = /\.[cm]?[jt]sx?$/;
const OVERRIDE = 'PAB_PUBLISH_ANYWAY';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const lines = (s: string) => s.split('\n').filter(Boolean);

/** Module paths the sources import from this package ('cli', 'core/rules'); package.json only locates it. */
export function importedModules(sources: string[]): string[] {
  const found = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(/['"]personal-agent-benchmark\/([\w./-]+)['"]/g)) if (m[1] !== 'package.json') found.add(m[1]);
  return [...found].sort();
}

/**
 * Sources (src/x.ts, plugins/...) that loading `modules` through the package's exports reads, the
 * whistle plugin included: every module required at run time, and the declarations of those and of
 * the modules they refer to only as types.
 */
export function usedFiles(root: string, modules: string[]): string[] {
  // a fresh process, so require.cache holds only what these modules load
  const script = `const req = require('node:module').createRequire(require('node:path').join(process.argv[1], 'package.json'));
for (const m of JSON.parse(process.argv[2])) req('${NAME}/' + m);
req('./plugins/whistle.bench-replay/index.js');
console.log(JSON.stringify(Object.keys(require.cache)));`;
  const loaded: string[] = JSON.parse(execFileSync(process.execPath, ['-e', script, root, JSON.stringify(modules)], { encoding: 'utf8' }));
  const dist = path.join(root, 'dist');
  const source = (f: string) => path.relative(dist, f).replace(/(\.d\.ts|\.js)$/, '.ts');
  const files = new Set<string>();
  const declarations: string[] = [];
  for (const f of loaded) {
    if (f.startsWith(path.join(dist, 'src') + path.sep)) {
      files.add(source(f));
      declarations.push(f.replace(/\.js$/, '.d.ts'));
    } else if (f.startsWith(root + path.sep) && !f.includes(`${path.sep}node_modules${path.sep}`)) files.add(path.relative(root, f));
  }
  for (let i = 0; i < declarations.length; i++) {
    const d = declarations[i];
    if (!fs.existsSync(d)) continue;
    files.add(source(d));
    for (const m of fs.readFileSync(d, 'utf8').matchAll(/(?:from |import\()['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const next = path.resolve(path.dirname(d), m[1].replace(/\.js$/, '')) + '.d.ts';
      if (!declarations.includes(next)) declarations.push(next);
    }
  }
  return [...files].sort();
}

/** Dependencies added, removed or given another range. */
export function changedDependencies(before: Record<string, string> = {}, after: Record<string, string> = {}): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter((d) => before[d] !== after[d]).map((d) => `${d} ${before[d] ?? '(none)'} -> ${after[d] ?? '(none)'}`);
}

/** Changed since `base` in what the consumer uses, and how many other files changed. */
function check(consumer: string): { version: string; base: string; changes: string[]; others: number } {
  const published = JSON.parse(execFileSync('npm', ['view', NAME, 'version', 'gitHead', '--json'], { encoding: 'utf8' })) as { version: string; gitHead?: string };
  const base = published.gitHead;
  if (!base) throw new Error(`npm has no commit for ${NAME}@${published.version}`);
  try {
    git(ROOT, 'cat-file', '-e', `${base}^{commit}`);
  } catch {
    throw new Error(`commit ${base} of ${published.version} is not in this checkout; git fetch first`);
  }
  if (!fs.existsSync(path.join(consumer, '.git'))) throw new Error(`no checkout of the recording tool at ${consumer}; pass --consumer DIR or set PAB_CONSUMER`);
  const sources = lines(git(consumer, 'ls-files'))
    .filter((f) => CODE.test(f) && fs.existsSync(path.join(consumer, f)))
    .map((f) => fs.readFileSync(path.join(consumer, f), 'utf8'));
  const modules = importedModules(sources);
  const used = new Set(usedFiles(ROOT, modules));
  console.log(`published: ${NAME}@${published.version}, commit ${base.slice(0, 7)}`);
  console.log(`consumer: ${consumer} at ${git(consumer, 'rev-parse', '--short', 'HEAD')}, imports ${modules.length} modules`);
  console.log(`it uses: ${[...used].filter((f) => f.startsWith('src/')).length} source files, ${DATA.join(', ')}, the dependencies\n`);

  // the working tree, as npm packs it, untracked files included
  const changed = [...new Set([...lines(git(ROOT, 'diff', '--name-only', base)), ...lines(git(ROOT, 'ls-files', '--others', '--exclude-standard'))])].sort();
  const isUsed = (f: string) => used.has(f) || DATA.some((d) => (d.endsWith('/') ? f.startsWith(d) : f === d));
  const before = JSON.parse(git(ROOT, 'show', `${base}:package.json`)) as { dependencies?: Record<string, string> };
  const after = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const changes = [...changed.filter(isUsed), ...changedDependencies(before.dependencies, after.dependencies).map((d) => `dependency ${d}`)];
  return { version: published.version, base, changes, others: changed.filter((f) => !isUsed(f)).length };
}

function main(): void {
  const args = process.argv.slice(2);
  const guard = args.includes('--guard');
  const at = args.indexOf('--consumer');
  const consumer = path.resolve(ROOT, at >= 0 ? args[at + 1] : (process.env.PAB_CONSUMER ?? '../record-replay'));
  const anyway = process.env[OVERRIDE] === '1';
  let result;
  try {
    result = check(consumer);
  } catch (e) {
    console.error(`release check failed: ${(e as Error).message}`);
    if (guard && !anyway) console.error(`npm publish stopped. Set ${OVERRIDE}=1 to publish without the check.`);
    process.exitCode = guard && anyway ? 0 : 1;
    return;
  }
  const { version, changes, others } = result;
  if (changes.length) {
    console.log(`changed since ${version} in what the recording tool uses:`);
    for (const c of changes) console.log(`  ${c}`);
    console.log(`${others} other files changed.\n=> publish: the recording tool gets these changes only from a new version`);
    return;
  }
  console.log(`nothing the recording tool uses changed since ${version} (${others} other files changed)\n=> no need to publish`);
  if (guard && !anyway) {
    console.error(`npm publish stopped. Set ${OVERRIDE}=1 to publish anyway, for a user other than the recording tool.`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
