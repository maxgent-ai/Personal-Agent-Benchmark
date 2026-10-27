import type { ItemResult, PageResult, RunResult } from './scoring';

/** report.html: a self-contained page rendered from result.json. */
export function renderReport(r: RunResult): string {
  const title = r.task.title ?? r.task.id;
  const required = r.items.filter((i) => i.required);
  const weighted = r.items.filter((i) => !i.required);
  const score = r.score === undefined ? 'not graded' : `${Math.round(r.score * 1000) / 10}%`;
  const summary = [
    required.length ? `required ${required.filter((i) => i.passed).length}/${required.length}` : '',
    weighted.length ? `weighted ${weighted.filter((i) => i.passed).length}/${weighted.length}` : '',
    `${r.pages.not_found.length} page${r.pages.not_found.length === 1 ? '' : 's'} returned 404`,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - run report</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">${esc(r.task.id)}</p>
  <h1>${esc(title)}</h1>
  <p class="meta">graded ${esc(r.graded_at)}${r.grader ? ` by ${esc(r.grader.model)} (${esc(r.grader.via)})` : ''}${r.replay_log ? ` · replay log ${esc(r.replay_log)}` : ''}</p>
</header>
<section class="score ${r.score === undefined ? 'none' : r.score > 0 ? 'ok' : 'bad'}">
  <div class="big">${esc(score)}</div>
  <div>${summary.map(esc).join(' · ')}</div>
</section>
${r.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('\n')}
<section>
  <h2>Pages that returned 404 <span class="count">${r.pages.not_found.length}</span></h2>
  <p class="hint">Pages the agent opened in a tab during the replay (not frames, scripts or styles) that came back 404. "not recorded": the recording has no copy, so recording it would let the agent see it. "recorded as 404": the site itself answered 404 while recording.</p>
  ${r.pages.not_found.length ? pageTable(r.pages.not_found, false) : '<p class="empty">None.</p>'}
</section>
${r.items.length ? `<section>
  <h2>Items</h2>
  <div class="table"><table>
    <thead><tr><th>Result</th><th>Item</th><th>Test</th><th>Reason</th></tr></thead>
    <tbody>${r.items.map(itemRow).join('')}</tbody>
  </table></div>
</section>` : ''}
${Object.keys(r.fields).length ? `<section>
  <h2>Extracted fields</h2>
  <div class="table"><table>
    <thead><tr><th>Field</th><th>Value</th></tr></thead>
    <tbody>${Object.entries(r.fields).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v === null ? '<span class="muted">not stated</span>' : esc(JSON.stringify(v))}</td></tr>`).join('')}</tbody>
  </table></div>
</section>` : ''}
<section>
  <details>
    <summary><h2>All pages opened <span class="count">${r.pages.opened.length}</span></h2></summary>
    ${r.pages.opened.length ? pageTable(r.pages.opened, true) : '<p class="empty">None.</p>'}
  </details>
</section>
${r.answer !== undefined ? `<section>
  <h2>Agent answer</h2>
  <pre class="answer">${esc(r.answer)}</pre>
</section>` : ''}
${r.task.prompt ? `<section>
  <details>
    <summary><h2>Task</h2></summary>
    <pre class="answer">${esc(r.task.prompt)}</pre>
  </details>
</section>` : ''}
</main>
</body>
</html>
`;
}

function itemRow(i: ItemResult): string {
  const tag = i.required ? 'required' : `weight ${i.weight}`;
  return `<tr class="${i.passed ? 'pass' : 'fail'}">
    <td><span class="badge">${i.passed ? 'pass' : 'fail'}</span></td>
    <td><code>${esc(i.id)}</code><div class="muted">${esc(i.kind)} · ${esc(tag)}</div></td>
    <td>${esc(i.test)}</td>
    <td>${esc(i.reason)}</td>
  </tr>`;
}

const SOURCE: Record<string, string> = { miss: 'not recorded', blocked: 'blocked by a rule' };

function pageTable(pages: PageResult[], all: boolean): string {
  const rows = pages.map((p) => {
    const how = p.status === 404 ? (p.source === 'miss' ? 'not recorded' : 'recorded as 404') : SOURCE[p.source] ?? p.source;
    return `<tr${p.status === 404 ? ' class="fail"' : ''}>
      ${all ? `<td>${p.status}</td>` : ''}
      <td>${esc(p.site)}</td>
      <td><div class="route">${p.method === 'GET' ? '' : `${esc(p.method)} `}${esc(p.route)}</div><div class="url muted">${esc(p.url)}</div></td>
      <td class="num">${p.count}</td>
      <td class="nowrap">${esc(how)}</td>
      <td class="muted nowrap">${esc(p.first.slice(11, 19))}</td>
    </tr>`;
  });
  return `<div class="table"><table>
    <thead><tr>${all ? '<th>Status</th>' : ''}<th>Site</th><th>Route</th><th>Times</th><th>${all ? 'Answered' : 'Why'}</th><th>First</th></tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const CSS = `
:root { --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --ok: #15803d; --ok-bg: #f0fdf4; --bad: #b91c1c; --bad-bg: #fef2f2; --none-bg: #f5f5f4; --code: #f5f5f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --panel: #262220; --text: #f5f5f4; --muted: #a8a29e; --line: #3a3532; --ok: #4ade80; --ok-bg: #14261b; --bad: #f87171; --bad-bg: #2d1717; --none-bg: #292524; --code: #322d2a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 4px 0 6px; }
h2 { font-size: 17px; margin: 0 0 8px; display: inline-block; }
section { margin-top: 28px; }
.eyebrow { margin: 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.meta, .hint, .muted { color: var(--muted); }
.meta { margin: 0; font-size: 12px; word-break: break-all; }
.hint { margin: 0 0 10px; font-size: 13px; }
.score { display: flex; gap: 20px; align-items: baseline; flex-wrap: wrap; padding: 16px 20px; border-radius: 10px; border: 1px solid var(--line); }
.score.ok { background: var(--ok-bg); } .score.bad { background: var(--bad-bg); } .score.none { background: var(--none-bg); }
.score .big { font-size: 32px; font-weight: 650; font-variant-numeric: tabular-nums; }
.score.ok .big { color: var(--ok); } .score.bad .big { color: var(--bad); }
.note { margin: 12px 0 0; padding: 10px 14px; border-left: 3px solid var(--bad); background: var(--panel); }
.count { display: inline-block; min-width: 22px; padding: 0 7px; margin-left: 4px; border-radius: 11px; background: var(--code); color: var(--muted); font-size: 12px; text-align: center; vertical-align: 2px; }
.table { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; }
td.nowrap, .nowrap { white-space: nowrap; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.url { font-size: 11.5px; word-break: break-all; margin-top: 2px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: var(--code); padding: 1px 5px; border-radius: 4px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
tr.pass .badge { color: var(--ok); background: var(--ok-bg); }
tr.fail .badge { color: var(--bad); background: var(--bad-bg); }
tr.fail td:first-child { box-shadow: inset 3px 0 0 var(--bad); }
.empty { color: var(--muted); margin: 0; }
details > summary { cursor: pointer; list-style-position: outside; margin-left: 16px; }
details[open] > summary { margin-bottom: 8px; }
pre.answer { white-space: pre-wrap; word-break: break-word; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin: 0; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
