// A minimal pi agent whose only tool is the browser: each call runs a short Python snippet in the
// browser-use harness (`browser-use` CLI), which drives the Chrome window of the replay over CDP.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createModels, Type } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';

export interface AgentOptions {
  prompt: string;
  /** An OpenRouter model id, or "faux" for a scripted run that needs no key. */
  model: string;
  /** Environment for `browser-use`: where the browser is, and where its daemon keeps state. */
  harnessEnv: NodeJS.ProcessEnv;
  maxSteps: number;
  /** URL the scripted run opens. */
  startUrl?: string;
  signal?: AbortSignal;
  onEvent: (event: Record<string, unknown>) => void;
}

export interface AgentResult {
  answer: string;
  steps: number;
  cost: number;
  error?: string;
}

const HARNESS = path.join(import.meta.dirname, '.venv', 'bin', 'browser-use');
const OUTPUT_LIMIT = 8000;
const CALL_TIMEOUT_MS = 90_000;

const SYSTEM = `You are a personal shopping assistant. You have one tool, \`browser\`, that runs a short Python snippet against a Chrome window through the browser-use harness. The user watches that window.

Using the browser:
- Helpers are pre-imported; only what you print() comes back. Keep printed output short and targeted.
- Open the first page with new_tab(url); after that navigate in the same tab with goto_url(url). Call wait_for_load() after every navigation, and wait_for_element(css) when content renders late.
- Read pages with js(...), for example print(js("document.body.innerText.slice(0, 4000)")), or collect titles, prices and links with document.querySelectorAll in one js call.
- To click, get the element's centre from getBoundingClientRect() in js, then click_at_xy(x, y). To type, click the field, then type_text("...") and press_key("Enter").
- page_info() returns url, title and scroll position; scroll(x, y, dy=600) scrolls.
- Only the browser may load pages: do not use http_get, urllib, requests or any other HTTP client.

Rules:
- Shop like a careful person: search, open product pages, compare offers from several stores.
- Never sign in, never enter payment or personal details, never place an order.
- If a page fails to load, is empty, or shows a captcha or error, say so briefly and move on.
- Finish with a short answer in the user's language: the cheapest offer (store, price, link) and the other prices you saw.`;

const BrowserParams = Type.Object({ code: Type.String({ description: 'Python code; browser helpers are pre-imported' }) });

const browserTool = (env: NodeJS.ProcessEnv): AgentTool<typeof BrowserParams> => ({
  name: 'browser',
  label: 'Browser',
  description: 'Run a Python snippet in the browser-use harness against the Chrome window. Returns what the snippet prints.',
  parameters: BrowserParams,
  executionMode: 'sequential',
  execute: async (_id, { code }, signal) => {
    if (/\bhttp_get\s*\(/.test(code)) throw new Error('http_get loads pages outside the browser and is disabled here; open the page in the browser instead');
    const r = await runHarness(code, env, signal);
    const out = clip([r.stdout.trim(), r.stderr.trim() && `[stderr]\n${r.stderr.trim()}`].filter(Boolean).join('\n'));
    if (r.exit !== 0) throw new Error(out || `browser-use exited with ${r.exit}`);
    return { content: [{ type: 'text', text: out || '(nothing printed)' }], details: { exit: r.exit } };
  },
});

export function runHarness(code: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exit: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(HARNESS, [], { env, signal, timeout: CALL_TIMEOUT_MS });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (exit) => resolve({ exit: exit ?? -1, stdout, stderr }));
    child.stdin.end(code);
  });
}

/** Stops the harness daemon that the browser calls started. */
export function stopHarness(env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve) => spawn(HARNESS, ['--reload'], { env, stdio: 'ignore', timeout: 15_000 }).on('close', () => resolve()).on('error', () => resolve()));
}

const clip = (s: string) => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n... (${s.length - OUTPUT_LIMIT} more characters cut)` : s);

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const models = createModels();
  let model;
  if (o.model === 'faux') {
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses(scripted(o.startUrl ?? 'about:blank'));
    model = faux.getModel();
  } else {
    models.setProvider(openrouterProvider());
    model = models.getModel('openrouter', o.model);
    if (!model) throw new Error(`unknown OpenRouter model "${o.model}" (pi-ai catalog)`);
  }

  let steps = 0;
  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, model, tools: [browserTool(o.harnessEnv)] },
    streamFn: models.streamSimple.bind(models),
    toolExecution: 'sequential',
    // past the step budget, tool calls are refused so the model has to answer
    beforeToolCall: async () => (steps >= o.maxSteps ? { block: true, reason: 'Step limit reached. Stop browsing and give your final answer now.' } : undefined),
    finishTurn: async ({ message }) => (steps >= o.maxSteps + 3 && message.stopReason !== 'error' && message.stopReason !== 'aborted' ? { action: 'end' } : undefined),
  });
  agent.subscribe((e) => {
    if (e.type === 'tool_execution_start') {
      steps++;
      o.onEvent({ type: 'tool_call', step: steps, args: e.args });
    } else if (e.type === 'tool_execution_end') {
      o.onEvent({ type: 'tool_result', step: steps, isError: e.isError, result: e.result?.content?.map((c: { type: string; text?: string }) => c.text ?? `[${c.type}]`).join('\n') });
    } else if (e.type === 'message_end' && e.message.role === 'assistant') {
      const text = textOf(e.message);
      o.onEvent({ type: 'assistant', text, stopReason: e.message.stopReason, usage: e.message.usage, error: e.message.errorMessage });
    }
  });

  o.signal?.addEventListener('abort', () => agent.abort(), { once: true });
  o.onEvent({ type: 'start', model: o.model });
  await agent.prompt(o.prompt);
  const messages = agent.state.messages;
  const assistants = messages.filter((m) => m.role === 'assistant');
  const last = assistants.at(-1);
  return {
    answer: last ? textOf(last) : '',
    steps,
    cost: assistants.reduce((sum, m) => sum + (m.role === 'assistant' ? m.usage?.cost?.total ?? 0 : 0), 0),
    error: agent.state.errorMessage,
  };
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === 'string') return m.content;
  return (m.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('');
}

// A fixed run for checking the setup without a model: open the start page, read it, answer.
function scripted(url: string) {
  return [
    fauxAssistantMessage([fauxText('Opening the page.'), fauxToolCall('browser', { code: `new_tab(${JSON.stringify(url)})\nwait_for_load()\nprint(page_info())` })]),
    fauxAssistantMessage(fauxToolCall('browser', { code: 'print(js("document.body.innerText.slice(0, 1500)"))' })),
    fauxAssistantMessage('Scripted run finished: the start page was opened and read.'),
  ];
}
