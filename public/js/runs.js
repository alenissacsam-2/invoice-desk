// Runs dashboard: KPIs, hold/reject reasons, filterable history table, demo-set runner.
import { api, html, money, dur, ago, stamp, pct, icon, decisionChip, runsChanged, SEVERITY, DECISION } from './util.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['APPROVE', 'Approved', (r) => r.decision === 'APPROVE'],
  ['REVIEW', 'Review', (r) => r.decision === 'REVIEW'],
  ['REJECT', 'Rejected', (r) => r.decision === 'REJECT'],
  ['awaiting', 'Awaiting human', (r) => r.decision === 'REVIEW' && !r.review],
];

let root = null;
let timer = null;
let filter = 'all';
let demo = null; // { i, n, error } while "Run the demo set" is going
let last = null; // { runs, stats }

export function mountRuns(main) {
  root = main;
  if (!last) root.innerHTML = html`<div class="page"><p class="muted"><span class="spin sm"></span> Loading runs…</p></div>`;
  else render();
  root.onclick = onClick;
  load();
}
export function unmountRuns() { clearTimeout(timer); if (root) root.onclick = null; root = null; }

async function load() {
  clearTimeout(timer);
  try {
    const [runs, stats] = await Promise.all([api('/api/runs'), api('/api/stats')]);
    last = { runs: Array.isArray(runs) ? runs : runs?.runs || [], stats: stats || {} };
  } catch (e) {
    if (root) root.innerHTML = html`<div class="page"><div class="callout t-reject"><div class="callout-title">${icon('failed', 14)} Couldn't load runs</div><p>${e.message}. Check that the server is running, then reload.</p></div></div>`;
    return;
  }
  if (!root) return;
  render();
  if (demo || last.runs.some((r) => r.status === 'running')) timer = setTimeout(load, 1500);
}

const vendorOf = (r) => r.vendor_name || r.vendor?.name || r.vendor_id || 'Unknown vendor';
const routeOf = (r) => r.route ?? r.result?.route ?? null;
const reasonOf = (r) => r.main_reason ?? (r.result?.reasons || []).find((x) => x.severity !== 'info') ?? null;

function render() {
  const { runs, stats } = last;
  const focusKey = document.activeElement?.dataset?.fk;
  root.innerHTML = html`<div class="page runs-page">
    <header class="page-head">
      <div><h1 class="page-title">Runs</h1><p class="page-sub">History, status and outputs across every invoice processed.</p></div>
      ${demo ? html`<p class="demo-progress">${demo.error ? html`<span class="error-text">${demo.error}</span>` : html`<span class="spin sm"></span> Running the demo set · <span class="mono">${demo.i} of ${demo.n}</span>`}</p>` : ''}
    </header>
    ${runs.length ? [overview(stats, runs), table(runs)] : empty()}
  </div>`;
  if (focusKey) root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}

function overview(s, runs) {
  const by = s.byDecision || {};
  const decided = (by.APPROVE || 0) + (by.REVIEW || 0) + (by.REJECT || 0);
  const running = runs.filter((r) => r.status === 'running').length;
  const vals = Object.entries(s.valueApproved || {}).filter(([, v]) => v);
  const [first, ...rest] = vals;
  const tile = (label, value, sub, tone) => html`<div class="kpi card">
    <div class="kpi-label">${tone ? html`<span class="tone-text t-${DECISION[tone].tone}">${icon(DECISION[tone].icon, 12)}</span>` : ''}${label}</div>
    <div class="kpi-value mono">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  const reasons = (s.topReasons || []).filter((x) => x.severity !== 'info' && x.count > 0);
  const max = Math.max(1, ...reasons.map((x) => x.count));
  return html`<section class="overview ${reasons.length ? '' : 'solo'}" aria-label="Summary">
    <div class="kpis">
      ${tile('Invoices processed', s.total ?? runs.length, running ? `${running} running now` : `${decided} decided`)}
      ${tile('Auto-approved', by.APPROVE ?? 0, decided ? `${pct(s.autoApprovalRate)} straight through` : 'Nothing decided yet', 'APPROVE')}
      ${tile('On hold', by.REVIEW ?? 0, `${s.awaitingReview ?? 0} awaiting a person`, 'REVIEW')}
      ${tile('Rejected', by.REJECT ?? 0, 'Blocked before payment', 'REJECT')}
      ${tile('Value approved', first ? money(first[1], first[0]) : money(0, 'USD'), rest.length ? html`<span class="mono">+ ${rest.map(([c, v]) => money(v, c)).join(' · ')}</span>` : 'Scheduled for payment')}
      ${tile('Median processing', s.medianMs != null ? dur(s.medianMs) : '—', 'Per invoice, end to end')}
    </div>
    ${reasons.length ? html`<div class="card reasons-card">
      <h2 class="section-title">Why invoices were held or rejected</h2>
      <ul class="bars">${reasons.map((x) => { const sv = SEVERITY[x.severity] || SEVERITY.hold; return html`<li>
        <span class="bar-label code" title="${sv.label}">${x.code}</span>
        <span class="bar-track"><i class="t-${sv.tone}" style="width:${(x.count / max) * 100}%"></i></span>
        <span class="bar-count mono">${x.count}</span></li>`; })}</ul>
      <p class="legend"><span><i class="t-reject"></i>Blocks payment</span><span><i class="t-review"></i>Hold for review</span></p>
    </div>` : ''}
  </section>`;
}

function table(runs) {
  const f = FILTERS.find(([k]) => k === filter) || FILTERS[0];
  const rows = runs.filter(f[2]);
  return html`<div class="filters" role="group" aria-label="Filter runs">${FILTERS.map(([k, label, fn]) => html`<button type="button" class="filter" data-filter="${k}" data-fk="f-${k}" aria-pressed="${k === filter ? 'true' : 'false'}">${label} <span class="mono filter-n">${runs.filter(fn).length}</span></button>`)}</div>
  <div class="card tbl-card"><div class="tbl-wrap"><table class="tbl runs-tbl">
    <thead><tr><th>Time</th><th>Vendor</th><th>Invoice #</th><th class="r">Amount</th><th>PO</th><th>Decision</th><th>Routed to</th><th>Main reason</th><th class="r">Duration</th></tr></thead>
    <tbody>${rows.length ? rows.map(row) : html`<tr><td colspan="9" class="muted pad-cell">No runs match this filter.</td></tr>`}</tbody>
  </table></div></div>`;
}

function row(r) {
  const reason = reasonOf(r);
  const sv = reason ? SEVERITY[reason.severity] || SEVERITY.hold : null;
  const rv = r.review;
  return html`<tr class="run-row">
    <td class="mono muted nowrap" title="${stamp(r.created_at)}">${ago(r.created_at)}</td>
    <td class="cell-vendor"><a class="row-link" href="#/run/${encodeURIComponent(r.id)}" data-fk="row-${r.id}">${vendorOf(r)}</a><span class="cell-file mono" title="${r.filename}">${r.filename || ''}</span></td>
    <td class="mono nowrap">${r.invoice_number || html`<span class="muted">—</span>`}</td>
    <td class="num">${r.total != null ? money(r.total, r.currency) : html`<span class="muted">—</span>`}</td>
    <td class="mono nowrap">${r.po_number || html`<span class="muted">—</span>`}${r.po_inferred ? html`<span class="inferred" title="PO inferred from lines and amount">inferred</span>` : ''}</td>
    <td class="nowrap">${decisionChip(r.decision, r.status)}${rv ? html`<span class="reviewed-line tone-text t-${rv.action === 'approve' ? 'approve' : 'reject'}">→ ${rv.action === 'approve' ? 'Approved' : 'Rejected'} by reviewer</span>` : ''}</td>
    <td class="nowrap">${routeOf(r) || html`<span class="muted">—</span>`}</td>
    <td>${reason ? html`<span class="code tone-text t-${sv.tone}" title="${reason.message || ''}">${reason.code}</span>` : html`<span class="muted">—</span>`}</td>
    <td class="num muted">${r.status === 'running' ? '' : dur(r.ms)}</td>
  </tr>`;
}

function empty() {
  return html`<div class="card empty-card">
    <h2 class="empty-title">No runs yet.</h2>
    <p class="muted">Process the nine sample invoices in order to fill the dashboard. Each run takes a few seconds.</p>
    <button type="button" class="btn primary" data-demo ${demo ? 'disabled' : ''}>${demo ? html`<span class="spin sm"></span> Running ${demo.i} of ${demo.n}…` : 'Run the demo set'}</button>
  </div>`;
}

function onClick(e) {
  const f = e.target.closest('[data-filter]');
  if (f) { filter = f.dataset.filter; render(); return; }
  if (e.target.closest('[data-demo]')) runDemo();
}

async function runDemo() {
  if (demo) return;
  demo = { i: 0, n: 0 };
  try {
    const samples = await api('/api/samples');
    demo.n = samples.length;
    for (const [i, s] of samples.entries()) {
      demo.i = i + 1;
      if (root) render();
      const { id } = await api(`/api/runs?sample=${encodeURIComponent(s.file)}`, { method: 'POST' });
      runsChanged();
      if (root) load();
      // Wait for each run to finish: later samples depend on earlier ones (duplicate, split invoice).
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 800));
        const r = await api(`/api/runs/${encodeURIComponent(id)}`);
        if (r.status !== 'running') break;
      }
    }
    demo = null;
  } catch (e) {
    demo = { ...demo, error: `Demo set stopped: ${e.message}` };
    setTimeout(() => { demo = null; if (root) render(); }, 6000);
  }
  runsChanged();
  if (root) load();
}
