import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { PACKAGE_ROOT } from '../paths';
import { CONTROL_HOST } from './engine';

export interface ReplayServerOptions {
  bundleDir: string;
  port: number;
  host?: string;
  logFile?: string;
  /** Rule directories layered over the bundle's own rules/ (later wins). */
  rulesDirs?: string[];
  /** compute.yaml to use instead of the bundle's own. */
  computePath?: string;
  /** whistle's data directory parent; defaults to a directory under the system temp dir. */
  stateDir?: string;
}

export interface ReplayServer {
  port: number;
  proxy: string;
  logFile?: string;
  whistleLog: string;
  child: ChildProcess;
  control<T = unknown>(pathname: string): Promise<T>;
  stop(): Promise<void>;
}

/** The single whistle rule: decrypt HTTPS and hand every request to the replay plugin. */
export const REPLAY_RULES = '/./ enable://capture bench-replay://\n';

/**
 * Starts an isolated whistle instance (own data dir, no global plugins) with the replay plugin.
 * Its DNS points at a dead address and proxy variables are removed, so a request that somehow
 * bypassed the plugin could not reach the internet either.
 */
export async function startReplayServer(o: ReplayServerOptions): Promise<ReplayServer> {
  const baseDir = path.join(o.stateDir ?? path.join(os.tmpdir(), 'pab'), 'whistle', String(o.port));
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.mkdirSync(baseDir, { recursive: true });
  const rulesFile = path.join(baseDir, 'replay.rules');
  fs.writeFileSync(rulesFile, REPLAY_RULES);
  const whistleLog = path.join(baseDir, 'whistle.log');
  const out = fs.openSync(whistleLog, 'a');

  const env: NodeJS.ProcessEnv = { ...process.env, RR_BUNDLE: path.resolve(o.bundleDir), RR_LOG: o.logFile ? path.resolve(o.logFile) : '', RR_RULES: (o.rulesDirs ?? []).map((d) => path.resolve(d)).join(':'),
    RR_COMPUTE: o.computePath ? path.resolve(o.computePath) : '',
    // inside an Electron app process.execPath is the app itself; this makes it behave as Node
    ELECTRON_RUN_AS_NODE: '1',
  };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  if (o.logFile) {
    fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
    fs.rmSync(o.logFile, { force: true });
  }

  const whistleBin = require.resolve('whistle/bin/whistle.js');
  const args = [
    whistleBin,
    'run',
    '-p', String(o.port),
    '-H', o.host ?? '127.0.0.1',
    '-D', baseDir,
    '-A', path.join(PACKAGE_ROOT, 'plugins'),
    '--no-global-plugins',
    '--no-prev-options',
    '-r', rulesFile,
    '-n', 'rr',
    '-w', randomBytes(12).toString('hex'),
    '--dnsServer', '127.0.0.1:9',
  ];
  // whistle's `run` forks its real server; a separate process group lets stop() take both down.
  // RR_NODE: the Node binary to run whistle with, when this process is not one (an app's helper)
  const child = spawn(process.env.RR_NODE || process.execPath, args, { env, stdio: ['ignore', out, out], detached: true });
  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };

  const control = <T>(pathname: string) => proxiedJson<T>(o.port, `http://${CONTROL_HOST}${pathname}`);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`whistle exited (${child.exitCode}); see ${whistleLog}`);
    try {
      const health = await control<{ ok: boolean }>('/health');
      if (health.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      killGroup('SIGTERM');
      throw new Error(`replay server did not become healthy; see ${whistleLog}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    port: o.port,
    proxy: `http://127.0.0.1:${o.port}`,
    logFile: o.logFile,
    whistleLog,
    child,
    control,
    stop: () =>
      new Promise<void>((resolve) => {
        const done = () => {
          killGroup('SIGTERM');
          resolve();
        };
        if (child.exitCode !== null) return done();
        child.once('exit', done);
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5000).unref();
      }),
  };
}

/** GET a URL through the proxy and parse JSON. */
export function proxiedJson<T>(port: number, url: string): Promise<T> {
  return proxiedRequest(port, url).then((r) => JSON.parse(r.body.toString('utf8')) as T);
}

export function proxiedRequest(port: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { Host: u.host, ...headers }, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
