import { spawn } from 'node:child_process';
import * as os from 'node:os';
import Anthropic from '@anthropic-ai/sdk';

/** The LLM that reads an agent's answer for grading (docs/grading.md). */
export interface Judge {
  /** How the model is reached ("api" or "claude-cli"), recorded with each result. */
  readonly via: string;
  readonly model: string;
  /** Asks once; the reply follows `schema`. Returns it and the model that answered. */
  ask(req: JudgeRequest): Promise<{ output: unknown; model: string }>;
}

export interface JudgeRequest {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * "api" (the Claude API, with ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN) or "cli" (a local
 * `claude` that is signed in). Without a choice: the API when a key is set, otherwise the CLI.
 */
export function pickJudge(kind?: string, model = DEFAULT_MODEL): Judge {
  const k = kind ?? (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 'api' : 'cli');
  if (k === 'api') return apiJudge(model);
  if (k === 'cli') return cliJudge(model);
  throw new Error(`unknown judge "${kind}" (api or cli)`);
}

export function apiJudge(model = DEFAULT_MODEL): Judge {
  const client = new Anthropic();
  return {
    via: 'api',
    model,
    async ask({ system, prompt, schema }) {
      const msg = await client.beta.messages
        .stream({
          model,
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content: prompt }],
          output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
          // a declined request is re-run on Anthropic's recommended fallback model
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
        .finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error(`the grader declined: ${msg.stop_details?.explanation ?? 'no reason given'}`);
      if (msg.stop_reason === 'max_tokens') throw new Error('the grader ran out of output tokens');
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { output: JSON.parse(text), model: msg.model };
    },
  };
}

/** `claude -p` with no tools, run outside any project so no project instructions are read. */
export function cliJudge(model = DEFAULT_MODEL, bin = process.env.PAB_CLAUDE_BIN ?? 'claude'): Judge {
  return {
    via: 'claude-cli',
    model,
    async ask({ system, prompt, schema }) {
      const args = ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', system, '--json-schema', JSON.stringify(schema)];
      const out = await run(bin, args, prompt);
      let reply: { is_error?: boolean; result?: string; structured_output?: unknown; modelUsage?: Record<string, unknown> };
      try {
        reply = JSON.parse(out);
      } catch {
        throw new Error(`${bin} -p did not return JSON: ${out.slice(0, 300)}`);
      }
      if (reply.is_error || reply.structured_output === undefined) throw new Error(`${bin} -p failed: ${(reply.result ?? out).slice(0, 300)}`);
      return { output: reply.structured_output, model: Object.keys(reply.modelUsage ?? {})[0] ?? model };
    },
  };
}

function run(bin: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], timeout: 10 * 60_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`cannot run ${bin}: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited with ${code}: ${(err || out).slice(0, 300)}`))));
    child.stdin.end(input);
  });
}
