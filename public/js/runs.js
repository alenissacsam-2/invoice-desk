// Runs dashboard: the batch control sheet (tally, outcome strip, exception kinds) and the register of every run, plus the sample-batch runner.
import { api, html, raw, money, dur, ago, stamp, pct, pen, miniStamp, copySwatch, outcomeOf, runsChanged, reasonLabel, humanize, SEVERITY, DECISION } from './util.js';

const FILTERS = [
  ['all', 'All', () => true],
  ['APPROVE', 'Approved', (r) => r.decision === 'APPROVE'],
  ['REVIEW', 'On hold', (r) => r.decision === 'REVIEW'],
  ['REJECT', 'Rejected', (r) => r.decision === 'REJECT'],
  // v2 rows carry final_decision (null until a person decides); v1 rows only have review.
  ['awaiting', 'Awaiting a person', (r) => r.status !== 'error' && !r.superseded_by && r.decision === 'REVIEW' && ('final_decision' in r ? r.final_decision == null : !reviewOf(r))],
];
const EMPTY = {
  all: 'Nothing in the register yet.', APPROVE: 'Nothing approved yet.', REVIEW: 'Nothing on hold.',
  REJECT: 'Nothing rejected.', awaiting: 'Nothing waiting on a person.',
};
const awaitingFn = FILTERS.find(([k]) => k === 'awaiting')[2];

let root = null;
let timer = null;
let filter = 'all';
let seg = null; // outcome strip filter: APPROVE | REVIEW | REJECT, by the stamp a run carries now
let reason = null; // exception-kind filter: the row's main reason code
let demo = null; // { i, n, error } while the sample batch is running
let last = null; // { runs, stats, at }
let showReplaced = false; // replayed or retried runs (superseded_by set) stay out of the register unless asked for
const live = (runs) => runs.filter((r) => !r.superseded_by);
const outcomeNow = (r) => (r.status === 'running' || r.status === 'error' ? null : outcomeOf(r));
const hm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const age = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : ms < 864e5 ? `${Math.round(ms / 3600e3)} h` : `${Math.round(ms / 864e5)} d`);

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
    last = { runs: Array.isArray(runs) ? runs : runs?.runs || [], stats: stats || {}, at: Date.now() };
  } catch (e) {
    if (root) root.innerHTML = html`<div class="page"><div class="notice t-reject"><p class="notice-title">${pen('fail', 18)}Couldn't load the register</p><p>${e.message}. Check that the server is running, then reload.</p></div></div>`;
    return;
  }
  if (!root) return;
  // Once the register is on screen, a reload (the 1.5 s poll) only refreshes it in place so focus, hover and the search survive.
  if (last.runs.length && root.querySelector('#reg-rows')) refresh(); else render();
  if (demo || last.runs.some((r) => r.status === 'running')) timer = setTimeout(load, 1500);
}

let query = '';
const matches = (r) => {
  const q = query.trim().toLowerCase();
  return !q || [vendorOf(r), r.invoice_number, r.po_number, r.filename].some((v) => v && String(v).toLowerCase().includes(q));
};

const rowsSig = new WeakMap(); // tbody -> the rows HTML it shows
function renderRows() {
  const tb = root?.querySelector('#reg-rows');
  if (!tb) return;
  const f = FILTERS.find(([k]) => k === filter) || FILTERS[0];
  const rows = (showReplaced ? last.runs : live(last.runs)).filter((r) => f[2](r) && (!seg || outcomeNow(r)?.decision === seg) && (!reason || reasonOf(r)?.code === reason) && matches(r));
  const none = query.trim() ? 'No invoice in the register matches this search.' : seg || reason ? 'Nothing in the register under this filter. Clear it to see the whole batch.' : EMPTY[filter] || EMPTY.all;
  const next = String(rows.length ? html`${rows.map(row)}` : html`<tr class="reg-empty"><td colspan="7">${none}</td></tr>`);
  if (rowsSig.get(tb) === next) return; // unchanged rows keep their DOM, so focus and hover stay put
  const fk = tb.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  rowsSig.set(tb, next);
  tb.innerHTML = next;
  if (fk) tb.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
}

/** A filter change: mark the pressed controls, show or hide the clear link, redraw only the rows. */
function applyFilters() {
  const press = (sel, key, v) => root.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[key] === v)));
  press('[data-filter]', 'filter', filter);
  press('[data-seg]', 'seg', seg);
  press('[data-reason]', 'reason', reason);
  const c = root.querySelector('[data-clear]');
  if (c) { c.hidden = !(seg || reason); c.textContent = clearLabel(); }
  renderRows();
}
const clearLabel = () => (seg ? `Clear: ${DECISION[seg].word}` : reason ? `Clear: ${reasonLabel(kindsOf(live(last.runs)).find((k) => k.code === reason) || { code: reason })}` : 'Clear filter');

const vendorOf = (r) => r.vendor_name || r.vendor?.name || r.vendor_id || 'Unknown vendor';
const routeOf = (r) => r.route ?? r.result?.route ?? null;
// List rows carry the main reason as an object ({code,label,severity,message}) or, in v1, sometimes a plain message string.
const reasonOf = (r) => {
  const m = r.main_reason ?? r.mainReason ?? r.result?.primaryReason ?? (r.result?.reasons || []).find((x) => x.severity !== 'info') ?? null;
  return typeof m === 'string' ? { code: null, message: m, severity: r.decision === 'REJECT' ? 'block' : 'hold' } : m;
};
const reviewOf = (r) => (typeof r.review === 'string' ? { action: r.review } : r.review || null);

/** Exception kinds from the live runs' main reasons, so a chip's ×n is exactly what its filter shows. */
function kindsOf(runs) {
  const m = new Map();
  for (const r of runs) {
    const x = reasonOf(r);
    if (!x?.code || x.severity === 'info' || r.decision === 'APPROVE') continue;
    const k = m.get(x.code) || { ...x, count: 0 };
    k.count++;
    if (x.severity === 'block') k.severity = 'block';
    m.set(x.code, k);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || (a.severity === 'block' ? -1 : 1));
}

const pageHead = () => html`<header class="page-head">
      <div><h1 class="page-title">Batch control</h1><p class="page-sub">Every invoice through the desk: what was decided, where it went and why.</p></div>
      ${demo ? html`<p class="demo-progress" role="status">${demo.error ? html`<span class="error-text">${demo.error}</span>` : html`<span class="caret" aria-hidden="true"></span>Running the sample batch · <span class="typed">${demo.i} of ${demo.n}</span>`}</p>` : ''}
    </header>`;
const replacedLabel = (n) => (showReplaced ? 'Hide replaced slips' : `Show ${n} replaced ${n === 1 ? 'slip' : 'slips'}`);

function render() {
  const { runs, stats } = last;
  const focusKey = document.activeElement?.dataset?.fk;
  root.innerHTML = html`<div class="page runs-page">
    ${pageHead()}
    ${runs.length ? [overview(stats, live(runs)), table(runs)] : empty()}
  </div>`;
  renderRows();
  const el = focusKey && root.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
  el?.focus();
  if (el?.id === 'reg-find') el.setSelectionRange(el.value.length, el.value.length);
}

/** The poll's update: swap the head and tally only when they changed, patch the counts, redraw the rows. */
function refresh() {
  const { runs, stats } = last;
  const fk = document.activeElement?.dataset?.fk;
  const swap = (el, next) => { if (el && el.outerHTML !== String(next)) el.outerHTML = next; };
  swap(root.querySelector('.page-head'), pageHead());
  swap(root.querySelector('.batch'), overview(stats, live(runs)));
  if (fk && !document.activeElement?.isConnected) root.querySelector(`.batch [data-fk="${CSS.escape(fk)}"]`)?.focus();
  for (const [k, , fn] of FILTERS) { const n = root.querySelector(`[data-filter="${k}"] .ftab-n`); if (n) n.textContent = live(runs).filter(fn).length; }
  const b = root.querySelector('[data-replaced]'), n = runs.length - live(runs).length;
  if (b) { b.hidden = !n; b.textContent = replacedLabel(n); }
  const u = root.querySelector('#reg-updated');
  if (u) u.textContent = `Updated ${hm(last.at)}`;
  renderRows();
}

/** { USD: 1, INR: 2 } → [first amount, '+ the rest' or null] */
function moneyBy(sums, fallbackCur = 'USD') {
  const [first, ...rest] = Object.entries(sums || {}).filter(([, v]) => v);
  return [first ? money(first[1], first[0]) : money(0, fallbackCur), rest.length ? `+ ${rest.map(([c, v]) => money(v, c)).join(' · ')}` : null];
}

function overview(s, runs) {
  const by = s.byDecision || {};
  const decided = (by.APPROVE || 0) + (by.REVIEW || 0) + (by.REJECT || 0);
  const running = runs.filter((r) => r.status === 'running').length;
  const waiting = runs.filter(awaitingFn);
  const oldest = waiting.length ? Math.min(...waiting.map((r) => new Date(r.created_at).getTime()).filter((t) => !isNaN(t))) : null;
  const held = {};
  for (const r of waiting) if (r.total != null) held[r.currency || 'USD'] = (held[r.currency || 'USD'] || 0) + r.total;
  const [heldVal, heldRest] = moneyBy(held);
  const [apprVal, apprRest] = moneyBy(s.valueApproved);
  const rejected = s.final?.rejected ?? by.REJECT ?? 0;
  const cell = (k, label, value, sub, mark) => html`<button type="button" class="tcell" data-tally="${k}" data-fk="t-${label}">
    <span class="fl">${mark ? html`<span class="tone-text t-${mark[1]}">${pen(mark[0], 14)}</span>` : ''}${label}</span>
    <span class="tval">${value}</span><span class="tsub">${sub}</span></button>`;

  const outcomes = ['APPROVE', 'REVIEW', 'REJECT'].map((d) => [d, runs.filter((r) => outcomeNow(r)?.decision === d).length]).filter(([, n]) => n);
  const routes = {};
  for (const r of runs) if (outcomeNow(r)?.decision === 'REVIEW') { const k = routeOf(r) || 'Unrouted'; routes[k] = (routes[k] || 0) + 1; }
  const heldAt = Object.entries(routes).sort((a, b) => b[1] - a[1]);
  const kinds = kindsOf(runs);
  return html`<section class="sheet batch" aria-labelledby="batch-title">
    <div class="sheet-head"><h2 class="sheet-title" id="batch-title">Batch control sheet</h2>${s.medianReadMs != null ? html`<span class="sheet-note">AI read median ${dur(s.medianReadMs)} · rules under 50 ms</span>` : ''}</div>
    <div class="tally" role="group" aria-label="Batch tally; each cell filters the register">
      ${cell('all', 'Invoices received', s.total ?? runs.length, running ? `${running} processing now` : `${decided} decided by the rules`)}
      ${cell('APPROVE', 'Straight through', by.APPROVE ?? 0, decided ? `${pct(s.autoApprovalRate)} no human touch` : 'Nothing decided yet', ['pass', 'approve'])}
      ${cell('awaiting', 'Awaiting a person', waiting.length, oldest != null && isFinite(oldest) ? `oldest ${age(Date.now() - oldest)}` : 'Nobody waiting', ['warn', 'review'])}
      ${cell('REVIEW', 'Money on hold', heldVal, heldRest || (waiting.length ? 'Not paid until signed off' : 'Nothing held'))}
      ${cell('APPROVE', 'Value approved', apprVal, apprRest || 'Scheduled for payment')}
      ${cell('REJECT', 'Returned or rejected', rejected, decided ? `${pct(((by.REVIEW || 0) + (by.REJECT || 0)) / decided)} exception rate` : 'Nothing rejected', ['fail', 'reject'])}
    </div>
    ${outcomes.length ? html`<div class="ostrip" role="group" aria-label="Live runs by outcome; each part filters the register">${outcomes.map(([d, n]) => html`<button type="button" class="oseg t-${DECISION[d].tone}" style="flex-grow:${n}" data-seg="${d}" data-fk="seg-${d}" aria-pressed="${seg === d ? 'true' : 'false'}"><span class="oseg-n">${n}</span> ${DECISION[d].word}</button>`)}</div>` : ''}
    ${heldAt.length ? html`<p class="held-at"><span class="held-k">Held at:</span> ${heldAt.map(([k, n], i) => html`${i ? ' · ' : ''}<span class="nowrap">${k} <b>${n}</b></span>`)}</p>` : ''}
    ${kinds.length ? html`<div class="kinds" role="group" aria-label="Exception kinds; each filters the register"><span class="kinds-k">Exception kinds</span>${kinds.map((x) => { const sv = SEVERITY[x.severity] || SEVERITY.hold; return html`<button type="button" class="kind" data-reason="${x.code}" data-fk="k-${x.code}" aria-pressed="${reason === x.code ? 'true' : 'false'}" title="${sv.label}">
      <span class="tone-text t-${sv.tone}">${pen(sv.mark, 15, sv.label)}</span>${reasonLabel(x)} <span class="kind-n">×${x.count}</span></button>`; })}</div>` : ''}
  </section>`;
}

function table(runs) {
  const shown = live(runs), replaced = runs.length - shown.length;
  return html`<section class="register" aria-labelledby="reg-title">
    <div class="reg-head"><h2 class="sheet-title" id="reg-title">Register</h2><span class="sheet-note">Newest first. Open a row to see its slip. <span id="reg-updated">Updated ${hm(last.at)}</span></span></div>
    <div class="reg-tools">
      <div class="reg-tabrow">
        <div class="ftabs" role="group" aria-label="Filter the register">${FILTERS.map(([k, label, fn]) => html`<button type="button" class="ftab-btn" data-filter="${k}" data-fk="f-${k}" aria-pressed="${k === filter ? 'true' : 'false'}">${label} <span class="ftab-n">${shown.filter(fn).length}</span></button>`)}</div>
        <button type="button" class="link small reg-clear" data-clear data-fk="clear" ${seg || reason ? '' : raw('hidden')}>${clearLabel()}</button>
        <button type="button" class="link small reg-replaced" data-replaced data-fk="replaced" ${replaced ? '' : raw('hidden')}>${replacedLabel(replaced)}</button>
      </div>
      <label class="fbox input-box reg-find"><span class="fl">Find in register</span><input type="search" id="reg-find" data-fk="find" value="${query}" placeholder="Vendor, invoice, PO or file" autocomplete="off"></label>
    </div>
    <div class="sheet reg-sheet"><div class="tbl-wrap"><table class="tbl reg-tbl">
      <thead><tr><th class="c-sw"><span class="sr-only">Copy</span></th><th class="c-recv">Received</th><th>Vendor</th><th class="c-inv">Invoice no.</th><th class="r c-amt">Amount</th><th class="c-out">Outcome</th><th class="c-reason">Reason</th></tr></thead>
      <tbody id="reg-rows"></tbody>
    </table></div></div>
  </section>`;
}

function row(r) {
  const why = r.decision === 'APPROVE' ? null : reasonOf(r);
  const sv = why ? SEVERITY[why.severity] || SEVERITY.hold : null;
  const o = outcomeNow(r);
  const human = o?.human;
  const route = r.decision === 'APPROVE' ? null : routeOf(r);
  const inv = r.invoice_number || '—';
  return html`<tr class="run-row${r.superseded_by ? ' replaced' : ''}">
    <td class="cell-sw">${o ? copySwatch(o.copy) : ''}</td>
    <td class="cell-recv nowrap" title="${stamp(r.created_at)}">${ago(r.created_at)}<span class="cell-sub">${r.created_at ? hm(r.created_at) : ''}</span></td>
    <td class="cell-vendor"><a class="row-link" href="#/run/${encodeURIComponent(r.id)}" data-fk="row-${r.id}">${vendorOf(r)}</a><span class="cell-file typed" title="${r.filename}">${r.filename || ''}</span></td>
    <td class="cell-inv"><span class="typed${r.invoice_number ? '' : ' muted'}">${inv}</span><span class="cell-sub cell-po"><span class="typed">${r.po_number || 'No PO'}</span>${r.po_inferred ? html`<span class="inferred" title="PO inferred from lines and amount">inferred</span>` : ''}</span></td>
    <td class="num cell-amt typed">${r.total != null ? money(r.total, r.currency) : html`<span class="muted">—</span>`}</td>
    <td class="cell-outcome">${miniStamp(r)}${human ? html`<span class="reviewed-line">Held, then ${human.decision === 'APPROVE' ? 'approved' : 'rejected'} by ${human.reviewer || 'a reviewer'}</span>` : ''}${r.superseded_by ? html`<span class="reviewed-line">Replaced by a later run</span>` : ''}</td>
    <td class="cell-reason">${why ? (why.code
      ? html`<span class="reason-cell" title="${why.code}${why.message ? ` · ${why.message}` : ''}"><span class="tone-text t-${sv.tone}">${pen(sv.mark, 16, sv.label)}</span>${why.label || humanize(why.code)}</span>`
      : html`<span class="reason-text" title="${why.message}">${why.message}</span>`) : ''}${route ? html`<span class="reason-route">to ${route}</span>` : ''}</td>
    <td class="cell-meta" aria-hidden="true">${ago(r.created_at)} · <span class="typed">${inv}</span>${r.po_number ? html` · <span class="typed">${r.po_number}</span>` : ''}</td>
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
  const f = e.target.closest('[data-filter], [data-tally]');
  if (f) { filter = f.dataset.filter || f.dataset.tally; if (f.dataset.tally) seg = reason = null; applyFilters(); return; }
  const g = e.target.closest('[data-seg]');
  if (g) { seg = seg === g.dataset.seg ? null : g.dataset.seg; reason = null; filter = 'all'; applyFilters(); return; }
  const k = e.target.closest('[data-reason]');
  if (k) { reason = reason === k.dataset.reason ? null : k.dataset.reason; seg = null; filter = 'all'; applyFilters(); return; }
  if (e.target.closest('[data-clear]')) { seg = reason = null; applyFilters(); root.querySelector('[data-fk="f-all"]')?.focus(); return; }
  const t = e.target.closest('[data-replaced]');
  if (t) { showReplaced = !showReplaced; t.textContent = replacedLabel(last.runs.length - live(last.runs).length); renderRows(); return; }
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
