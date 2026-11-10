// Runs dashboard: the batch control sheet (tally, exceptions) and the register of every run, plus the sample-batch runner.
import { api, html, money, dur, ago, stamp, pct, pen, miniStamp, copySwatch, outcomeOf, runsChanged, reasonLabel, humanize, SEVERITY } from './util.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['APPROVE', 'Approved', (r) => r.decision === 'APPROVE'],
  ['REVIEW', 'Held for review', (r) => r.decision === 'REVIEW'],
  ['REJECT', 'Rejected', (r) => r.decision === 'REJECT'],
  // v2 rows carry final_decision (null until a person decides); v1 rows only have review.
  ['awaiting', 'Awaiting a person', (r) => r.status !== 'error' && !r.superseded_by && r.decision === 'REVIEW' && ('final_decision' in r ? r.final_decision == null : !reviewOf(r))],
];

let root = null;
let timer = null;
let filter = 'all';
let demo = null; // { i, n, error } while the sample batch is running
let last = null; // { runs, stats }

export function mountRuns(main) {
  root = main;
  if (!last) root.innerHTML = html`<div class="page"><p class="loading muted"><span class="caret" aria-hidden="true"></span> Pulling the register…</p></div>`;
  else render();
  root.onclick = onClick;
  root.oninput = (e) => { if (e.target.id === 'reg-find') { query = e.target.value; renderRows(); } };
  load();
}
export function unmountRuns() { clearTimeout(timer); if (root) root.onclick = root.oninput = null; root = null; }

async function load() {
  clearTimeout(timer);
  try {
    const [runs, stats] = await Promise.all([api('/api/runs'), api('/api/stats')]);
    last = { runs: Array.isArray(runs) ? runs : runs?.runs || [], stats: stats || {} };
  } catch (e) {
    if (root) root.innerHTML = html`<div class="page"><div class="notice t-reject"><p class="notice-title">${pen('fail', 18)}Couldn't load the register</p><p>${e.message}. Check that the server is running, then reload.</p></div></div>`;
    return;
  }
  if (!root) return;
  render();
  loadTimings();
  if (demo || last.runs.some((r) => r.status === 'running')) timer = setTimeout(load, 1500);
}

// The list rows carry only the whole-run `ms`; the read/checks split needs each finished run's stages (they don't change once done).
// shortcut: one detail fetch per finished run, fine for a demo-sized register; upgrade to list fields if it grows.
const timings = new Map(); // id -> { read, cached, checks }
async function loadTimings() {
  const todo = last.runs.filter((r) => r.status !== 'running' && !timings.has(r.id));
  if (!todo.length) return;
  await Promise.all(todo.map(async (r) => {
    try {
      const d = await api(`/api/runs/${encodeURIComponent(r.id)}`);
      const ex = (d.stages || []).find((s) => s.key === 'extract');
      if (!ex || !['passed', 'warning'].includes(ex.status)) return timings.set(r.id, null);
      const x = ex.data || {};
      const checks = d.stages.reduce((a, s) => a + (s.key !== 'extract' && s.ms != null ? s.ms : 0), 0);
      timings.set(r.id, { cached: !!x.cached, read: x.cached ? x.originalLatencyMs ?? null : x.latencyMs ?? ex.ms, checks });
    } catch { /* keep the whole-run time */ }
  }));
  if (root && last) renderRows();
}

function timeCell(r) {
  if (r.status === 'running') return '';
  const t = timings.get(r.id);
  if (!t) return dur(r.ms);
  return html`${t.read != null ? dur(t.read) : ''}${t.cached ? html`<span class="inferred" title="Read from the cache; this is the first read's time">cached</span>` : ''}<span class="cell-sub">checks ${dur(t.checks)}</span>`;
}

let query = '';
const matches = (r) => {
  const q = query.trim().toLowerCase();
  return !q || [vendorOf(r), r.invoice_number, r.po_number, r.filename].some((v) => v && String(v).toLowerCase().includes(q));
};

function renderRows() {
  const tb = root?.querySelector('#reg-rows');
  if (!tb) return;
  const f = FILTERS.find(([k]) => k === filter) || FILTERS[0];
  const rows = last.runs.filter((r) => f[2](r) && matches(r));
  tb.innerHTML = rows.length ? html`${rows.map(row)}` : html`<tr><td colspan="10" class="muted pad-cell">${query.trim() ? 'Nothing in the register matches this search.' : 'Nothing in the register matches this filter.'}</td></tr>`;
}

const vendorOf = (r) => r.vendor_name || r.vendor?.name || r.vendor_id || 'Unknown vendor';
const routeOf = (r) => r.route ?? r.result?.route ?? null;
// List rows carry the main reason as an object ({code,label,severity,message}) or, in v1, sometimes a plain message string.
const reasonOf = (r) => {
  const m = r.main_reason ?? r.mainReason ?? r.result?.primaryReason ?? (r.result?.reasons || []).find((x) => x.severity !== 'info') ?? null;
  return typeof m === 'string' ? { code: null, message: m, severity: r.decision === 'REJECT' ? 'block' : 'hold' } : m;
};
const reviewOf = (r) => (typeof r.review === 'string' ? { action: r.review } : r.review || null);

function render() {
  const { runs, stats } = last;
  const focusKey = document.activeElement?.dataset?.fk;
  root.innerHTML = html`<div class="page runs-page">
    <header class="page-head">
      <div><h1 class="page-title">Batch control</h1><p class="page-sub">Every invoice through the desk: what was decided, where it went and why.</p></div>
      ${demo ? html`<p class="demo-progress" role="status">${demo.error ? html`<span class="error-text">${demo.error}</span>` : html`<span class="caret" aria-hidden="true"></span>Running the sample batch · <span class="typed">${demo.i} of ${demo.n}</span>`}</p>` : ''}
    </header>
    ${runs.length ? [overview(stats, runs), table(runs)] : empty()}
  </div>`;
  renderRows();
  const el = focusKey && root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
  el?.focus();
  if (el?.id === 'reg-find') el.setSelectionRange(el.value.length, el.value.length);
}

function overview(s, runs) {
  const by = s.byDecision || {};
  const decided = (by.APPROVE || 0) + (by.REVIEW || 0) + (by.REJECT || 0);
  const running = runs.filter((r) => r.status === 'running').length;
  const awaiting = s.final?.awaiting ?? s.awaitingReview ?? 0;
  const signedOff = s.humanReviewed ?? Math.max(0, (by.REVIEW || 0) - awaiting);
  const rejected = s.final?.rejected ?? by.REJECT ?? 0;
  const byPerson = Math.max(0, rejected - (by.REJECT || 0));
  const vals = Object.entries(s.valueApproved || {}).filter(([, v]) => v);
  const [first, ...rest] = vals;
  const cell = (label, value, sub, mark) => html`<div class="tcell">
    <dt class="fl">${mark ? html`<span class="tone-text t-${mark[1]}">${pen(mark[0], 14)}</span>` : ''}${label}</dt>
    <dd class="tval">${value}</dd><dd class="tsub">${sub}</dd></div>`;
  const reasons = (s.topReasons || []).filter((x) => x.severity !== 'info' && x.count > 0);
  const received = Math.max(1, s.total ?? runs.length); // bars are each exception's share of the batch
  return html`<section class="sheet batch" aria-labelledby="batch-title">
    <div class="sheet-head"><h2 class="sheet-title" id="batch-title">Batch control sheet</h2><span class="sheet-note">Halden Robotics · Accounts Payable</span></div>
    <dl class="tally">
      ${cell('Invoices received', s.total ?? runs.length, running ? `${running} processing now` : `${decided} decided by the rules`)}
      ${cell('Auto-approved', by.APPROVE ?? 0, decided ? `${pct(s.autoApprovalRate)} straight through` : 'Nothing decided yet', ['pass', 'approve'])}
      ${cell('Awaiting a person', awaiting, by.REVIEW ? `${signedOff} of ${by.REVIEW} held signed off` : 'Nothing held', ['warn', 'review'])}
      ${cell('Returned or rejected', rejected, by.REJECT || byPerson ? `${by.REJECT || 0} by the rules · ${byPerson} by a reviewer` : 'Nothing rejected', ['fail', 'reject'])}
      ${cell('Value approved', first ? money(first[1], first[0]) : money(0, 'USD'), rest.length ? `+ ${rest.map(([c, v]) => money(v, c)).join(' · ')}` : 'Scheduled for payment')}
      ${cell('Median read time', s.medianReadMs != null ? dur(s.medianReadMs) : '—', s.medianReadMs != null ? 'AI reading; the rules take under 50 ms' : 'AI extraction')}
    </dl>
    ${reasons.length ? html`<section class="exceptions" aria-labelledby="exc-title">
      <div class="exc-head"><h3 class="form-h" id="exc-title">Exceptions this batch</h3>
        <p class="legend"><span><i class="t-reject"></i>Blocks payment</span><span><i class="t-review"></i>Held for review</span></p></div>
      <ul class="exc-rows">${reasons.map((x) => { const sv = SEVERITY[x.severity] || SEVERITY.hold; return html`<li>
        <span class="exc-mark tone-text t-${sv.tone}">${pen(sv.mark, 16, sv.label)}</span>
        <span class="exc-label" title="${x.code} · ${sv.label}">${reasonLabel(x)}</span>
        <span class="exc-bar"><i class="t-${sv.tone}" style="width:${Math.min(1, x.count / received) * 100}%"></i></span>
        <span class="exc-count">${x.count} of ${received}</span></li>`; })}</ul>
      <p class="exc-foot">Each invoice counts once per kind of exception.</p>
    </section>` : ''}
  </section>`;
}

function table(runs) {
  return html`<section class="register" aria-labelledby="reg-title">
    <div class="reg-head"><h2 class="sheet-title" id="reg-title">Register</h2><span class="sheet-note">Newest first. Open a row to see its slip.</span></div>
    <div class="reg-tools">
      <div class="ftabs" role="group" aria-label="Filter the register">${FILTERS.map(([k, label, fn]) => html`<button type="button" class="ftab-btn" data-filter="${k}" data-fk="f-${k}" aria-pressed="${k === filter ? 'true' : 'false'}">${label} <span class="ftab-n">${runs.filter(fn).length}</span></button>`)}</div>
      <label class="fbox input-box reg-find"><span class="fl">Find in register</span><input type="search" id="reg-find" data-fk="find" value="${query}" placeholder="Vendor, invoice, PO or file" autocomplete="off"></label>
    </div>
    <div class="sheet reg-sheet"><div class="tbl-wrap"><table class="tbl reg-tbl">
      <thead><tr><th><span class="sr-only">Copy</span></th><th>Received</th><th>Vendor</th><th>Invoice no.</th><th class="r">Amount</th><th>PO</th><th>Outcome</th><th>Routed to</th><th>Main reason</th><th class="r">Time taken</th></tr></thead>
      <tbody id="reg-rows"></tbody>
    </table></div></div>
  </section>`;
}

function row(r) {
  const reason = reasonOf(r);
  const sv = reason ? SEVERITY[reason.severity] || SEVERITY.hold : null;
  const o = r.status === 'running' || r.status === 'error' ? null : outcomeOf(r);
  const human = o?.human;
  return html`<tr class="run-row">
    <td class="cell-sw">${o ? copySwatch(o.copy) : ''}</td>
    <td class="muted nowrap" title="${stamp(r.created_at)}">${ago(r.created_at)}</td>
    <td class="cell-vendor"><a class="row-link" href="#/run/${encodeURIComponent(r.id)}" data-fk="row-${r.id}">${vendorOf(r)}</a><span class="cell-file" title="${r.filename}">${r.filename || ''}</span></td>
    <td class="nowrap">${r.invoice_number || html`<span class="muted">—</span>`}</td>
    <td class="num">${r.total != null ? money(r.total, r.currency) : html`<span class="muted">—</span>`}</td>
    <td class="nowrap">${r.po_number || html`<span class="muted">—</span>`}${r.po_inferred ? html`<span class="inferred" title="PO inferred from lines and amount">inferred</span>` : ''}</td>
    <td class="cell-outcome">${miniStamp(r)}${human ? html`<span class="reviewed-line">Held, then ${human.decision === 'APPROVE' ? 'approved' : 'rejected'} by ${human.reviewer || 'a reviewer'}</span>` : ''}${r.superseded_by ? html`<span class="reviewed-line">Replaced by a retry</span>` : ''}</td>
    <td class="nowrap">${routeOf(r) || html`<span class="muted">—</span>`}</td>
    <td>${!reason ? html`<span class="muted">—</span>` : reason.code ? html`<span class="reason-cell" title="${reason.code}${reason.message ? ` · ${reason.message}` : ''}"><span class="tone-text t-${sv.tone}">${pen(sv.mark, 16, sv.label)}</span>${reason.label || humanize(reason.code)}</span>` : html`<span class="reason-text" title="${reason.message}">${reason.message}</span>`}</td>
    <td class="num muted cell-time">${timeCell(r)}</td>
  </tr>`;
}

function empty() {
  return html`<section class="sheet empty-sheet" aria-labelledby="empty-title">
    <h2 class="empty-title" id="empty-title">No invoices in this batch yet.</h2>
    <p class="muted">Run the sample invoices in order to fill the register. Each takes a few seconds.</p>
    <button type="button" class="btn primary" data-demo ${demo ? 'disabled' : ''}>${demo ? html`Running ${demo.i} of ${demo.n}…` : 'Run the sample batch'}</button>
  </section>`;
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
    demo = { ...demo, error: e.status === 429 ? e.message : `The sample batch stopped: ${e.message}` };
    setTimeout(() => { demo = null; if (root) render(); }, 6000);
  }
  runsChanged();
  if (root) load();
}
