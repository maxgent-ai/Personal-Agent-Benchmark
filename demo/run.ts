// One run: the task's replay, a Chrome window that goes through it, the agent driving that window
// through browser-use, then a report of what the recording could not answer.
//   node run.ts [--task <id>] [--repo <checkout>] [--model <openrouter id>|faux [--url <page>]] [--max-steps 40] [--keep-open]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAgent, stopHarness } from './agent.ts';
import { PAB_ROOT, pab } from './pab.ts';
import { writeReport } from './report.ts';

const { Repo, resolveTarget } = pab('tasks.js');
const { loadTarget } = pab('cli.js');
const { startReplayServer } = pab('replay/launcher.js');
const { launchBrowser } = pab('browser.js');

const HERE = import.meta.dirname;
if (fs.existsSync(path.join(HERE, '.env'))) process.loadEnvFile(path.join(HERE, '.env'));

const { values: a } = parseArgs({
  options: {
    task: { type: 'string', default: process.env.TASK || 'sony-xm5-price-compare' },
    repo: { type: 'string', default: process.env.PAB_REPO || PAB_ROOT },
    model: { type: 'string', default: process.env.MODEL || 'anthropic/claude-sonnet-5.5' },
    'max-steps': { type: 'string', default: '40' },
    port: { type: 'string', default: '18899' },
    'cdp-port': { type: 'string', default: '9333' },
    locale: { type: 'string', default: 'en-US' },
    timezone: { type: 'string', default: 'America/Chicago' },
    'keep-open': { type: 'boolean', default: false },
    // page the scripted run (--model faux) opens; default: the first page of the recording
    url: { type: 'string' },
  },
});
if (a.model !== 'faux' && !process.env.OPENROUTER_API_KEY) {
  console.error('OPENROUTER_API_KEY is not set: put it in demo/.env (see .env.example), or pass --model faux for a scripted run');
  process.exit(1);
}

const target = await resolveTarget(a.task, new Repo(path.resolve(a.repo)));
const { bundle, rules } = loadTarget(target);
const manifest = bundle.manifest();
const card = target.task?.card() ?? { id: a.task };
if (!card.prompt) throw new Error(`task ${a.task} has no prompt in task.yaml`);
const task = { id: card.id, title: card.title, prompt: card.prompt };

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dir = path.join(HERE, 'runs', `${a.task}-${stamp}`);
fs.mkdirSync(path.join(dir, 'browser-use'), { recursive: true });
const logFile = path.join(dir, 'replay.jsonl');
fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ task, repo: path.resolve(a.repo), model: a.model, started: new Date().toISOString() }, null, 2) + '\n');
const transcript = fs.createWriteStream(path.join(dir, 'transcript.jsonl'));

const server = await startReplayServer({ bundleDir: target.bundleDir, rulesDirs: target.rulesDirs, port: Number(a.port), logFile });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-demo-'));
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-')); // the daemon's socket path must stay short
const cdpPort = Number(a['cdp-port']);
const harnessEnv: NodeJS.ProcessEnv = { ...process.env };
delete harnessEnv.OPENROUTER_API_KEY;
delete harnessEnv.BROWSER_USE_API_KEY;
Object.assign(harnessEnv, {
  BU_CDP_URL: `http://127.0.0.1:${cdpPort}`,
  BH_RUNTIME_DIR: runtime,
  BH_AGENT_WORKSPACE: path.join(dir, 'browser-use'),
  BH_TELEMETRY: '0',
  BH_UPDATE_CHECK: '0',
  BH_TAB_MARKER: '0',
  BH_RECORD: '0',
  // whatever the agent's Python fetches on its own goes to the replay too, never to the internet
  HTTP_PROXY: server.proxy,
  HTTPS_PROXY: server.proxy,
  http_proxy: server.proxy,
  https_proxy: server.proxy,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
});

let context: { close(): Promise<void>; on(event: 'close', listener: () => void): void } | undefined;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
try {
  const browser = await launchBrowser({
    profileDir: profile,
    headless: false,
    proxy: { server: server.proxy },
    ignoreHTTPSErrors: true,
    locale: manifest.locale ?? a.locale,
    timezoneId: manifest.timezone ?? a.timezone,
    cdpPort,
  });
  context = browser;
  await browser.clock.install({ time: new Date(manifest.captured_from) });
  console.log(`task ${task.id}, recorded ${manifest.captured_from}; replay ${server.proxy}; browser CDP http://127.0.0.1:${cdpPort}`);
  console.log(`model ${a.model}; run directory ${dir}\n`);

  const result = await runAgent({
    prompt: task.prompt,
    model: a.model,
    harnessEnv,
    maxSteps: Number(a['max-steps']),
    startUrl: a.url ?? bundle.pages().find((p: { note?: string }) => p.note !== 'not-found-probe')?.url,
    signal: abort.signal,
    onEvent: (e) => {
      transcript.write(JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n');
      if (e.type === 'tool_call') console.log(`[step ${e.step}] ${String((e.args as { code?: string }).code ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 160)}`);
      if (e.type === 'tool_result' && e.isError) console.log(`  error: ${String(e.result ?? '').split('\n')[0].slice(0, 160)}`);
      if (e.type === 'assistant' && e.text) console.log(`\n${e.text}\n`);
      if (e.type === 'assistant' && e.error) console.log(`model error: ${e.error}`);
    },
  });
  fs.writeFileSync(path.join(dir, 'answer.md'), result.answer + '\n');
  console.log(`steps ${result.steps}, cost $${result.cost.toFixed(4)}${result.error ? `, error: ${result.error}` : ''}`);

  if (a['keep-open'] && !abort.signal.aborted) {
    console.log('The browser stays open; close it or press Ctrl-C to write the report.');
    await new Promise<void>((resolve) => {
      browser.on('close', () => resolve());
      abort.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }
} finally {
  await stopHarness(harnessEnv);
  await context?.close().catch(() => undefined);
  await server.stop();
  transcript.end();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(runtime, { recursive: true, force: true });
}

const answerFile = path.join(dir, 'answer.md');
const md = await writeReport({
  dir,
  task,
  answer: fs.existsSync(answerFile) ? fs.readFileSync(answerFile, 'utf8') : undefined,
  logFile,
  rules,
  probes: Object.values(manifest.not_found ?? {}),
});
console.log('\n' + md.split('\n## All pages opened')[0]);
console.log(`report: ${path.join(dir, 'coverage.md')}, ${path.join(dir, 'report.html')}`);
