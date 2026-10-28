import type { ItemResult, PageResult, RunResult, RunStats } from './scoring';

/** report.html: a self-contained page rendered from result.json. */
export function renderReport(r: RunResult): string {
  const title = r.task.title ?? r.task.id;
  const required = r.items.filter((i) => i.required);
  const weighted = r.items.filter((i) => !i.required);
  const score = r.score === undefined ? '未评分' : `${Math.round(r.score * 1000) / 10}%`;
  const summary = [
    required.length ? `必过项 ${required.filter((i) => i.passed).length}/${required.length}` : '',
    weighted.length ? `加分项 ${weighted.filter((i) => i.passed).length}/${weighted.length}` : '',
    `${r.pages.not_found.length} 个页面返回 404`,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - 评测报告</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">${esc(r.task.id)}</p>
  <h1>${esc(title)}</h1>
  <p class="meta">评分时间 ${esc(r.graded_at)}${r.grader ? ` · 评分模型 ${esc(r.grader.model)}（${esc(r.grader.via)}）` : ''}${r.replay_log ? ` · 回放日志 ${esc(r.replay_log)}` : ''}</p>
</header>
<section class="score ${r.score === undefined ? 'none' : r.score > 0 ? 'ok' : 'bad'}">
  <div class="big">${esc(score)}</div>
  <div>${summary.map(esc).join(' · ')}</div>
</section>
${r.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('\n')}
${r.run ? runSection(r.run) : ''}
<section>
  <h2>返回 404 的页面 <span class="count">${r.pages.not_found.length}</span></h2>
  <p class="hint">回放时 agent 在标签页里打开、结果返回 404 的页面（不含 iframe、脚本和样式）。“没有录制”：录制里没有这个页面，补录后 agent 就能看到；“录制时就是 404”：录制时网站本身返回的就是 404。</p>
  ${r.pages.not_found.length ? pageTable(r.pages.not_found, false) : '<p class="empty">无。</p>'}
</section>
${r.items.length ? `<section>
  <h2>评分项</h2>
  <div class="table"><table>
    <thead><tr><th>结果</th><th>评分项</th><th>检查内容</th><th>理由</th></tr></thead>
    <tbody>${r.items.map(itemRow).join('')}</tbody>
  </table></div>
</section>` : ''}
${Object.keys(r.fields).length ? `<section>
  <h2>从回答中提取的字段</h2>
  <div class="table"><table>
    <thead><tr><th>字段</th><th>值</th></tr></thead>
    <tbody>${Object.entries(r.fields).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v === null ? '<span class="muted">回答中没有</span>' : esc(JSON.stringify(v))}</td></tr>`).join('')}</tbody>
  </table></div>
</section>` : ''}
<section>
  <details>
    <summary><h2>打开过的全部页面 <span class="count">${r.pages.opened.length}</span></h2></summary>
    ${r.pages.opened.length ? pageTable(r.pages.opened, true) : '<p class="empty">无。</p>'}
  </details>
</section>
${r.answer !== undefined ? `<section>
  <h2>Agent 的回答</h2>
  <pre class="answer">${esc(r.answer)}</pre>
</section>` : ''}
${r.task.prompt ? `<section>
  <details>
    <summary><h2>题目</h2></summary>
    <pre class="answer">${esc(r.task.prompt)}</pre>
  </details>
</section>` : ''}
</main>
</body>
</html>
`;
}

function runSection(s: RunStats): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const rows: [string, string | undefined][] = [
    ['模型', s.model],
    ['开始', clock(s.started)],
    ['完成', clock(s.finished)],
    ['用时', s.duration_ms === undefined ? undefined : duration(s.duration_ms)],
    ['步数', s.steps === undefined ? undefined : String(s.steps)],
    ['Token 合计', s.tokens && n(s.tokens.total)],
    ['输入（不含缓存）', s.tokens && n(s.tokens.input)],
    ['缓存读取', s.tokens?.cache_read === undefined ? undefined : n(s.tokens.cache_read)],
    ['缓存写入', s.tokens?.cache_write === undefined ? undefined : n(s.tokens.cache_write)],
    ['输出', s.tokens && n(s.tokens.output)],
    ['费用', s.cost_usd === undefined ? undefined : `$${s.cost_usd.toFixed(4)}`],
  ];
  return `<section>
  <h2>运行情况</h2>
  <p class="hint">从 agent 收到题目到给出回答，由运行 agent 的程序统计。</p>
  <div class="table"><table class="facts"><tbody>${rows.filter(([, v]) => v !== undefined).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>
</section>`;
}

const clock = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} 秒`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function itemRow(i: ItemResult): string {
  const tag = i.required ? '必过' : `权重 ${i.weight}`;
  return `<tr class="${i.passed ? 'pass' : 'fail'}">
    <td><span class="badge">${i.passed ? '通过' : '不通过'}</span></td>
    <td><code>${esc(i.id)}</code><div class="muted">${esc(KIND[i.kind])} · ${esc(tag)}</div></td>
    <td>${esc(i.test)}</td>
    <td>${esc(i.reason)}</td>
  </tr>`;
}

const KIND: Record<ItemResult['kind'], string> = { require: '程序比对', check: '模型判断', trace: '请求记录' };

/** How replay answered a page (PageResult.source). */
const SOURCE: Record<string, string> = { exact: '精确命中', fuzzy: '相近页面', search: '相近搜索词', promo: '优惠码录制', blocked: '被规则拦截', miss: '没有录制' };

function pageTable(pages: PageResult[], all: boolean): string {
  const rows = pages.map((p) => {
    const how = p.status === 404 ? (p.source === 'miss' ? '没有录制' : '录制时就是 404') : SOURCE[p.source] ?? p.source;
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
    <thead><tr>${all ? '<th>状态</th>' : ''}<th>站点</th><th>路由</th><th>次数</th><th>${all ? '应答方式' : '原因'}</th><th>首次打开</th></tr></thead>
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
table.facts th { width: 160px; font-size: 13px; font-weight: 500; }
table.facts td { font-variant-numeric: tabular-nums; }
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
