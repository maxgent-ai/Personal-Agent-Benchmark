import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { ReplayEngine } from './engine';

/**
 * whistle plugin entry (whistle.bench-replay). The only whistle rule is
 * `/./ enable://capture bench-replay://`, so every request arrives here and is
 * answered from the bundle; nothing is forwarded upstream.
 *
 * Configuration comes from the environment of the whistle process:
 *   RR_BUNDLE   bundle directory (required)
 *   RR_LOG      JSONL request log (optional)
 *   RR_RULES    extra rule directories, separated by ":" (optional)
 *   RR_CLOCK    "off" to leave page clocks alone (default: shift them to the recording time)
 */
interface WhistleRequest extends IncomingMessage {
  originalReq?: { fullUrl?: string; url?: string; method?: string; headers?: Record<string, string | string[]> };
  fullUrl?: string;
}

let enginePromise: Promise<ReplayEngine> | undefined;

function engine(): Promise<ReplayEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const bundle = process.env.RR_BUNDLE;
      if (!bundle) throw new Error('RR_BUNDLE is not set for the whistle process');
      const e = new ReplayEngine(bundle, {
        logFile: process.env.RR_LOG || undefined,
        rulesDirs: (process.env.RR_RULES ?? '').split(':').filter(Boolean),
        clock: process.env.RR_CLOCK === 'off' ? 'off' : 'recorded',
      });
      await e.warmUp();
      return e;
    })();
  }
  return enginePromise;
}

function cleanHeaders(headers: IncomingMessage['headers']): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith('x-whistle') || lower.startsWith('x-forwarded-') || lower === 'proxy-connection') continue;
    out[k] = v;
  }
  return out;
}

function toNodeHeaders(list: [string, string][]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of list) {
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

export async function handleWhistleRequest(req: WhistleRequest, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const url = req.originalReq?.fullUrl ?? req.fullUrl ?? req.url ?? '';
  const method = req.originalReq?.method ?? req.method ?? 'GET';
  try {
    const e = await engine();
    const out = await e.handle({ method, url, headers: cleanHeaders(req.headers), body: chunks.length ? Buffer.concat(chunks) : undefined });
    res.writeHead(out.status, out.statusText || undefined, toNodeHeaders(out.headers));
    res.end(out.body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`replay error: ${(err as Error).message}`);
  }
}

export function server(srv: Server): void {
  void engine().catch((err) => console.error('[bench-replay]', err));
  srv.on('request', (req: WhistleRequest, res: ServerResponse) => {
    void handleWhistleRequest(req, res);
  });
}
