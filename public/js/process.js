// Process screen: in-tray rail, the live processing slip (SSE), the clipped original document.
import {
  api, html, raw, esc, money, num, qty, dur, clock, day, when, ago, prose, signedPct, icon, pen, runsChanged, copyButton,
  reasonLabel, isCode, outcomeOf, finalOf, miniStamp, reducedMotion,
  DECISION, COPIES, CHECK_TONE, SEVERITY,
} from './util.js';
import { policyCard } from './data.js';

const STAGES = [
  ['intake', 'Intake', 'Checks the file type, size and fingerprint, and whether this exact file came in before.', 'tray'],
  ['extract', 'Read the invoice', 'Gemini reads the document into fields, each with a confidence score.', 'read'],
  ['validate', 'Validate', 'Required fields, arithmetic, dates and tax IDs, checked by plain rules.', 'sum'],
  ['vendor', 'Vendor check', 'Finds the vendor in the master file and compares the bank details on file.', 'building'],
  ['duplicate', 'Duplicate check', 'Looks in the ledger for the same invoice billed twice.', 'dupe'],
  ['po_match', 'PO match', 'Finds the purchase order, or infers it, then matches lines, prices and goods received.', 'link'],
  ['decision', 'Decision', 'Approve, hold for a named desk, or reject, with the reasons and next steps.', 'stamp'],
];
const DESC = Object.fromEntries(STAGES.map(([k, , d]) => [k, d]));
const STAGE_ICON = Object.fromEntries(STAGES.map(([k, , , i]) => [k, i]));
const STATUS_WORD = { pending: 'Waiting', running: 'In progress', passed: 'Passed', warning: 'Warning', failed: 'Failed', skipped: 'Skipped', blocked: 'Blocks payment', voided: 'Voided' };
const MARK = { passed: 'pass', warning: 'warn', failed: 'fail', skipped: 'skip', blocked: 'fail', voided: 'fail' };
// The stage that raises each block-severity reason (src/rules.js), so a rejected slip marks its cause in vermilion.
const BLOCK_STAGE = { NOT_AN_INVOICE: 'validate', VENDOR_BLOCKED: 'vendor', DUPLICATE_INVOICE: 'duplicate' };
const CHECK_PEN = { pass: ['pass', 'Passed'], warn: ['warn', 'Warning'], fail: ['fail', 'Failed'], info: ['info', 'Note'] };
const DESKS = ['AP file', 'Treasury & Security', 'Procurement', 'Receiving', 'AP clerk', 'Return to vendor'];
const EXPECT = { APPROVE: 'approval', REVIEW: 'a hold', REJECT: 'rejection' };
const GAP_MS = 280; // minimum time between visible stage transitions
const MAX_BYTES = 8 * 1024 * 1024; // the server limit
const LOW_CONF = 0.7; // display only; the rules use src/config.js

let root = null;      // .process element
let samples = null;   // cached /api/samples
let samplesError = null;
let cur = null;       // the open run: { id, run, es, queue, busy, manual, applied, tick, docTab, decisionSig, fieldsSig, stampKey }
let starting = false; // a sample/upload POST is in flight
let launched = null;  // { id, filename } of the run this page just started, so its blank slip shows the file at once

const $ = (sel) => root?.querySelector(sel);

// "Hide document" lets the slip go wide on desktop; remembered per browser (storage can throw).
const DOC_KEY = 'invoice-desk:doc-hidden';
let docHidden = false;
try { docHidden = localStorage.getItem(DOC_KEY) === '1'; } catch { /* private mode */ }
function setDocHidden(v) {
  docHidden = v;
  try { localStorage.setItem(DOC_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  root?.classList.toggle('doc-hidden', v);
  const b = $('[data-doc-toggle]');
  if (b) b.innerHTML = String(html`${icon('doc', 16)}${v ? 'Show document' : 'Hide document'}`);
}
const isError = (r) => r.status === 'error' || !!r.result?.errorKind || r.result?.error === true;

/** Slip number: a sample's own number ("07_..." is 0007); otherwise the run's place in the register, oldest first. */
async function fillSerial(c) {
  const r = c.run;
  let n = r.source === 'sample' ? sampleNo(r.filename) : '';
  if (!n) {
    const runs = await api('/api/runs').catch(() => null);
    const list = (Array.isArray(runs) ? runs : runs?.runs || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const i = list.findIndex((x) => x.id === r.id);
    n = i >= 0 ? String(i + 1) : '';
  }
  const el = c === cur && $('#serial-n');
  if (el && n) { el.textContent = n.padStart(4, '0'); el.classList.remove('blank-n'); el.removeAttribute('aria-label'); }
}
const localDay = (iso) => (iso && !isNaN(new Date(iso)) ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

export function mountProcess(main, id) {
  if (!root || !main.contains(root)) build(main);
  if (!id) {
    closeRun();
    root.classList.remove('has-run', 'show-doc');
    renderEmpty();
  } else if (cur?.id !== id) openRun(id);
  renderSamples();
}

export function unmountProcess() { closeRun(); root = null; document.title = 'Invoice Desk'; }

// ---------------------------------------------------------------- layout
function build(main) {
  main.innerHTML = html`<div class="process">
    <h1 class="sr-only">Invoice Desk: process an invoice</h1>
    <aside class="tray" aria-labelledby="tray-title">
      <h2 class="rail-title" id="tray-title">In tray</h2>
      <div class="drop" id="drop">
        <input type="file" id="file-input" class="sr-only" tabindex="-1" aria-label="Upload an invoice file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">
        <span class="drop-icon">${icon('upload', 22)}</span>
        <span class="drop-title" id="drop-title">Drop an invoice here</span>
        <span class="drop-sub">or <button type="button" class="link" id="browse">browse your files</button></span>
        <span class="drop-note">PDF, PNG or JPG, up to 8 MB</span>
      </div>
      <p class="drop-msg" id="drop-msg" role="alert"></p>
      <label class="opt"><input type="checkbox" id="fresh" class="box"><span>Read the file fresh (skip the cache)</span></label>
      <h2 class="rail-title samples-title">Sample invoices <span class="count" id="sample-count"></span></h2>
      <ul class="samples" id="samples"><li class="muted pad">Loading the samples…</li></ul>
    </aside>
    <section class="run-col" id="run-col" aria-label="Processing slip"></section>
    <section class="doc-col" id="doc-col" aria-label="Original document"></section>
  </div>`;
  root = main.querySelector('.process');
  root.classList.toggle('doc-hidden', docHidden);
  root.addEventListener('input', onReviewInput);
  root.addEventListener('change', onReviewInput);

  const drop = $('#drop'), input = $('#file-input');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) upload(f); });
  drop.addEventListener('click', (e) => { if (e.target === drop || !e.target.closest('button,input')) input.click(); });
  $('#browse').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) upload(f); });

  $('#samples').addEventListener('click', (e) => { const b = e.target.closest('[data-file]'); if (b) startSample(b.dataset.file); });
  root.addEventListener('click', onRunClick);
  root.addEventListener('keydown', onTabKeys);
  loadSamples();
}

// ---------------------------------------------------------------- in tray
async function loadSamples() {
  try { samples = await api('/api/samples'); samplesError = null; } catch (e) { samplesError = e.message; samples = []; }
  if (!Array.isArray(samples)) samples = samples?.samples || [];
  renderSamples();
}

const sampleNo = (file) => (/^(\d+)/.exec(file || '') || [])[1] || '';
const tabTone = (t) => (/happy/i.test(t) ? 'tab-mint' : /edge/i.test(t) ? 'tab-amber' : /fraud|injection/i.test(t) ? 'tab-rose' : '');

function renderSamples() {
  const list = $('#samples');
  if (!list || !samples) return;
  $('#sample-count').textContent = samples.length || '';
  if (samplesError) { list.innerHTML = html`<li class="pad error-text">Couldn't load the sample invoices: ${samplesError}</li>`; return; }
  if (!samples.length) { list.innerHTML = html`<li class="pad muted">No sample invoices are available.</li>`; return; }
  const curFile = cur?.run?.source === 'sample' ? cur.run.filename : null;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.file : null;
  list.innerHTML = html`${samples.map((s) => {
    const d = DECISION[s.expected];
    const tags = Array.isArray(s.tags) ? s.tags : [];
    const p = s.processed && typeof s.processed === 'object' ? s.processed : null;
    const shown = p ? p.final_decision || p.decision : null;
    // Clicking a processed sample replays it: the server sets the earlier slip aside, so it decides afresh.
    const dupHint = p ? 'Run it again to replay it; the earlier slip is set aside' : '';
    const isCur = s.file === curFile;
    return html`<li><button type="button" class="paper" data-file="${s.file}" ${isCur ? raw('aria-current="true"') : ''} ${starting ? raw('aria-disabled="true"') : ''} title="${[s.title || s.file, dupHint].filter(Boolean).join(' · ')}">
      <span class="paper-no">${sampleNo(s.file)}</span>
      <span class="paper-body">
        <span class="paper-vendor">${s.vendor || s.title || s.file}</span>
        <span class="paper-scn" title="${s.scenario || s.title || ''}">${s.scenario || s.title || ''}</span>
        <span class="paper-foot">
          ${tags.length ? html`<span class="paper-tabs">${tags.map((t) => html`<span class="ftab ${tabTone(t)}">${t}</span>`)}</span>` : ''}
          ${p && !shown ? html`<span class="mark-running"><span class="caret" aria-hidden="true"></span>Processing</span>`
            : p ? miniStamp({ status: 'done', decision: p.decision, final_decision: p.final_decision })
            : d ? html`<span class="expects">Expects <strong class="tone-text t-${d.tone}">${EXPECT[s.expected]}</strong></span>` : ''}
        </span>
        ${s.runAfter ? html`<span class="paper-hint">Run after ${sampleNo(s.runAfter) || s.runAfter}</span>` : ''}
        ${dupHint && isCur ? html`<span class="paper-hint">${dupHint}</span>` : ''}
      </span>
    </button></li>`;
  })}`;
  if (focused) list.querySelector(`[data-file="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
}

const freshQ = () => ($('#fresh')?.checked ? 'fresh=1' : '');

function dropMsg(text) { const el = $('#drop-msg'); if (el) el.textContent = text || ''; }

async function startSample(file) {
  if (starting) return;
  starting = true; dropMsg(''); renderSamples();
  try {
    const q = [`sample=${encodeURIComponent(file)}`, freshQ()].filter(Boolean).join('&');
    const { id } = await api(`/api/runs?${q}`, { method: 'POST' });
    launched = { id, filename: file };
    location.hash = `#/run/${encodeURIComponent(id)}`;
  } catch (e) { dropMsg(e.status === 429 ? e.message : `Couldn't start this sample: ${e.message}`); } finally { starting = false; renderSamples(); }
}

async function upload(f) {
  dropMsg('');
  const okType = /^(application\/pdf|image\/png|image\/jpeg)$/.test(f.type) || /\.(pdf|png|jpe?g)$/i.test(f.name);
  if (!okType) return dropMsg("This file isn't a PDF or image. Drop a PDF, PNG or JPG.");
  if (!f.size) return dropMsg('This file is empty.');
  if (f.size > MAX_BYTES) return dropMsg(`This file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 8 MB.`);
  if (starting) return;
  starting = true;
  const drop = $('#drop'), title = $('#drop-title');
  drop.classList.add('busy');
  drop.setAttribute('aria-busy', 'true');
  if (title) title.textContent = 'Filing it…';
  try {
    const q = freshQ();
    const { id } = await api(`/api/runs${q ? '?' + q : ''}`, {
      method: 'POST', body: f,
      // Header values must be Latin-1, so the name is URI-encoded; the server decodes it.
      headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
    });
    launched = { id, filename: f.name };
    location.hash = `#/run/${encodeURIComponent(id)}`;
  } catch (e) { dropMsg(e.status === 429 ? e.message : `Upload failed: ${e.message}`); } finally {
    starting = false;
    $('#drop')?.classList.remove('busy');
    $('#drop')?.removeAttribute('aria-busy');
    const t = $('#drop-title'); if (t) t.textContent = 'Drop an invoice here';
  }
}

// ---------------------------------------------------------------- empty state: a blank slip
function renderEmpty() {
  document.title = 'Invoice Desk';
  $('#doc-col').innerHTML = '';
  $('#run-col').innerHTML = html`<div class="landing">
    <div class="landing-main">
      <h1 class="page-title">How a run works</h1>
      <p class="lede">Every invoice gets a processing slip. Seven checks fill in its rows, then the decision is stamped on it. The model only reads the document; plain rules you can audit make every decision.</p>
      <div class="landing-cta">
        <p class="prompt">${icon('arrowLeft', 18)} Pick a sample from the in tray, or drop a file, to start.</p>
        <button type="button" class="btn primary" data-start-no="01">Run the clean invoice (01)</button>
      </div>
      ${specimen()}
    </div>
    <aside class="landing-side" aria-label="Recent runs and matching policy">
      <section class="sheet recent" aria-labelledby="recent-title">
        <div class="sheet-head"><h2 class="sheet-title" id="recent-title">Recent runs</h2><a class="link small" href="#/runs">Open the register ${icon('arrowRight', 16)}</a></div>
        <ul class="recent-list" id="recent"><li class="recent-empty muted">Loading…</li></ul>
      </section>
      <div id="landing-policy"></div>
    </aside>
  </div>`;
  loadLanding();
}

function specimen() {
  const outcomes = [
    ['APPROVE', 'Scheduled for payment on the due date. The white copy goes to the AP file.'],
    ['REVIEW', 'Held and routed to a named desk, with next steps. The canary copy goes to the reviewer.'],
    ['REJECT', 'Never paid, with the reason on record. The pink copy goes back to the vendor.'],
  ];
  return html`<div class="slip specimen copy-white">
    <header class="slip-head">
      <div class="sh-title"><p class="sh-name">Invoice processing slip</p><p class="sh-org">Halden Robotics · Accounts Payable</p></div>
      <div class="sh-right"><p class="serial">No. <span class="serial-n blank-n" aria-label="not yet numbered">0000</span></p>
        <div class="stamp-box"><span class="fl">Decision</span><span class="sb-empty">Stamped here once every check has run</span></div></div>
    </header>
    ${fieldsRow({ read: false })}
    <div class="stages">
      <div class="st-cols" aria-hidden="true"><span>No.</span><span></span><span>Check</span><span>Time</span><span></span></div>
      <ol class="timeline">${STAGES.map(([key, label, desc], i) => html`<li class="stage s-pending"><div class="stage-head">
        ${stageRow({ key, label, status: 'pending' }, i + 1, desc, false)}<span class="chev"></span></div></li>`)}</ol>
    </div>
    <div class="tear" aria-hidden="true"></div>
    <section class="outcome" aria-labelledby="oc-title">
      <h2 class="form-h" id="oc-title">The three outcomes</h2>
      <ul class="outcome-list">${outcomes.map(([k, text]) => html`<li>${inkStamp(outcomeOf({}, k), '', 'sm')}<span>${text}</span></li>`)}</ul>
    </section>
    <footer class="copies">${copiesFooter(null)}</footer>
  </div>`;
}

let policy = null; // matching policy from /api/data, for the landing form and display tolerances

async function loadPolicy() {
  if (!policy) { try { policy = (await api('/api/data'))?.policy || null; } catch { policy = null; } }
  return policy;
}

async function loadLanding() {
  const [runs, p] = await Promise.all([api('/api/runs').catch(() => null), loadPolicy()]);
  const list = $('#recent');
  if (!list || cur) return; // a run opened meanwhile
  const rows = (Array.isArray(runs) ? runs : runs?.runs || []).slice(0, 5);
  list.innerHTML = runs == null ? html`<li class="recent-empty muted">Couldn't load recent runs.</li>`
    : !rows.length ? html`<li class="recent-empty muted">No runs yet. Pick a sample and the first one lands here.</li>`
    : html`${rows.map((r) => {
      const human = outcomeOf(r)?.human;
      return html`<li><a class="recent-row" href="#/run/${encodeURIComponent(r.id)}">
        <span class="recent-main"><span class="recent-vendor">${r.vendor_name || r.filename || 'Unknown vendor'}</span>
          <span class="recent-sub">${[r.invoice_number, r.total != null ? money(r.total, r.currency) : null].filter(Boolean).join(' · ') || r.filename}</span></span>
        <span class="recent-side">${miniStamp(r)}<span class="recent-ago">${human ? 'reviewed · ' : ''}${ago(r.created_at)}</span></span>
      </a></li>`;
    })}`;
  const slot = $('#landing-policy');
  if (slot) slot.innerHTML = policyCard(p);
}

// ---------------------------------------------------------------- run lifecycle
function closeRun() {
  if (!cur) return;
  cur.es?.close();
  clearInterval(cur.tick);
  clearInterval(cur.stTick);
  clearTimeout(cur.pollT);
  cur = null;
}

function openRun(id) {
  closeRun();
  loadPolicy();
  const c = cur = { id, run: null, es: null, queue: [], busy: false, manual: new Map(), applied: new Map(), tick: null, docTab: 'doc', decisionSig: null, fieldsSig: null, stampKey: null, done: false };
  root.classList.add('has-run');
  root.classList.remove('show-doc');
  $('#run-col').scrollTop = 0;
  if (!matchMedia('(min-width: 800px)').matches) window.scrollTo(0, 0); // phones: the run sits above the tray
  // The blank slip goes down at once (seven waiting rows); the snapshot fills it a moment later.
  const mine = launched?.id === id ? launched : null;
  $('#doc-col').dataset.doc = '';
  c.run = normalize({ id, placeholder: true, status: mine ? 'running' : 'opening', created_at: new Date().toISOString(), filename: mine?.filename || '', stages: [] });
  renderRun();

  const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  const es = c.es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  // Wall time this page watched, first event to done; the server's own `ms` is shown for runs opened afterwards.
  es.addEventListener('snapshot', (e) => { const run = parse(e); if (c === cur && run) { if (run.status === 'running') c.t0 ??= Date.now(); c.queue.length = 0; applySnapshot(run); } });
  es.addEventListener('stage', (e) => { const d = parse(e); const s = d?.stage || d; if (c === cur && s?.key) enqueue(() => applyStage(s)); });
  es.addEventListener('done', (e) => { const run = parse(e); c.done = true; if (c.t0 != null) c.liveMs = Date.now() - c.t0; es.close(); if (c === cur) enqueue(() => applyDone(run?.run || run)); });
  // Reset demo clears every run: the server says so, then closes the stream.
  es.addEventListener('reset', () => { c.done = true; es.close(); if (c === cur) { renderMissing({ status: 404 }); loadSamples(); runsChanged(); } });
  es.onerror = () => { if (c !== cur || c.done) return; es.close(); poll(c); };
}

/** Fallback when SSE is unavailable: poll the run until it finishes. */
async function poll(c) {
  let run;
  try { run = await api(`/api/runs/${encodeURIComponent(c.id)}`); } catch (e) { if (c === cur) renderMissing(e); return; }
  if (c !== cur) return;
  if (!c.run || c.run.placeholder) applySnapshot(run);
  else for (const s of run.stages || []) {
    const old = c.run.stages.find((x) => x.key === s.key);
    if (!old || old.status !== s.status || old.summary !== s.summary) enqueue(() => applyStage(s));
  }
  if (run.status === 'running') c.pollT = setTimeout(() => poll(c), 1000);
  else { c.done = true; enqueue(() => applyDone(run)); }
}

function enqueue(fn) { cur.queue.push(fn); pump(cur); }
function pump(c) {
  if (c !== cur || c.busy || !c.queue.length) return;
  c.busy = true;
  c.queue.shift()();
  // Once the run is done, the rows still queued catch up quickly so the slip never outlasts the real run.
  setTimeout(() => { c.busy = false; pump(c); }, c.done ? 60 : GAP_MS);
}

/** Stages render in the order the run gives them; the default list only fills a run that has none yet. */
function normalize(run) {
  const got = Array.isArray(run.stages) && run.stages.length ? run.stages : STAGES.map(([key, label]) => ({ key, label }));
  const stages = got.map((s) => ({ status: 'pending', summary: '', checks: [], data: null, label: STAGES.find(([k]) => k === s.key)?.[1], ...s }));
  return { ...run, stages };
}

function applySnapshot(run) {
  cur.run = normalize(run);
  if (cur.run.status !== 'running') cur.done = true;
  renderRun();
  renderSamples();
  // Only the desktop rail scrolls on its own; on phones this would scroll the page away from the run.
  if (matchMedia('(min-width: 800px)').matches) $('.paper[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

function applyStage(s) {
  const c = cur, stages = c.run.stages;
  const i = stages.findIndex((x) => x.key === s.key);
  if (i >= 0) stages[i] = { ...stages[i], ...s };
  else { stages.push({ status: 'pending', checks: [], ...s }); $('#timeline')?.insertAdjacentHTML('beforeend', String(html`<li class="stage" data-key="${s.key}"></li>`)); }
  renderStage(s.key, true);
  renderFields();
  renderProgress();
  renderDecisionSlot();
  // The extraction JSON is not on stage events; fetch it once the read stage finishes.
  if (s.key === 'extract' && !['pending', 'running'].includes(s.status) && !c.run.extraction) {
    api(`/api/runs/${encodeURIComponent(c.id)}`).then((r) => { if (c === cur && r?.extraction) { c.run.extraction = r.extraction; renderJson(); renderFields(); } }).catch(() => {});
  }
}

function applyDone(run) {
  const c = cur;
  if (run && typeof run === 'object' && run.id) c.run = normalize({ ...c.run, ...run });
  else c.run.status = c.run.status === 'running' ? 'done' : c.run.status;
  c.done = true;
  c.run.stages.forEach((s) => renderStage(s.key, true));
  renderHead();
  renderFields();
  renderProgress();
  renderDecisionSlot();
  renderJson();
  loadSamples(); // refreshes the "processed" state in the tray
  runsChanged();
}

// ---------------------------------------------------------------- the slip
/** A tab with aria-controls and a roving tabindex; onTabKeys moves between tabs with the arrow keys. */
const tab = (kind, k, label, on, controls, id = '') => html`<button type="button" role="tab" ${id ? html`id="${id}"` : ''} data-${kind}="${k}" aria-controls="${controls}" aria-selected="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">${label}</button>`;

const switcher = (which) => html`<div class="switch" role="tablist" aria-label="Run view">
  ${tab('switch', 'run', 'Slip', which === 'run', 'run-col')}${tab('switch', 'doc', 'Document', which === 'doc', 'doc-col')}
</div>`;

function renderRun() {
  const r = cur.run;
  $('#run-col').innerHTML = html`${switcher('run')}
    <article class="slip copy-white" id="slip" aria-labelledby="slip-title">
      <header class="slip-head">
        <div class="sh-title">
          <h1 class="sh-name" id="slip-title">Invoice processing slip</h1>
          <p class="sh-org">Halden Robotics · Accounts Payable</p>
          <div class="sh-meta" id="run-head"></div>
        </div>
        <div class="sh-right">
          <p class="serial">No. <span class="serial-n blank-n" id="serial-n" aria-label="not yet numbered">0000</span></p>
          <div class="stamp-box" id="stamp-box"></div>
        </div>
      </header>
      <div id="slip-fields"></div>
      <div class="decision-line" id="decision-line"></div>
      <section class="stages" aria-labelledby="tl-title">
        <div class="stages-head"><h2 class="form-h" id="tl-title">Checks</h2><span class="tl-progress" id="tl-progress" role="status"></span></div>
        <div class="st-cols" aria-hidden="true"><span>No.</span><span></span><span>Check</span><span>Time</span><span></span></div>
        <ol class="timeline" id="timeline">${r.stages.map((s) => html`<li class="stage" data-key="${s.key}"></li>`)}</ol>
      </section>
      <div class="tear" aria-hidden="true"></div>
      <div id="decision-slot" class="outcome"></div>
      <p class="sr-only" id="decision-said" role="status"></p>
      <footer class="copies" id="copies"></footer>
    </article>`;
  cur.applied.clear();
  cur.decisionSig = null;
  cur.fieldsSig = null;
  r.stages.forEach((s) => renderStage(s.key, false));
  renderHead();
  renderFields();
  renderProgress();
  renderDecisionSlot(false);
  renderDoc();
  if (!r.placeholder) fillSerial(cur);
}

function renderHead() {
  const c = cur, r = c.run, el = $('#run-head');
  if (!el) return;
  clearInterval(c.tick);
  const running = r.status === 'running';
  const source = { sample: 'Sample', upload: 'Upload' }[r.source] || r.source;
  // A held run nobody has signed off can be read again (the server refuses with 409 otherwise).
  const canRetry = !running && !isError(r) && r.decision === 'REVIEW' && !r.superseded_by && finalOf(r)?.by !== 'reviewer';
  el.innerHTML = html`<p class="meta-file" title="${r.filename}">${r.filename || (r.placeholder ? ' ' : 'Untitled document')}</p>
    <p class="meta-bits"><span>Run <span class="typed">${r.id}</span></span><span>Started <span class="typed">${clock(r.created_at)}</span></span>${source ? html`<span>${source}</span>` : ''}</p>
    <p class="meta-bits">
      <span class="run-clock ${running ? 'live' : ''}">${running
        ? html`<span class="caret" aria-hidden="true"></span>Running <span class="typed" id="elapsed"></span>`
        : r.placeholder ? 'Opening the slip' : isError(r) ? 'Stopped' : html`Finished in <span class="typed">${dur(c.liveMs ?? r.ms)}</span>`}</span>
      <button type="button" class="link small doc-toggle" data-doc-toggle>${icon('doc', 16)}${docHidden ? 'Show document' : 'Hide document'}</button>
      ${canRetry ? html`<button type="button" class="link small" data-retry title="Starts a new run on the same file and reads it fresh">${icon('retry', 16)}Retry</button>` : ''}
    </p>
    ${running ? '' : timing(r)}
    ${canRetry ? html`<p class="form-error" id="retry-error" role="alert"></p>` : ''}
    ${r.superseded_by ? html`<p class="superseded">Replaced by a later run. <a class="link" href="#/run/${encodeURIComponent(r.superseded_by)}">Open the newer slip ${icon('arrowRight', 16)}</a></p>` : ''}`;
  if (running) {
    const t0 = c.t0 ?? (Date.parse(r.created_at) || Date.now());
    const tick = () => { const e = document.getElementById('elapsed'); if (e) e.textContent = `${(Math.max(0, c.liveMs ?? Date.now() - t0) / 1000).toFixed(1)} s`; };
    tick();
    c.tick = setInterval(tick, 100);
  }
}

/** 'Read 4.1 s · checks 14 ms': the AI read and the plain rules, timed apart. */
function timing(r) {
  const ex = r.stages.find((s) => s.key === 'extract');
  if (!ex || !['passed', 'warning'].includes(ex.status)) return '';
  const d = ex.data || {};
  const checks = r.stages.reduce((a, s) => a + (s.key !== 'extract' && s.ms != null ? s.ms : 0), 0);
  const read = d.cached
    ? html`Cached read${d.originalLatencyMs != null ? ` (first read ${dur(d.originalLatencyMs)})` : ''}`
    : html`Read <span class="typed">${dur(d.latencyMs ?? ex.ms)}</span>`;
  return html`<p class="run-split">${read} · checks <span class="typed">${dur(checks)}</span></p>`;
}

// ---- the boxed field row: what the clerk types in from the invoice
const FIELD_BOXES = [['vendor', 'Vendor'], ['invoice', 'Invoice no.'], ['date', 'Invoice date'], ['po', 'PO'], ['due', 'Due date'], ['total', 'Amount']];

function slipValues(r) {
  const ex = r.stages.find((s) => s.key === 'extract');
  const read = !!r.extraction || (!!ex && ['passed', 'warning'].includes(ex.status));
  if (!read) return { read: false, failed: ex?.status === 'failed' || ex?.status === 'skipped' };
  const f = Object.fromEntries((Array.isArray(ex?.data?.fields) ? ex.data.fields : []).map((x) => [x.key, x.value]));
  const x = r.extraction || {};
  const pick = (...vals) => vals.find((v) => v != null && v !== '') ?? null;
  const po = r.stages.find((s) => s.key === 'po_match')?.data;
  const printedPo = pick(f.po_number, x.po_number);
  const inferredPo = !printedPo && po?.inferred && po?.po_number ? po.po_number : null;
  return {
    read: true,
    vendor: pick(f.vendor_name, x.vendor?.name, r.stages.find((s) => s.key === 'vendor')?.data?.vendor?.name, r.vendor_name),
    invoice: pick(f.invoice_number, x.invoice_number, r.invoice_number),
    date: pick(f.invoice_date, x.invoice_date),
    due: pick(f.due_date, x.due_date),
    terms: pick(f.payment_terms, x.payment_terms),
    po: printedPo ?? inferredPo,
    poInferred: !!inferredPo,
    total: pick(f.total, x.total, r.total),
    currency: pick(f.currency, x.currency, r.currency),
  };
}

function fieldsRow(v) {
  const val = (k) => {
    if (!v.read) return v.failed ? html`<span class="blank-note">Not read</span>` : html`<span class="blank"><span class="sr-only">Not filled in yet</span></span>`;
    const x = v[k];
    const terms = k === 'due' && v.terms ? html`<span class="f-terms">${v.terms}</span>` : '';
    if (x == null || x === '') return html`<span class="missing">Not on invoice</span>${terms}`;
    if (k === 'date') return day(String(x));
    if (k === 'due') return html`${day(String(x))}${terms}`;
    if (k === 'total') return money(x, v.currency);
    if (k === 'po' && v.poInferred) return html`${x}<span class="inferred">inferred</span>`;
    return String(x);
  };
  return html`<dl class="fields">${FIELD_BOXES.map(([k, label]) => html`<div class="fbox f-${k}"><dt class="fl">${label}</dt><dd class="typed">${val(k)}</dd></div>`)}</dl>`;
}

/** "KIS-24-0871 · On hold · Invoice Desk": the invoice number (else the file) and the stamp word. */
function setTitle() {
  const r = cur?.run;
  if (!r) return;
  const res = r.result?.decision ? r.result : r.stages.find((s) => s.key === 'decision')?.data;
  const word = isError(r) && r.status !== 'running' ? 'Stopped' : res?.decision ? outcomeOf(r, res.decision)?.word : '';
  document.title = [slipValues(r).invoice || r.filename, word, 'Invoice Desk'].filter(Boolean).join(' · ');
}

function renderFields() {
  const el = $('#slip-fields');
  if (!el || !cur?.run) return;
  setTitle();
  const v = slipValues(cur.run);
  const sig = JSON.stringify(v);
  if (sig === cur.fieldsSig) return;
  cur.fieldsSig = sig;
  el.innerHTML = fieldsRow(v);
}

function renderProgress() {
  const el = $('#tl-progress');
  if (!el) return;
  const r = cur.run, st = r.stages;
  const done = st.filter((s) => !['pending', 'running'].includes(s.status)).length;
  // While running, name the row being filled in (or the next one, between rows).
  const at = r.status === 'running' ? st.findIndex((s) => s.status === 'running') : -1;
  const next = at >= 0 ? at : r.status === 'running' ? st.findIndex((s) => s.status === 'pending') : -1;
  const total = st.reduce((a, s) => a + (s.ms ?? 0), 0);
  el.textContent = next >= 0 ? `Checking ${next + 1} of ${st.length} · ${st[next].label || st[next].key}`
    : done === st.length && !r.placeholder ? `${done} of ${st.length} done · ${dur(total)}`
    : `${done} of ${st.length} done`;
}

// ---- stage rows
// The decision row stays shut once Remarks says the same thing below.
const isOpen = (s) => (cur.manual.has(s.key) ? cur.manual.get(s.key) : ['running', 'warning', 'failed'].includes(s.status) && !(s.key === 'decision' && s.data?.decision));

/** On a rejected run, the stage that raised a block-severity reason shows as blocking payment. */
function shownStatus(s) {
  const res = cur?.run?.result?.decision ? cur.run.result : cur?.run?.stages.find((x) => x.key === 'decision')?.data;
  if (res?.decision !== 'REJECT' || !['warning', 'failed'].includes(s.status)) return s.status;
  // A deliberate reject is not a failure of the decision stage.
  if (s.key === 'decision') return isError(cur.run) ? s.status : 'voided';
  return (res.reasons || []).some((x) => x.severity === 'block' && BLOCK_STAGE[x.code] === s.key) ? 'blocked' : s.status;
}

function stageRow(s, n, summary, drawn) {
  const mark = MARK[s.status];
  const showMs = s.ms != null && !['pending', 'running', 'skipped'].includes(s.status);
  const typed = s.status !== 'pending';
  return html`<span class="st-no">${n}</span>
    <span class="tick-box${drawn ? ' draw' : ''}">${mark ? pen(mark, 26) : ''}</span>
    <span class="st-main">
      <span class="st-name">${icon(STAGE_ICON[s.key] || 'doc', 18)}<span>${s.label || s.key}</span></span>
      <span class="st-summary${typed ? ' typed' : ''}"><span class="st-text">${summary}</span>${s.status === 'running' ? html`<span class="caret" aria-hidden="true"></span>` : ''}</span>
    </span>
    <span class="st-meta">
      <span class="st-status ${s.status === 'passed' ? 'sr-only' : ''}">${STATUS_WORD[s.status] || s.status}</span>
      ${showMs ? html`<span class="st-ms">${dur(s.ms)}</span>`
        : s.status === 'running' && s.t0 ? html`<span class="st-ms" data-t0="${s.t0}" aria-hidden="true">${liveSecs(s.t0)}</span>` : ''}
    </span>`;
}

/** A running row's time counts up: every 100 ms, or once a second under reduced motion. */
const liveSecs = (t0) => { const s = Math.max(0, Date.now() - t0) / 1000; return `${reducedMotion() ? Math.floor(s) : s.toFixed(1)} s`; };
function stageTick(c) {
  if (c.stTick) return;
  c.stTick = setInterval(() => {
    const els = c === cur ? root?.querySelectorAll('.st-ms[data-t0]') : null;
    if (!els?.length) { clearInterval(c.stTick); c.stTick = null; return; }
    els.forEach((e) => { e.textContent = liveSecs(+e.dataset.t0); });
  }, reducedMotion() ? 1000 : 100);
}

function renderStage(key, animate) {
  const c = cur;
  const li = $(`.stage[data-key="${CSS.escape(key)}"]`);
  const s = c.run.stages.find((x) => x.key === key);
  if (!li || !s) return;
  const open = isOpen(s) && s.status !== 'pending';
  const status = shownStatus(s);
  const sig = JSON.stringify([s, open, status]);
  if (c.applied.get(key) === sig) return;
  const prevStatus = c.applied.get(key + ':status');
  const changed = animate && prevStatus !== undefined && prevStatus !== s.status;
  c.applied.set(key, sig);
  c.applied.set(key + ':status', s.status);
  const hadFocus = li.contains(document.activeElement);
  const expandable = s.status !== 'pending';
  const said = key === 'intake' ? dedupeParts(s.summary) : key === 'decision' && s.data?.decision ? spellMore(s.summary, primaryOf(s.data), s.data.reasons || []) : s.summary;
  const summary = s.summary ? prose(said) : (s.status === 'running' ? (key === 'extract' ? 'Gemini is reading the document' : 'Running the checks') : DESC[key] || '');
  const motion = changed && !reducedMotion();
  // When the row started: the server's clock if it says, never later than now.
  if (s.status === 'running' && c.run.status === 'running') (c.started ??= {})[key] ??= Math.min(Date.now(), Date.parse(s.startedAt) || Date.now());
  li.className = `stage s-${status}${open ? ' open' : ''}`;
  li.innerHTML = html`<button type="button" class="stage-head" ${expandable ? raw(`aria-expanded="${open}"`) : raw('disabled')} ${open ? raw(`aria-controls="sb-${esc(key)}"`) : ''}>
      ${stageRow({ ...s, status, t0: c.started?.[key] }, c.run.stages.indexOf(s) + 1, summary, motion && !!MARK[status])}
      <span class="chev">${expandable ? icon('chev', 16) : ''}</span>
    </button>
    ${open ? html`<div class="stage-body" id="sb-${key}">${stageBody(s)}</div>` : ''}`;
  if (motion && s.summary) typeIn(li.querySelector('.st-text'));
  if (c.started?.[key] && s.status === 'running') stageTick(c);
  if (hadFocus) li.querySelector('.stage-head')?.focus();
}

/** Types a summary in over at most ~300 ms. The untyped rest holds its space so the row doesn't reflow. */
function typeIn(el) {
  const full = el?.textContent || '';
  if (!full) return;
  const done = document.createElement('span'), rest = document.createElement('span');
  rest.className = 'untyped';
  rest.textContent = full;
  el.replaceChildren(done, rest);
  const t0 = performance.now(), total = Math.min(300, 60 + full.length * 4);
  const step = (t) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (t - t0) / total), n = Math.round(full.length * k);
    done.textContent = full.slice(0, n);
    rest.textContent = full.slice(n);
    if (k < 1) requestAnimationFrame(step); else el.textContent = full;
  };
  requestAnimationFrame(step);
}

function stageBody(s) {
  const parts = [];
  if (s.status === 'running') parts.push(html`<p class="working">Filling in this row…</p>`);
  if (Array.isArray(s.checks) && s.checks.length) parts.push(checksList(s.checks));
  const renderer = { extract: extractBody, vendor: vendorBody, po_match: poBody, duplicate: dupBody }[s.key];
  if (renderer && s.data && typeof s.data === 'object') {
    try { parts.push(renderer(s.data)); } catch (e) { console.warn(`Couldn't render ${s.key} details`, e); }
  }
  if (!parts.length) parts.push(html`<p class="muted small">No details recorded for this check.</p>`);
  return parts;
}

/** 'JPEG image, image, 112 KB' → 'JPEG image, 112 KB': drop a part another part already says. */
function dedupeParts(t) {
  const parts = String(t).split(', ');
  return parts.filter((p, i) => !parts.some((q, j) => j !== i && q.length > p.length && new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q))).join(', ');
}

const reasonFor = (code) => (cur?.run?.result?.reasons || cur?.run?.stages.find((s) => s.key === 'decision')?.data?.reasons || []).find((x) => x.code === code);

function checksList(checks) {
  // Ordinary checks are one ruled line (label | detail, the detail truncates with the full text in a tooltip).
  // Reason codes (decision stage) show the plain-English label with the full message beneath.
  return html`<ul class="checks">${checks.map((k) => {
    const code = isCode(k.label) ? k.label : null;
    const label = code ? k.reason_label || reasonLabel(reasonFor(code) || { code }) : k.label;
    const detail = prose(k.detail ?? '');
    const [mark, word] = CHECK_PEN[k.status] || CHECK_PEN.info;
    return html`<li class="check c-${k.status || 'info'}${code ? ' is-code' : ''}">
    <span class="check-mark tone-text t-${CHECK_TONE[k.status] || 'neutral'}">${pen(mark, 16, word)}</span>
    <span class="check-label" title="${code || label}">${label}</span>
    <span class="check-detail" title="${code ? '' : detail}">${detail}</span>
  </li>`; })}</ul>`;
}

const runCurrency = () => cur.run.currency || cur.run.extraction?.currency || '';

function conf(c) {
  if (c == null || isNaN(c)) return html`<span class="muted">—</span>`;
  const v = Math.max(0, Math.min(1, +c));
  return html`<span class="conf ${v < LOW_CONF ? 'low' : ''}" title="${v < LOW_CONF ? 'Low confidence' : 'Confidence'}"><span class="ink-bar"><i style="width:${(v * 100).toFixed(0)}%"></i></span><span>${v.toFixed(2)}</span>${v < LOW_CONF ? html`<span class="sr-only">low</span>` : ''}</span>`;
}

function fieldValue(f) {
  if (f.value == null || f.value === '') return html`<span class="missing">Not on invoice</span>`;
  const v = typeof f.value === 'object' ? JSON.stringify(f.value) : /date/i.test(f.key || '') ? day(String(f.value)) : String(f.value);
  return html`<span class="typed">${v}</span>`;
}

function extractBody(d) {
  const out = [];
  const cur$ = runCurrency();
  const meta = d.cached
    ? [html`<span>Read from the cache${d.originalLatencyMs != null ? html` · first read took <span class="typed">${dur(d.originalLatencyMs)}</span>` : ''}${d.model ? html` (<span class="typed">${d.model}</span>)` : ''}</span>`]
    : [d.model && html`<span>Model <span class="typed">${d.model}</span></span>`,
      d.latencyMs != null && html`<span>Read in <span class="typed">${dur(d.latencyMs)}</span></span>`].filter(Boolean);
  if (meta.length) out.push(html`<p class="meta-line">${meta}</p>`);
  if (Array.isArray(d.fields) && d.fields.length) {
    out.push(html`<h3 class="form-h3">Fields read</h3><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Field</th><th>Value</th><th class="r">Confidence</th></tr></thead>
      <tbody>${d.fields.map((f) => html`<tr><td class="nowrap cell-label">${f.label || f.key}</td><td class="wrap-any">${fieldValue(f)}</td><td class="r">${conf(f.confidence)}</td></tr>`)}</tbody>
    </table></div>`);
  }
  if (Array.isArray(d.lineItems) && d.lineItems.length) {
    out.push(html`<h3 class="form-h3">Line items</h3><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount${cur$ ? ` (${cur$})` : ''}</th></tr></thead>
      <tbody>${d.lineItems.map((l) => html`<tr>
        <td><span class="cell-desc">${l.description || '—'}</span>${l.item_code ? html`<span class="cell-code">${l.item_code}</span>` : ''}</td>
        <td class="num">${qty(l.quantity)}</td><td class="num">${num(l.unit_price, cur$)}</td><td class="num">${num(l.amount, cur$)}</td></tr>`)}</tbody>
    </table></div>`);
  }
  if (Array.isArray(d.notices) && d.notices.length) {
    out.push(html`<div class="notice t-review"><p class="notice-title">${pen('warn', 18)}Printed on the invoice</p><ul>${d.notices.map((n) => html`<li class="typed">“${n}”</li>`)}</ul></div>`);
  }
  return out;
}

/** Highlight characters of `val` that differ from `ref`, aligned from the right (account numbers). */
function diffMark(ref, val) {
  if (val == null || val === '') return html`<span class="muted">—</span>`;
  ref = String(ref ?? ''); val = String(val);
  if (ref === val) return val;
  const n = Math.max(ref.length, val.length), a = ref.padStart(n, '\0'), b = val.padStart(n, '\0');
  let out = '', open = false;
  for (let i = 0; i < n; i++) {
    if (b[i] === '\0') continue;
    const diff = a[i] !== b[i];
    if (diff !== open) { out += diff ? '<mark>' : '</mark>'; open = diff; }
    out += esc(b[i]);
  }
  return raw(out + (open ? '</mark>' : ''));
}

function vendorBody(d) {
  const out = [];
  const v = d.vendor || {};
  const method = { tax_id: 'tax ID', name: 'name', alias: 'alias', fuzzy: 'name' }[d.method] || d.method;
  if (v.name || v.vendor_id) {
    out.push(html`<p class="kv-line">Matched <strong>${v.name || v.vendor_id}</strong> ${v.name && v.vendor_id ? html`<span class="typed muted">${v.vendor_id}</span>` : ''}${method ? ` by ${method}` : ''}
      ${v.status === 'blocked' ? html`<span class="mini-stamp t-reject">Blocked</span>` : ''}</p>`);
  }
  const b = d.bank;
  if (b && (b.onFile || b.onInvoice)) {
    const f = b.onFile || {}, inv = b.onInvoice;
    const acct = (x) => x?.account ?? x?.account_number ?? x?.bank_account;
    const rout = (x) => x?.routing ?? x?.routing_code ?? x?.bank_routing;
    out.push(html`<h3 class="form-h3">Bank details</h3><div class="tbl-wrap"><table class="tbl bank ${b.differs ? 'differs' : ''}">
      <thead><tr><th><span class="sr-only">Source</span></th><th>Bank</th><th>Routing</th><th>Account</th></tr></thead>
      <tbody>
        <tr><th scope="row">On file</th><td>${f.bank_name || '—'}</td><td class="typed">${rout(f) || '—'}</td><td class="typed">${acct(f) || '—'}</td></tr>
        <tr class="${b.differs ? 'diff-row' : ''}"><th scope="row">On invoice</th>${inv
          ? html`<td>${inv.bank_name && f.bank_name && inv.bank_name !== f.bank_name ? html`<mark>${inv.bank_name}</mark>` : inv.bank_name || '—'}</td>
             <td class="typed">${diffMark(rout(f), rout(inv))}</td><td class="typed">${diffMark(acct(f), acct(inv))}</td>`
          : html`<td colspan="3" class="muted">Not shown on the invoice</td>`}</tr>
      </tbody></table></div>`);
  }
  return out;
}

function poBody(d) {
  const out = [];
  if (d.po_number) {
    out.push(html`<p class="po-head"><span class="typed strong">${d.po_number}</span>
      ${d.inferred ? html`<span class="ftab tab-sky">Inferred${d.score != null ? ` · score ${(+d.score).toFixed(2)}` : ''}</span>` : ''}
      ${d.matchType ? html`<span class="ftab">${d.matchType} match</span>` : ''}</p>`);
  }
  if (Array.isArray(d.candidates) && d.candidates.length > 1) {
    out.push(html`<h3 class="form-h3">Candidate POs</h3><ul class="cands">${d.candidates.map((x) => html`<li class="${x.po_number === d.po_number ? 'chosen' : ''}">
      <span class="typed">${x.po_number}</span><span class="ink-bar"><i style="width:${Math.max(0, Math.min(1, +x.score || 0)) * 100}%"></i></span>
      <span class="cand-score">${x.score != null ? (+x.score).toFixed(2) : '—'}</span><span class="cand-tag">${x.po_number === d.po_number ? 'Chosen' : ''}</span></li>`)}</ul>`);
  }
  out.push(lineMatch(d));
  return out;
}

/** The PO stage's line-match table; Remarks reuses it as the evidence for a quantity or price hold. */
function lineMatch(d, title = 'Line match') {
  if (!Array.isArray(d?.lines) || !d.lines.length) return '';
  const cur$ = runCurrency();
  return html`<h3 class="form-h3">${title}</h3><div class="tbl-wrap"><table class="tbl lines">
      <thead><tr><th class="r">Billed</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Prev. invoiced</th><th class="r">Unit price</th><th class="r">PO price</th><th class="r">Var.</th></tr></thead>
      ${d.lines.map((l) => lineRow(l, d, cur$))}</table></div>
      ${cur$ ? html`<p class="table-note">Prices in ${cur$}. ${d.matchType === '2-way' ? 'Services: 2-way match, no goods receipt needed.' : 'Goods: 3-way match against receipts.'}</p>` : ''}`;
}

function lineRow(l, d, cur$) {
  const prev = +l.prevInvoiced || 0;
  const overReceipt = l.received != null && l.billedQty > l.received - prev;
  const overPo = l.ordered != null && l.billedQty > l.ordered - prev;
  const bad = l.status === 'fail' ? 'fail' : l.status === 'warn' ? 'warn' : '';
  const qtyTone = overReceipt || overPo ? 'fail' : '';
  // Vermilion only for a variance known to exceed the limit; anything within tolerance stays violet.
  const tol = policy?.unitPricePct;
  const overTol = tol != null && l.variancePct != null && Math.abs(l.variancePct) > tol;
  const priceTone = bad && !qtyTone && l.variancePct ? (bad === 'fail' && (overTol || tol == null) ? 'fail' : 'warn') : '';
  const notOnPo = l.ordered == null && l.poUnitPrice == null;
  const rowTone = bad && !qtyTone && !priceTone ? bad : '';
  // Each line is two rows (item, then numbers) so seven number columns fit the slip.
  return html`<tbody class="li ${bad ? 'row-' + bad : ''}"><tr class="li-item"><td colspan="7" class="${rowTone ? 'cell-' + rowTone : ''}">
      <span class="li-desc">${l.description || '—'}</span>${notOnPo ? html`<span class="cell-tag">Not on PO</span>` : l.item_code ? html`<span class="li-code">${l.item_code}</span>` : ''}</td></tr>
    <tr class="li-nums"><td class="num ${qtyTone ? 'cell-' + qtyTone : ''}">${qty(l.billedQty)}</td>
    <td class="num ${overPo ? 'cell-fail' : ''}">${qty(l.ordered)}</td>
    <td class="num ${overReceipt ? 'cell-fail' : ''}" ${l.received == null && d.matchType === '2-way' ? raw('title="No receipt needed for services"') : ''}>${qty(l.received)}</td>
    <td class="num">${l.prevInvoiced == null ? '—' : qty(l.prevInvoiced)}</td>
    <td class="num">${num(l.unitPrice, cur$)}</td>
    <td class="num">${num(l.poUnitPrice, cur$)}</td>
    <td class="num ${priceTone ? 'cell-' + priceTone : ''}">${l.variancePct == null ? '—' : signedPct(l.variancePct)}</td>
  </tr></tbody>`;
}

function dupBody(d) {
  if (!d.originalRunId) return '';
  return html`<p class="kv-line"><a class="link" href="#/run/${encodeURIComponent(d.originalRunId)}">See the original run${d.invoiceNumber ? html` · <span class="typed">${d.invoiceNumber}</span>` : ''} ${icon('arrowRight', 16)}</a></p>`;
}

// ---------------------------------------------------------------- outcome: stamp, remarks, routing, sign-off
const CALLBACK_CODES = ['BANK_DETAILS_CHANGED', 'SUSPICIOUS_INSTRUCTIONS'];
const MATCH_CODES = ['QTY_EXCEEDS_RECEIPT', 'PRICE_VARIANCE']; // src/rules.js po_match: the line table is their evidence
const ERROR_TITLE = { unreadable_file: "Couldn't open this file", ai_unavailable: 'The AI reader is unavailable right now', internal: 'Something went wrong on our side' };
const NAME_KEY = 'invoice-desk:reviewer';

function inkStamp(o, date, cls = '') {
  const parts = [o.sub, date].filter(Boolean);
  // A sub-line much wider than the stamp word goes on two lines (destination, then date): about 3.4 sub letters per word letter.
  const stack = parts.length > 1 && parts.join(' · ').length > o.word.length * 3.4 + 4;
  return html`<div class="stamp t-${o.tone} ${cls}" role="img" aria-label="Stamped ${o.word}${o.sub ? ` ${lcFirst(o.sub)}` : ''}${date ? `, ${date}` : ''}">
  <span class="stamp-word">${o.word}</span>${parts.length ? html`<span class="stamp-sub${stack ? ' stack' : ''}">${stack ? parts.map((p) => html`<span>${p}</span>`) : parts.join(' · ')}</span>` : ''}</div>`;
}

// Where the slip goes, for the stamp's sub-line; a reviewer's own decision keeps "By reviewer".
// Only a duplicate goes back to the vendor; a blocked vendor or a non-invoice goes to the team named in the route.
const isResend = (res) => res?.reasons?.some((r) => r.code === 'DUPLICATE_INVOICE');
const stampDest = (o, res) => o.sub || (o.decision === 'APPROVE' ? 'To AP file'
  : o.decision === 'REJECT' && (isResend(res) || !res?.route) ? 'Back to vendor'
  : res?.route ? `To ${res.route}` : 'For review');

const copiesFooter = (active) => html`<span class="fl">Copies</span>${COPIES.map(([k, name, desk]) => html`<span class="copy ${k === active ? 'on' : ''}"><i class="cs cs-${k}" aria-hidden="true"></i>${name} — ${desk}${k === active ? html`<span class="sr-only"> (this copy)</span>` : ''}</span>`)}`;

function renderDecisionSlot(animate = true) {
  const c = cur, r = c.run, slot = $('#decision-slot');
  if (!slot) return;
  const ds = r.stages.find((s) => s.key === 'decision');
  const res = r.result?.decision ? r.result : ds?.data?.decision ? ds.data : null;
  const kind = isError(r) && r.status !== 'running' ? 'error' : res ? 'card' : 'pending';
  setTitle();
  const sig = JSON.stringify([kind, kind === 'card' ? [res, r.review, r.final] : kind === 'error' ? [r.error, r.result] : 0]);
  if (sig === c.decisionSig) return;
  c.decisionSig = sig;
  const o = kind === 'card' ? outcomeOf(r, res.decision) : null;
  const slip = $('#slip');
  slip?.classList.remove('copy-white', 'copy-canary', 'copy-pink');
  slip?.classList.add(`copy-${o?.copy || 'white'}`);
  const copies = $('#copies');
  if (copies) copies.innerHTML = copiesFooter(o?.copy || null);
  renderStampBox(kind, o, r, animate, res);
  // The decision, typed as one line under the field boxes, with a way down to the full remarks.
  const line = $('#decision-line');
  if (line) {
    const text = o?.human ? reviewerText(o.human) : o ? headlineOf(res) : '';
    line.innerHTML = text ? html`<p class="dl-text typed tone-text t-${o.tone}">${prose(text)}</p>
      <button type="button" class="link small dl-go" data-to-remarks>Read the remarks ${icon('arrowRight', 16)}</button>` : '';
  }
  const said = $('#decision-said');
  if (said && animate && kind !== 'pending') {
    said.textContent = kind === 'error' ? `Stopped. ${ERROR_TITLE[r.result?.errorKind] || "This run couldn't finish"}`
      : [o.word, o.human ? o.sub : prose(headlineOf(res))].filter(Boolean).join('. ');
  }
  if (kind === 'error') slot.innerHTML = errorCard(r);
  else if (kind === 'pending') slot.innerHTML = html`<section class="remarks fbox" aria-labelledby="rm-title"><h2 class="fl" id="rm-title">Remarks</h2>
    <div class="ruled-blank" aria-hidden="true"><i></i><i></i><i></i></div>
    <p class="pending-note">The decision, its reasons and the routing are filled in once every check has run.</p></section>`;
  else { slot.innerHTML = decisionCard(r, res, o); validateReview(); }
}

/** The decision box. A stamp that changes while you watch lands (once); opening a finished run shows it already inked. */
function renderStampBox(kind, o, r, animate, res) {
  const box = $('#stamp-box');
  if (!box) return;
  const key = o ? `${o.word}|${o.sub || ''}` : kind;
  const land = animate && o && cur.stampKey !== key && !reducedMotion();
  cur.stampKey = key;
  const at = o?.human?.at || r.final?.at || r.stages.find((s) => s.key === 'decision')?.endedAt || r.created_at;
  // Inked, the stamp sits over the head's right side; until then a dashed box holds its place.
  box.classList.toggle('inked', !!o);
  box.innerHTML = o ? inkStamp({ ...o, sub: stampDest(o, res) }, localDay(at)) : html`<span class="fl">Decision</span>${kind === 'error'
    ? html`<span class="sb-retry"><span class="sb-empty">Not decided. The run stopped before a decision.</span>${r.superseded_by ? '' : html`<button type="button" class="btn sm" data-retry>${icon('retry', 16)}Retry</button>`}</span>`
    : html`<span class="sb-empty">Stamped here once every check has run</span>`}`;
  if (land) {
    box.querySelector('.stamp')?.classList.add('land');
    const slip = $('#slip');
    slip.classList.remove('jolt');
    void slip.offsetWidth; // restart the jolt if a second stamp lands
    slip.classList.add('jolt');
  }
}

function errorCard(r) {
  const res = r.result || {};
  const failed = r.stages.find((s) => s.status === 'failed');
  const title = ERROR_TITLE[res.errorKind] || "This run couldn't finish";
  // The server headline may repeat the title ("Couldn't open this file — it may be…"); keep only what it adds.
  let text = prose(res.headline || r.error || failed?.summary || 'Something went wrong while processing this file.');
  if (text.toLowerCase().startsWith(title.toLowerCase())) text = text.slice(title.length).replace(/^[\s—–:.-]+/, '');
  if (text) text = text[0].toUpperCase() + text.slice(1);
  const actions = Array.isArray(res.nextActions) ? res.nextActions : [];
  return html`<section class="exception" aria-labelledby="ex-title">
    <h2 class="ex-title" id="ex-title">${title}</h2>
    <p class="ex-sub">Nothing was decided and nothing will be paid.</p>
    ${text ? html`<p class="explanation">${text}</p>` : ''}
    ${actions.length ? html`<h3 class="form-h3">What to do</h3><ul class="ex-actions">${actions.map((a) => html`<li>${prose(a)}</li>`)}</ul>` : ''}
    <div class="retry-row">${r.superseded_by
      ? html`<span>Already retried. <a class="link" href="#/run/${encodeURIComponent(r.superseded_by)}">Open the newer slip ${icon('arrowRight', 16)}</a></span>`
      : html`<button type="button" class="btn primary" data-retry>${icon('retry', 18)}Retry this file</button>
      <span class="small muted">Starts a new run on the same file and reads it fresh.</span>`}
    </div>
    <p class="form-error" id="retry-error" role="alert"></p>
  </section>`;
}

/** An in-flight button says what it is doing; busy(btn) with no text restores its own label. */
function busy(btn, text) {
  if (text) { btn.dataset.idle = btn.innerHTML; btn.textContent = text; btn.setAttribute('aria-busy', 'true'); } else {
    if (btn.dataset.idle != null) btn.innerHTML = btn.dataset.idle;
    delete btn.dataset.idle;
    btn.removeAttribute('aria-busy');
  }
  btn.disabled = !!text;
  btn.classList.toggle('busy', !!text);
}

async function retryRun(btn) {
  const c = cur, r = c.run;
  const err = $('#retry-error');
  busy(btn, 'Starting…');
  try {
    let id;
    try { ({ id } = await api(`/api/runs/${encodeURIComponent(c.id)}/retry`, { method: 'POST' })); } catch (e) {
      // v1 servers have no retry endpoint: a sample can still be re-run fresh.
      if (e.status !== 404 || r.source !== 'sample' || !r.filename) throw e;
      ({ id } = await api(`/api/runs?sample=${encodeURIComponent(r.filename)}&fresh=1`, { method: 'POST' }));
    }
    runsChanged();
    location.hash = `#/run/${encodeURIComponent(id)}`;
  } catch (e) {
    if (c !== cur) return;
    if (err) err.textContent = e.status === 404 ? "This server can't retry uploads yet. Drop the file again to start a new run." : [409, 429].includes(e.status) ? e.message : `Couldn't retry: ${e.message}`;
    busy(btn);
  }
}

const primaryOf = (res) => res.primaryReason || (Array.isArray(res.reasons) ? [...res.reasons].sort((a, b) => (b.severity === 'block') - (a.severity === 'block')).find((x) => x.severity !== 'info') : null) || null;

const lcFirst = (t) => (/^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));

/** "..., bank details changed (+1 more)." becomes "..., bank details changed and lookalike email domain." */
function spellMore(headline, primary, reasons) {
  const m = /\s*\(\+(\d+) more\)/.exec(headline);
  if (!m || !primary) return headline;
  const same = reasons.filter((x) => x.severity === primary.severity);
  if (same.length - 1 !== +m[1]) return headline;
  // one reason per PO line repeats a code; name each kind once, and drop the suffix when every extra is the primary's kind
  const rest = [...new Set(same.filter((x) => x.code !== primary.code).map((x) => lcFirst(reasonLabel(x))))];
  if (!rest.length) return headline.slice(0, m.index) + headline.slice(m.index + m[0].length);
  const words = rest.length > 1 ? `, ${rest.slice(0, -1).join(', ')} and ${rest.at(-1)}` : ` and ${rest[0]}`;
  return headline.slice(0, m.index) + words + headline.slice(m.index + m[0].length);
}

function headlineOf(res) {
  const primary = primaryOf(res);
  return res.headline ? spellMore(res.headline, primary, Array.isArray(res.reasons) ? res.reasons : []) : primary ? reasonLabel(primary) : '';
}

function decisionCard(r, res, o) {
  const fin = o?.human || null; // a person's decision on a held run
  // The rules raise one reason per PO line (two short lines are two QTY_EXCEEDS_RECEIPT); the remarks list each code once.
  const reasons = [];
  for (const x of Array.isArray(res.reasons) ? res.reasons : []) {
    const same = x.code && reasons.find((y) => y.code === x.code);
    if (!same) reasons.push({ ...x, msgs: x.message ? [x.message] : [] });
    else {
      if (x.message && !same.msgs.includes(x.message)) same.msgs.push(x.message);
      if (x.severity === 'block') same.severity = 'block';
    }
  }
  const holds = reasons.filter((x) => x.severity !== 'info').sort((a, b) => (b.severity === 'block') - (a.severity === 'block'));
  const notes = reasons.filter((x) => x.severity === 'info');
  const po = r.stages.find((s) => s.key === 'po_match')?.data;
  const evidence = reasons.some((x) => MATCH_CODES.includes(x.code) && x.severity !== 'info') ? lineMatch(po, 'Match') : '';
  const actions = Array.isArray(res.nextActions) ? res.nextActions : [];
  const primary = primaryOf(res);
  // Once a person decides, the system's pending prose ("nothing will be paid until…") no longer holds.
  const explanation = fin ? '' : res.explanation || '';
  const explained = explanation;
  const reasonRow = (x) => {
    const sv = SEVERITY[x.severity] || SEVERITY.info;
    // A message the explanation already says is not repeated under its reason.
    const msgs = x.msgs.filter((m) => !explained.includes(m));
    return html`<li class="reason"><span class="reason-mark tone-text t-${sv.tone}">${pen(sv.mark, 18, sv.label)}</span>
      <span class="reason-body"><span class="reason-label">${reasonLabel(x)}</span>${x.code ? html`<span class="reason-code">${x.code}</span>` : ''}
      ${msgs.map((m) => html`<span class="reason-msg">${prose(m)}</span>`)}</span></li>`;
  };
  const pay = fin ? (fin.decision === 'APPROVE' ? fin.payment : null) : res.payment;
  const ptone = primary ? (SEVERITY[primary.severity] || SEVERITY.hold).tone : 'neutral';
  const headline = headlineOf(res);
  return html`<section class="remarks fbox" id="remarks" tabindex="-1" aria-labelledby="rm-title">
      <h2 class="fl" id="rm-title">Remarks</h2>
      ${fin ? html`<p class="rm-value muted">System held it${primary ? `: ${reasonLabel(primary)}` : ''}</p>`
        : headline ? html`<p class="rm-value typed${res.decision !== 'APPROVE' ? ` tone-text t-${ptone}` : ''}">${prose(headline)}</p>` : ''}
      ${explanation ? html`<p class="explanation">${prose(explanation)}</p>` : ''}
      ${holds.length ? html`<ul class="reasons">${holds.map(reasonRow)}</ul>` : ''}
      ${evidence ? html`<div class="rm-match">${evidence}</div>` : ''}
      ${notes.length ? html`<h3 class="form-h3">Notes</h3><ul class="reasons notes">${notes.map(reasonRow)}</ul>` : ''}
    </section>
    <div class="outcome-grid">
      ${routingSlip(res, fin)}
      ${fin ? reviewerOutcome(fin) : actions.length ? html`<section class="next" aria-labelledby="na-title"><h2 class="form-h" id="na-title">Next actions</h2>
        <ul class="actions">${actions.map((a, i) => html`<li><input type="checkbox" class="box" id="na-${r.id}-${i}"><label for="na-${r.id}-${i}">${prose(a)}</label></li>`)}</ul></section>` : ''}
    </div>
    ${paymentLine(pay)}
    ${res.vendorEmail ? emailBlock(res.vendorEmail) : ''}
    ${res.decision === 'REVIEW' ? (fin ? signedBlock(fin) : r.superseded_by ? supersededBlock(r) : reviewForm(r, res)) : ''}`;
}

/** The routing slip: every desk on the form, ticked where this invoice went. */
function routingSlip(res, fin) {
  const route = res.route || null;
  const hit = route ? DESKS.find((d) => route.toLowerCase().startsWith(d.toLowerCase())) : null;
  const desks = route && !hit ? [...DESKS, route] : DESKS;
  const ticked = new Set([hit || route].filter(Boolean));
  if (res.decision === 'APPROVE' || fin?.decision === 'APPROVE') ticked.add('AP file');
  return html`<section class="routing" aria-labelledby="rt-title"><h2 class="form-h" id="rt-title">Route to</h2>
    <ul class="route-list">${desks.map((d) => { const on = ticked.has(d); return html`<li class="${on ? 'on' : ''}"><span class="tick-box sm">${on ? pen('pass', 22) : ''}</span><span>${d}</span>${on ? html`<span class="sr-only"> (routed here)</span>` : ''}</li>`; })}</ul>
  </section>`;
}

const paymentLine = (p) => html`<div class="pay-line"><span class="fl">Payment</span>${p && p.amount != null
  ? html`<span class="typed pay-amt">${money(p.amount, p.currency)}</span><span class="pay-when">${p.scheduledFor ? `scheduled for ${day(p.scheduledFor)}` : 'scheduled'}</span>`
  : html`<span class="pay-none">None scheduled</span>`}</div>`;

function emailBlock(e) {
  const text = `To: ${e.to || ''}\nSubject: ${e.subject || ''}\n\n${e.body || ''}`;
  return html`<details class="memo">
    <summary><span class="chev">${icon('chev', 16)}</span><span class="memo-title">Memo to vendor</span><span class="memo-state">Draft, not sent</span>${e.to ? html`<span class="memo-to">${e.to}</span>` : ''}</summary>
    <div class="memo-body">
      <dl class="memo-meta"><div><dt class="fl">To</dt><dd class="typed">${e.to || '—'}</dd></div><div><dt class="fl">Subject</dt><dd class="typed">${e.subject || '—'}</dd></div></dl>
      <pre class="memo-text">${e.body || ''}</pre>
      <div class="memo-tools"><span class="small muted">Nothing is sent from here. Copy it into your mail.</span>${copyButton(text)}</div>
    </div>
  </details>`;
}

function vendorContact(r) {
  const v = r.stages.find((s) => s.key === 'vendor')?.data?.vendor || {};
  return { name: v.name || r.vendor_name || r.extraction?.vendor?.name || 'the vendor', phone: v.phone || null };
}

function reviewForm(r, res) {
  const needsCall = (res.reasons || []).some((x) => CALLBACK_CODES.includes(x.code));
  const v = vendorContact(r);
  let name = '';
  try { name = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
  return html`<section class="sign" id="review-form" role="group" aria-labelledby="sign-title">
    <h2 class="form-h" id="sign-title">Reviewer sign-off</h2>
    <p class="sign-lede">A person decides held invoices. Sign with your name and say what you checked; it goes on the audit trail.</p>
    <div class="sign-grid">
      <label class="fbox input-box f-name"><span class="fl">Reviewed by</span><input type="text" id="review-name" autocomplete="name" required minlength="2" value="${name}" placeholder="For example, Priya N."></label>
      <div class="fbox f-date"><span class="fl">Date</span><span class="typed">${localDay(new Date().toISOString())}</span></div>
      <label class="fbox input-box f-note"><span class="fl">Note</span><textarea id="review-note" rows="2" required minlength="3" placeholder="What did you check?"></textarea></label>
    </div>
    ${needsCall ? html`<div class="callback"><input type="checkbox" id="review-callback" class="box">
      <label for="review-callback">I called <strong>${v.name}</strong> on the number in our vendor master${v.phone ? html`, <span class="typed nowrap">${v.phone}</span>,` : ''} and confirmed the change.</label></div>` : ''}
    <div class="review-actions">
      <button type="button" class="btn approve" data-review="approve" disabled>${pen('pass', 18)}Approve for payment</button>
      <button type="button" class="btn reject" data-review="reject" disabled>${pen('fail', 18)}Reject invoice</button>
      <span class="review-hint" id="review-hint" aria-live="polite"></span>
    </div>
    <p class="form-error" id="review-error" role="alert"></p>
  </section>`;
}

/** A held run that was retried is signed off on the newer slip, not this one. */
const supersededBlock = (r) => html`<section class="sign" aria-labelledby="sign-title"><h2 class="form-h" id="sign-title">Reviewer sign-off</h2>
  <p class="sign-lede">This hold was retried as a new run, so it is signed off there. <a class="link" href="#/run/${encodeURIComponent(r.superseded_by)}">Open the newer slip ${icon('arrowRight', 16)}</a></p></section>`;

/** In place of the system's next actions once a reviewer has decided. */
function reviewerText(fin) {
  const who = fin.reviewer || fin.review?.reviewer || 'a reviewer';
  const on = fin.at ? ` on ${localDay(fin.at)}` : '';
  const sched = fin.payment?.scheduledFor;
  return fin.decision === 'APPROVE'
    ? `Approved by ${who}${on} — ${sched ? `payment scheduled ${day(sched)}` : 'payment scheduled'}`
    : `Rejected by ${who}${on} — vendor to be told`;
}
const reviewerOutcome = (fin) => html`<section class="next" aria-labelledby="na-title"><h2 class="form-h" id="na-title">Outcome</h2>
    <p class="rm-value typed tone-text t-${fin.decision === 'APPROVE' ? 'approve' : 'reject'}">${reviewerText(fin)}</p></section>`;

function signedBlock(fin) {
  const rv = fin.review || {};
  const who = fin.reviewer || rv.reviewer;
  return html`<section class="sign signed" aria-labelledby="sign-title">
    <h2 class="form-h" id="sign-title">Reviewer sign-off</h2>
    <dl class="sign-grid">
      <div class="fbox f-name"><dt class="fl">Reviewed by</dt><dd class="typed">${who || '—'}</dd></div>
      <div class="fbox f-date"><dt class="fl">Date</dt><dd class="typed">${fin.at ? when(fin.at) : '—'}</dd></div>
      <div class="fbox f-note"><dt class="fl">Note</dt><dd class="typed">${rv.note || '—'}</dd></div>
    </dl>
    ${rv.callbackVerified ? html`<p class="callback-ok"><span class="tick-box sm">${pen('pass', 22)}</span>Confirmed by call-back to the number in the vendor master</p>` : ''}
  </section>`;
}

/** Enables Approve / Reject only when the form is complete, and says what is missing. */
function validateReview() {
  const f = $('#review-form');
  if (!f || f.dataset.busy) return;
  const name = $('#review-name').value.trim(), note = $('#review-note').value.trim();
  const cb = $('#review-callback');
  const base = name.length >= 2 && note.length >= 3;
  const missing = [name.length < 2 && 'your name', note.length < 3 && 'a note'].filter(Boolean);
  $('[data-review="reject"]').disabled = !base;
  $('[data-review="approve"]').disabled = !base || (cb && !cb.checked);
  $('#review-hint').textContent = missing.length ? `Add ${missing.join(' and ')} to decide.`
    : cb && !cb.checked ? 'Approving needs the call-back confirmed.' : '';
}

function onReviewInput(e) {
  if (!e.target.closest?.('#review-form')) return;
  const err = $('#review-error');
  if (err) err.textContent = '';
  validateReview();
}

async function submitReview(action, btn) {
  const c = cur, f = $('#review-form');
  const reviewer = $('#review-name')?.value.trim() || '';
  const note = $('#review-note')?.value.trim() || '';
  const callbackVerified = !!$('#review-callback')?.checked;
  const err = $('#review-error');
  try { localStorage.setItem(NAME_KEY, reviewer); } catch { /* ignore */ }
  f.dataset.busy = '1';
  root.querySelectorAll('[data-review]').forEach((b) => { b.disabled = true; });
  busy(btn, 'Saving…');
  try {
    await api(`/api/runs/${encodeURIComponent(c.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, reviewer, note, callbackVerified }) });
    const run = await api(`/api/runs/${encodeURIComponent(c.id)}`);
    if (c !== cur) return;
    // v1 servers drop the reviewer name and call-back flag; keep what the person typed so the slip stays truthful.
    c.run.review = { action, reviewer, note, callbackVerified, at: new Date().toISOString(), ...(run.review || {}) };
    if (run.final) c.run.final = run.final;
    // Bring the decision box into view first, so the reviewer's stamp lands where it can be seen.
    const slip = $('#slip');
    if (slip && slip.getBoundingClientRect().top < 0 && !reducedMotion()) {
      slip.scrollIntoView({ block: 'start', behavior: 'smooth' });
      await new Promise((ok) => setTimeout(ok, 450));
      if (c !== cur) return;
    } else if (slip && slip.getBoundingClientRect().top < 0) slip.scrollIntoView({ block: 'start' });
    renderHead(); // drops the Retry link: a signed-off hold cannot be retried
    renderDecisionSlot(true);
    loadSamples();
    runsChanged();
  } catch (e) {
    if (c !== cur) return;
    delete f.dataset.busy;
    if (err) err.textContent = [400, 409, 429].includes(e.status) ? e.message : `Couldn't save the review: ${e.message}`;
    busy(btn);
    validateReview();
  }
}

// ---------------------------------------------------------------- document column: the original, clipped to the slip
const CLIP = raw('<svg class="clip" width="22" height="58" viewBox="0 0 22 58" aria-hidden="true" focusable="false"><path class="clip-wire" d="M7.5 22v21.5a3.5 3.5 0 0 0 7 0V11a5.5 5.5 0 0 0-11 0v35.5a7.5 7.5 0 0 0 15 0V19"/><path class="clip-shine" d="M3.5 13v6M7.5 25v8"/></svg>');

function renderDoc() {
  const c = cur, r = c.run, id = encodeURIComponent(c.id);
  const isImg = /^image\//.test(r.mime || '') || /\.(png|jpe?g)$/i.test(r.filename || '');
  // The blank slip of a run opened by link doesn't know its file type yet; the snapshot fills the sheet.
  const kind = r.placeholder && !r.filename ? 'blank' : isImg ? 'img' : 'pdf';
  const col = $('#doc-col');
  // The snapshot re-renders the slip; keep an original that is already loading rather than fetch it twice.
  if (col.dataset.doc === `${c.id}|${kind}` && $('#pane-doc')) return renderJson();
  col.dataset.doc = `${c.id}|${kind}`;
  const docTab = (k, label) => tab('doctab', k, label, c.docTab === k, `pane-${k}`, `tab-${k}`);
  col.innerHTML = html`${switcher('doc')}
    <div class="doc-bar"><div role="tablist" aria-label="Document view" class="tabs">${docTab('doc', 'Document')}${docTab('json', 'Extracted JSON')}</div>
      <a class="link small doc-open" href="/api/runs/${id}/file" target="_blank" rel="noopener">Open original ${icon('external', 16)}</a></div>
    <div class="doc-sheet">${CLIP}
      <div class="doc-pane" id="pane-doc" role="tabpanel" aria-labelledby="tab-doc" ${c.docTab === 'doc' ? '' : raw('hidden')}>
        ${kind === 'blank' ? '' : isImg ? html`<img src="/api/runs/${id}/file" alt="Invoice ${r.filename || ''}">` : html`<iframe src="/api/runs/${id}/file#toolbar=0&navpanes=0&view=FitH" title="Invoice ${r.filename || ''}"></iframe>`}
      </div>
      <div class="json-pane" id="pane-json" role="tabpanel" aria-labelledby="tab-json" ${c.docTab === 'json' ? '' : raw('hidden')}></div>
    </div>`;
  renderJson();
}

function highlightJson(text) {
  const safe = text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return raw(safe.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, lit) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    return lit ? `<span class="j-lit">${m}</span>` : `<span class="j-num">${m}</span>`;
  }));
}

function renderJson() {
  const pane = $('#pane-json');
  if (!pane || !cur) return;
  const x = cur.run.extraction;
  if (!x) { pane.innerHTML = html`<p class="muted pad">The extracted fields appear here once the read finishes.</p>`; return; }
  const text = JSON.stringify(x, null, 2);
  pane.innerHTML = html`<div class="json-tools"><span class="muted small">What the model read, exactly as stored</span>${copyButton(text)}</div><pre class="json">${highlightJson(text)}</pre>`;
}

// ---------------------------------------------------------------- events
function onRunClick(e) {
  const t = e.target;
  const head = t.closest('button.stage-head');
  if (head) {
    const key = head.closest('.stage').dataset.key;
    const s = cur?.run.stages.find((x) => x.key === key);
    if (s) { cur.manual.set(key, !isOpen(s)); renderStage(key, false); }
    return;
  }
  const rv = t.closest('[data-review]');
  if (rv) return rv.disabled ? undefined : submitReview(rv.dataset.review, rv);
  const rt = t.closest('[data-retry]');
  if (rt) return retryRun(rt);
  if (t.closest('[data-to-remarks]')) {
    const rm = $('#remarks');
    rm?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    return rm?.focus({ preventScroll: true });
  }
  const go = t.closest('[data-start-no]');
  if (go) {
    // The same start as clicking that sample's card in the tray.
    const s = samples?.find((x) => sampleNo(x.file) === go.dataset.startNo);
    return s ? startSample(s.file) : dropMsg("Couldn't find that sample in the in tray.");
  }
  if (t.closest('[data-doc-toggle]')) return setDocHidden(!docHidden);
  const dt = t.closest('[data-doctab]');
  if (dt && cur) {
    cur.docTab = dt.dataset.doctab;
    root.querySelectorAll('[data-doctab]').forEach((b) => { const on = b.dataset.doctab === cur.docTab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    $('#pane-doc').hidden = cur.docTab !== 'doc';
    $('#pane-json').hidden = cur.docTab !== 'json';
    return;
  }
  const sw = t.closest('[data-switch]');
  if (sw) {
    const doc = sw.dataset.switch === 'doc';
    root.classList.toggle('show-doc', doc);
    root.querySelector(`${doc ? '#doc-col' : '#run-col'} [data-switch="${sw.dataset.switch}"]`)?.focus();
  }
}

/** Arrow keys move between tabs in a tablist. */
function onTabKeys(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const tab = e.target.closest('[role="tab"]');
  if (!tab) return;
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.focus();
  next.click();
}

function renderMissing(e) {
  $('#doc-col').innerHTML = '';
  root.classList.remove('has-run');
  $('#run-col').innerHTML = html`<div class="landing-main missing-run"><h1 class="page-title">${e.status === 404 ? 'This slip is no longer on file' : "Couldn't open this run"}</h1>
    <p class="lede">${e.status === 404 ? 'It may have been cleared by Reset demo.' : e.message}</p>
    <p><a class="btn" href="#/runs">Go to the register</a></p></div>`;
}
