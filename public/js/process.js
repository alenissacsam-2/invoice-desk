// Process screen: inbox rail, live run view (SSE), document column.
import {
  api, html, raw, esc, money, num, qty, dur, clock, day, signedPct, icon, statusIcon, runsChanged, copyButton,
  DECISION, STAGE_TONE, CHECK_ICON, CHECK_TONE, SEVERITY,
} from './util.js';

const STAGES = [
  ['intake', 'Intake', 'Checks the file type, size and fingerprint, and whether this exact file was seen before.'],
  ['extract', 'Read the invoice', 'Gemini reads the document into structured fields, with a confidence score for each.'],
  ['validate', 'Validate', 'Required fields, arithmetic, dates and tax IDs are checked with plain rules.'],
  ['vendor', 'Vendor check', 'Finds the vendor in the master file and compares the bank details on file.'],
  ['duplicate', 'Duplicate check', 'Looks in the ledger for the same invoice billed twice.'],
  ['po_match', 'PO match', 'Finds the purchase order, or infers it, then matches lines, prices and goods received.'],
  ['decision', 'Decision', 'Approve, hold for review or reject, with reasons, a route and next steps.'],
];
const DESC = Object.fromEntries(STAGES.map(([k, , d]) => [k, d]));
const STATUS_WORD = { pending: 'Waiting', running: 'Running', passed: 'Passed', warning: 'Warning', failed: 'Failed', skipped: 'Skipped' };
const GAP_MS = 280; // minimum time between visible stage transitions
const MAX_BYTES = 10 * 1024 * 1024;
const LOW_CONF = 0.7; // display only; the rules use src/config.js

let root = null;      // .process element
let samples = null;   // cached /api/samples
let samplesError = null;
let cur = null;       // the open run: { id, run, es, queue, busy, manual, applied, tick, docTab, decisionSig }
let starting = false; // a sample/upload POST is in flight

const $ = (sel) => root?.querySelector(sel);

export function mountProcess(main, id) {
  if (!root || !main.contains(root)) build(main);
  if (!id) {
    closeRun();
    root.classList.remove('has-run', 'show-doc');
    renderEmpty();
  } else if (cur?.id !== id) openRun(id);
  renderSamples();
}

export function unmountProcess() { closeRun(); root = null; }

// ---------------------------------------------------------------- layout
function build(main) {
  main.innerHTML = html`<div class="process">
    <aside class="inbox" aria-label="Inbox">
      <div class="drop" id="drop">
        <input type="file" id="file-input" class="sr-only" tabindex="-1" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg">
        <span class="drop-icon">${icon('upload', 18)}</span>
        <span class="drop-title">Drop an invoice <span class="muted">(PDF, PNG, JPG)</span></span>
        <span class="drop-sub">or <button type="button" class="link" id="browse">browse</button> · max 10 MB</span>
      </div>
      <p class="drop-msg" id="drop-msg" role="alert"></p>
      <label class="opt"><input type="checkbox" id="fresh"> Re-extract (skip cache)</label>
      <h2 class="section-title inbox-title">Sample inbox <span class="count mono" id="sample-count"></span></h2>
      <ul class="samples" id="samples"><li class="muted pad">Loading samples…</li></ul>
    </aside>
    <section class="run-col" id="run-col" aria-label="Run"></section>
    <section class="doc-col" id="doc-col" aria-label="Document"></section>
  </div>`;
  root = main.querySelector('.process');

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

// ---------------------------------------------------------------- inbox
async function loadSamples() {
  try { samples = await api('/api/samples'); samplesError = null; } catch (e) { samplesError = e.message; samples = []; }
  if (!Array.isArray(samples)) samples = samples?.samples || [];
  renderSamples();
}

const sampleNo = (file) => (/^(\d+)/.exec(file || '') || [])[1] || '';

function renderSamples() {
  const list = $('#samples');
  if (!list || !samples) return;
  $('#sample-count').textContent = samples.length || '';
  if (samplesError) { list.innerHTML = html`<li class="pad error-text">Couldn't load the sample inbox: ${samplesError}</li>`; return; }
  if (!samples.length) { list.innerHTML = html`<li class="pad muted">No samples found in samples/manifest.json.</li>`; return; }
  const curFile = cur?.run?.source === 'sample' ? cur.run.filename : null;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.file : null;
  list.innerHTML = html`${samples.map((s) => {
    const d = DECISION[s.expected];
    const tags = Array.isArray(s.tags) ? s.tags : [];
    return html`<li><button type="button" class="sample" data-file="${s.file}" ${s.file === curFile ? raw('aria-current="true"') : ''} ${starting ? raw('aria-disabled="true"') : ''} title="${s.title || s.file}">
      <span class="sample-top">
        <span class="sample-no mono">${sampleNo(s.file)}</span>
        <span class="sample-vendor">${s.vendor || s.title || s.file}</span>
      </span>
      <span class="sample-scn">${s.scenario || s.title || ''}</span>
      <span class="sample-foot">
        ${tags.map((t) => html`<span class="chip sm ${/happy/i.test(t) ? 't-accent' : /edge/i.test(t) ? 't-review' : ''}">${t}</span>`)}
        ${s.runAfter ? html`<span class="hint">run after ${sampleNo(s.runAfter) || s.runAfter}</span>` : ''}
        ${s.expected ? html`<span class="expects mono">expects <span class="tone-text t-${d?.tone || 'neutral'}">${s.expected}</span></span>` : ''}
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
    location.hash = `#/run/${encodeURIComponent(id)}`;
  } catch (e) { dropMsg(`Couldn't start this sample: ${e.message}`); } finally { starting = false; renderSamples(); }
}

async function upload(f) {
  dropMsg('');
  const okType = /^(application\/pdf|image\/png|image\/jpeg)$/.test(f.type) || /\.(pdf|png|jpe?g)$/i.test(f.name);
  if (!okType) return dropMsg("This file isn't a PDF or image. Drop a PDF, PNG or JPG.");
  if (!f.size) return dropMsg('This file is empty.');
  if (f.size > MAX_BYTES) return dropMsg(`This file is ${(f.size / 1048576).toFixed(1)} MB. The limit is 10 MB.`);
  if (starting) return;
  starting = true;
  $('#drop').classList.add('busy');
  try {
    const q = freshQ();
    const { id } = await api(`/api/runs${q ? '?' + q : ''}`, {
      method: 'POST', body: f,
      // Header values must be Latin-1, so the name is URI-encoded; the server decodes it.
      headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
    });
    location.hash = `#/run/${encodeURIComponent(id)}`;
  } catch (e) { dropMsg(`Upload failed: ${e.message}`); } finally { starting = false; $('#drop')?.classList.remove('busy'); }
}

// ---------------------------------------------------------------- empty state
function renderEmpty() {
  $('#doc-col').innerHTML = '';
  $('#run-col').innerHTML = html`<div class="empty-run">
    <h1 class="page-title">How a run works</h1>
    <p class="lede">Every invoice goes through the same seven stages. The model only reads the document. Each decision is made by plain rules you can audit.</p>
    <ol class="steps">${STAGES.map(([, label, desc], i) => html`<li>
      <span class="step-n mono">${String(i + 1).padStart(2, '0')}</span>
      <span class="step-text"><span class="step-name">${label}</span><span class="step-desc">${desc}</span></span>
    </li>`)}</ol>
    <div class="outcomes">
      ${[['APPROVE', 'Scheduled for payment on the due date.'], ['REVIEW', 'Held and routed to a named team, with next steps.'], ['REJECT', 'Never paid, with the reason on record.']].map(([k, t]) => html`
        <div class="outcome t-${DECISION[k].tone}"><span class="tone-text">${icon(DECISION[k].icon, 14)}</span><span><span class="outcome-word mono tone-text">${k}</span><span class="outcome-text">${t}</span></span></div>`)}
    </div>
    <p class="prompt">${icon('arrowLeft', 14)} Pick a sample or drop a file to start.</p>
  </div>`;
}

// ---------------------------------------------------------------- run lifecycle
function closeRun() {
  if (!cur) return;
  cur.es?.close();
  clearInterval(cur.tick);
  clearTimeout(cur.pollT);
  cur = null;
}

function openRun(id) {
  closeRun();
  const c = cur = { id, run: null, es: null, queue: [], busy: false, manual: new Map(), applied: new Map(), tick: null, docTab: 'doc', decisionSig: null, done: false };
  root.classList.add('has-run');
  root.classList.remove('show-doc');
  $('#run-col').scrollTop = 0;
  if (!matchMedia('(min-width: 800px)').matches) window.scrollTo(0, 0); // phones: the run sits above the inbox
  $('#run-col').innerHTML = html`<div class="run-loading muted"><span class="spin"></span> Opening run <span class="mono">${id}</span>…</div>`;
  $('#doc-col').innerHTML = '';

  const parse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  const es = c.es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  es.addEventListener('snapshot', (e) => { const run = parse(e); if (c === cur && run) { c.queue.length = 0; applySnapshot(run); } });
  es.addEventListener('stage', (e) => { const d = parse(e); const s = d?.stage || d; if (c === cur && s?.key) enqueue(() => applyStage(s)); });
  es.addEventListener('done', (e) => { const run = parse(e); c.done = true; es.close(); if (c === cur) enqueue(() => applyDone(run?.run || run)); });
  es.onerror = () => { if (c !== cur || c.done) return; es.close(); poll(c); };
}

/** Fallback when SSE is unavailable: poll the run until it finishes. */
async function poll(c) {
  let run;
  try { run = await api(`/api/runs/${encodeURIComponent(c.id)}`); } catch (e) { if (c === cur) renderMissing(e); return; }
  if (c !== cur) return;
  if (!c.run) applySnapshot(run);
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
  setTimeout(() => { c.busy = false; pump(c); }, GAP_MS);
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
  if (matchMedia('(min-width: 800px)').matches) $('.sample[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

function applyStage(s) {
  const c = cur, stages = c.run.stages;
  const i = stages.findIndex((x) => x.key === s.key);
  if (i >= 0) stages[i] = { ...stages[i], ...s };
  else { stages.push({ status: 'pending', checks: [], ...s }); $('#timeline')?.insertAdjacentHTML('beforeend', String(html`<li class="stage" data-key="${s.key}"></li>`)); }
  renderStage(s.key, true);
  renderProgress();
  renderDecisionSlot();
  // The extraction JSON is not on stage events; fetch it once the read stage finishes.
  if (s.key === 'extract' && !['pending', 'running'].includes(s.status) && !c.run.extraction) {
    api(`/api/runs/${encodeURIComponent(c.id)}`).then((r) => { if (c === cur && r?.extraction) { c.run.extraction = r.extraction; renderJson(); } }).catch(() => {});
  }
}

function applyDone(run) {
  const c = cur;
  if (run && typeof run === 'object' && run.id) c.run = normalize({ ...c.run, ...run });
  else c.run.status = c.run.status === 'running' ? 'done' : c.run.status;
  c.done = true;
  c.run.stages.forEach((s) => renderStage(s.key, true));
  renderHead();
  renderProgress();
  renderDecisionSlot();
  renderJson();
  renderSamples();
  runsChanged();
}

// ---------------------------------------------------------------- run rendering
const switcher = (which) => html`<div class="switch" role="tablist" aria-label="Run view">
  <button type="button" role="tab" data-switch="run" aria-selected="${which === 'run' ? 'true' : 'false'}">Pipeline</button>
  <button type="button" role="tab" data-switch="doc" aria-selected="${which === 'doc' ? 'true' : 'false'}">Document</button>
</div>`;

function renderRun() {
  const r = cur.run;
  $('#run-col').innerHTML = html`${switcher('run')}
    <div id="run-head"></div>
    <div id="decision-slot" class="decision-slot" aria-live="polite"></div>
    <section class="card timeline-card" aria-labelledby="tl-title">
      <div class="card-head"><h2 class="section-title" id="tl-title">Pipeline</h2><span class="tl-progress mono" id="tl-progress"></span></div>
      <ol class="timeline" id="timeline">${r.stages.map((s) => html`<li class="stage" data-key="${s.key}"></li>`)}</ol>
    </section>`;
  cur.applied.clear();
  cur.decisionSig = null;
  r.stages.forEach((s) => renderStage(s.key, false));
  renderHead();
  renderProgress();
  renderDecisionSlot(false);
  renderDoc();
}

function renderHead() {
  const c = cur, r = c.run, el = $('#run-head');
  if (!el) return;
  clearInterval(c.tick);
  const running = r.status === 'running';
  const cached = r.stages.find((s) => s.key === 'extract')?.data?.cached;
  const source = { sample: 'Sample', upload: 'Upload' }[r.source] || r.source;
  el.innerHTML = html`<header class="run-head">
    <div class="run-title">
      <h1 class="run-file mono" title="${r.filename}">${r.filename || 'Untitled document'}</h1>
      <span class="run-clock ${running ? 'live' : ''}">${running
        ? html`<span class="spin sm" aria-hidden="true"></span><span>Running</span><span class="mono" id="elapsed"></span>`
        : r.status === 'error' ? html`<span class="tone-text t-reject">Stopped</span>`
        : html`<span>Finished in</span><span class="mono">${dur(r.ms)}</span>`}</span>
    </div>
    <div class="run-meta">
      <span>Run <span class="mono">${r.id}</span></span><span aria-hidden="true">·</span>
      <span>started <span class="mono">${clock(r.created_at)}</span></span>
      ${source ? html`<span class="chip sm">${source}</span>` : ''}
      ${cached ? html`<span class="chip sm t-accent">Cached extraction</span>` : ''}
    </div>
  </header>`;
  if (running) {
    const t0 = Date.parse(r.created_at) || Date.now();
    const tick = () => { const e = document.getElementById('elapsed'); if (e) e.textContent = `${(Math.max(0, Date.now() - t0) / 1000).toFixed(1)} s`; };
    tick();
    c.tick = setInterval(tick, 100);
  }
}

function renderProgress() {
  const el = $('#tl-progress');
  if (!el) return;
  const st = cur.run.stages;
  const done = st.filter((s) => !['pending', 'running'].includes(s.status)).length;
  el.textContent = `${done} / ${st.length}`;
  el.title = `${done} of ${st.length} stages complete`;
}

const isOpen = (s) => (cur.manual.has(s.key) ? cur.manual.get(s.key) : ['running', 'warning', 'failed'].includes(s.status));

function renderStage(key, animate) {
  const c = cur;
  const li = $(`.stage[data-key="${CSS.escape(key)}"]`);
  const s = c.run.stages.find((x) => x.key === key);
  if (!li || !s) return;
  const open = isOpen(s) && s.status !== 'pending';
  const sig = JSON.stringify([s, open]);
  if (c.applied.get(key) === sig) return;
  const prevStatus = c.applied.get(key + ':status');
  const anim = animate && prevStatus !== undefined && prevStatus !== s.status ? 'enter' : '';
  c.applied.set(key, sig);
  c.applied.set(key + ':status', s.status);
  const hadFocus = li.contains(document.activeElement);
  const tone = STAGE_TONE[s.status] || 'neutral';
  const expandable = s.status !== 'pending';
  const summary = s.summary || (s.status === 'running' ? (key === 'extract' ? 'Gemini is reading the document…' : 'Running checks…') : DESC[key] || '');
  const showMs = s.ms != null && !['pending', 'running', 'skipped'].includes(s.status);
  li.className = `stage s-${s.status}${open ? ' open' : ''}`;
  li.innerHTML = html`<button type="button" class="stage-head" ${expandable ? '' : raw('disabled')} aria-expanded="${open ? 'true' : 'false'}" ${open ? raw(`aria-controls="sb-${esc(key)}"`) : ''}>
      <span class="stage-icon tone-text t-${tone}">${statusIcon(s.status)}</span>
      <span class="stage-main">
        <span class="stage-name">${s.label || key}</span>
        <span class="stage-summary ${anim}">${summary}</span>
      </span>
      <span class="stage-meta">
        <span class="stage-status ${s.status === 'passed' ? 'sr-only' : `tone-text t-${tone}`}">${STATUS_WORD[s.status] || s.status}</span>
        ${showMs ? html`<span class="stage-ms mono">${dur(s.ms)}</span>` : ''}
      </span>
      <span class="chev">${expandable ? icon('chev', 14) : ''}</span>
    </button>
    ${open ? html`<div class="stage-body ${anim}" id="sb-${key}">${stageBody(s)}</div>` : ''}`;
  if (hadFocus) li.querySelector('.stage-head')?.focus();
}

function stageBody(s) {
  const parts = [];
  if (s.status === 'running') parts.push(html`<div class="working" aria-hidden="true"><i></i><i></i><i></i></div>`);
  if (Array.isArray(s.checks) && s.checks.length) parts.push(checksList(s.checks));
  const renderer = { extract: extractBody, vendor: vendorBody, po_match: poBody, duplicate: dupBody }[s.key];
  if (renderer && s.data && typeof s.data === 'object') {
    try { parts.push(renderer(s.data)); } catch (e) { console.warn(`Couldn't render ${s.key} details`, e); }
  }
  if (!parts.length) parts.push(html`<p class="muted small">No details recorded for this stage.</p>`);
  return parts;
}

function checksList(checks) {
  // Reason codes as labels (decision stage) get a code chip with the detail beneath, instead of a narrow label column.
  return html`<ul class="checks">${checks.map((k) => { const isCode = /^[A-Z][A-Z0-9_]+$/.test(k.label || ''); return html`<li class="check${isCode ? ' is-code' : ''}">
    <span class="check-icon tone-text t-${CHECK_TONE[k.status] || 'neutral'}">${icon(CHECK_ICON[k.status] || 'info', 14, k.status)}</span>
    <span class="check-label">${isCode ? html`<span class="code">${k.label}</span>` : k.label}</span>
    <span class="check-detail">${k.detail ?? ''}</span>
  </li>`; })}</ul>`;
}

const runCurrency = () => cur.run.currency || cur.run.extraction?.currency || '';

function conf(c) {
  if (c == null || isNaN(c)) return html`<span class="muted">—</span>`;
  const v = Math.max(0, Math.min(1, +c));
  return html`<span class="conf ${v < LOW_CONF ? 'low' : ''}" title="${v < LOW_CONF ? 'Low confidence' : 'Confidence'}"><span class="meter"><i style="width:${(v * 100).toFixed(0)}%"></i></span><span class="mono">${v.toFixed(2)}</span></span>`;
}

function fieldValue(f) {
  if (f.value == null || f.value === '') return html`<span class="missing">Not on document</span>`;
  const v = typeof f.value === 'object' ? JSON.stringify(f.value) : String(f.value);
  return /name/i.test(f.key || '') ? v : html`<span class="mono">${v}</span>`;
}

function extractBody(d) {
  const out = [];
  const cur$ = runCurrency();
  const meta = [
    d.model && html`<span>Model <span class="mono">${d.model}</span></span>`,
    d.latencyMs != null && !d.cached && html`<span>Latency <span class="mono">${dur(d.latencyMs)}</span></span>`,
    d.cached && html`<span class="chip sm t-accent">Cached extraction</span>`,
  ].filter(Boolean);
  if (meta.length) out.push(html`<div class="meta-line">${meta}</div>`);
  if (Array.isArray(d.fields) && d.fields.length) {
    out.push(html`<h3 class="sub-title">Fields</h3><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Field</th><th>Value</th><th class="r">Confidence</th></tr></thead>
      <tbody>${d.fields.map((f) => html`<tr><td class="muted nowrap">${f.label || f.key}</td><td class="wrap-any">${fieldValue(f)}</td><td class="r">${conf(f.confidence)}</td></tr>`)}</tbody>
    </table></div>`);
  }
  if (Array.isArray(d.lineItems) && d.lineItems.length) {
    out.push(html`<h3 class="sub-title">Line items</h3><div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount${cur$ ? ` (${cur$})` : ''}</th></tr></thead>
      <tbody>${d.lineItems.map((l) => html`<tr>
        <td><span class="cell-desc">${l.description || '—'}</span>${l.item_code ? html`<span class="cell-code mono">${l.item_code}</span>` : ''}</td>
        <td class="num">${qty(l.quantity)}</td><td class="num">${num(l.unit_price, cur$)}</td><td class="num">${num(l.amount, cur$)}</td></tr>`)}</tbody>
    </table></div>`);
  }
  if (Array.isArray(d.notices) && d.notices.length) {
    out.push(html`<div class="callout t-review"><div class="callout-title">${icon('warning', 14)} Notices on document</div><ul>${d.notices.map((n) => html`<li>${n}</li>`)}</ul></div>`);
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
    out.push(html`<p class="kv-line">Matched <strong>${v.name || v.vendor_id}</strong> ${v.name && v.vendor_id ? html`<span class="mono muted">${v.vendor_id}</span>` : ''}${method ? ` by ${method}` : ''}
      ${v.status === 'blocked' ? html`<span class="chip sm t-reject">${icon('failed', 12)}Blocked</span>` : ''}</p>`);
  }
  const b = d.bank;
  if (b && (b.onFile || b.onInvoice)) {
    const f = b.onFile || {}, inv = b.onInvoice;
    const acct = (x) => x?.account ?? x?.account_number ?? x?.bank_account;
    const rout = (x) => x?.routing ?? x?.routing_code ?? x?.bank_routing;
    if (b.differs) {
      out.push(html`<div class="callout t-reject"><div class="callout-title">${icon('failed', 14)} Bank details differ from the vendor master</div>
        <p>Payment is blocked. Verify by calling the number on file${v.phone ? html` (<span class="mono">${v.phone}</span>)` : ''}, never a contact printed on the invoice.</p></div>`);
    }
    out.push(html`<h3 class="sub-title">Bank details</h3><div class="tbl-wrap"><table class="tbl bank ${b.differs ? 'differs' : ''}">
      <thead><tr><th><span class="sr-only">Source</span></th><th>Bank</th><th>Routing</th><th>Account</th></tr></thead>
      <tbody>
        <tr><th scope="row">On file</th><td>${f.bank_name || '—'}</td><td class="mono">${rout(f) || '—'}</td><td class="mono">${acct(f) || '—'}</td></tr>
        <tr class="${b.differs ? 'diff-row' : ''}"><th scope="row">On invoice</th>${inv
          ? html`<td>${inv.bank_name && f.bank_name && inv.bank_name !== f.bank_name ? html`<mark>${inv.bank_name}</mark>` : inv.bank_name || '—'}</td>
             <td class="mono">${diffMark(rout(f), rout(inv))}</td><td class="mono">${diffMark(acct(f), acct(inv))}</td>`
          : html`<td colspan="3" class="muted">Not shown on the invoice</td>`}</tr>
      </tbody></table></div>`);
  }
  return out;
}

function poBody(d) {
  const out = [];
  const cur$ = runCurrency();
  if (d.po_number) {
    out.push(html`<div class="po-head"><span class="mono strong">${d.po_number}</span>
      ${d.inferred ? html`<span class="chip sm t-accent">Inferred${d.score != null ? html` · <span class="mono">${(+d.score).toFixed(2)}</span>` : ''}</span>` : ''}
      ${d.matchType ? html`<span class="chip sm">${d.matchType} match</span>` : ''}</div>`);
  }
  if (Array.isArray(d.candidates) && d.candidates.length > 1) {
    out.push(html`<h3 class="sub-title">Candidates</h3><ul class="cands">${d.candidates.map((x) => html`<li class="${x.po_number === d.po_number ? 'chosen' : ''}">
      <span class="mono">${x.po_number}</span><span class="meter"><i style="width:${Math.max(0, Math.min(1, +x.score || 0)) * 100}%"></i></span>
      <span class="mono">${x.score != null ? (+x.score).toFixed(2) : '—'}</span><span class="cand-tag">${x.po_number === d.po_number ? 'Chosen' : ''}</span></li>`)}</ul>`);
  }
  if (Array.isArray(d.lines) && d.lines.length) {
    out.push(html`<h3 class="sub-title">Line match</h3><div class="tbl-wrap"><table class="tbl lines">
      <thead><tr><th class="r">Billed</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Prev. invoiced</th><th class="r">Unit price</th><th class="r">PO price</th><th class="r">Var.</th></tr></thead>
      ${d.lines.map((l) => lineRow(l, d, cur$))}</table></div>
      ${cur$ ? html`<p class="table-note">Prices in ${cur$}. ${d.matchType === '2-way' ? 'Services: 2-way match, no goods receipt needed.' : 'Goods: 3-way match against receipts.'}</p>` : ''}`);
  }
  return out;
}

function lineRow(l, d, cur$) {
  const prev = +l.prevInvoiced || 0;
  const overReceipt = l.received != null && l.billedQty > l.received - prev;
  const overPo = l.ordered != null && l.billedQty > l.ordered - prev;
  const bad = l.status === 'fail' ? 'fail' : l.status === 'warn' ? 'warn' : '';
  const qtyTone = overReceipt || overPo ? 'fail' : '';
  const priceTone = bad && !qtyTone && l.variancePct ? bad : '';
  const notOnPo = l.ordered == null && l.poUnitPrice == null;
  const rowTone = bad && !qtyTone && !priceTone ? bad : '';
  // Each line is two rows (item, then numbers) so eight columns fit the narrow run column.
  return html`<tbody class="li ${bad ? 'row-' + bad : ''}"><tr class="li-item"><td colspan="7" class="${rowTone ? 'cell-' + rowTone : ''}">
      <span class="li-desc">${l.description || '—'}</span>${notOnPo ? html`<span class="cell-tag">Not on PO</span>` : l.item_code ? html`<span class="li-code mono">${l.item_code}</span>` : ''}</td></tr>
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
  return html`<p class="kv-line"><a class="link" href="#/run/${encodeURIComponent(d.originalRunId)}">See original run${d.invoiceNumber ? html` · <span class="mono">${d.invoiceNumber}</span>` : ''} ${icon('arrowRight', 14)}</a></p>`;
}

// ---------------------------------------------------------------- decision card
function renderDecisionSlot(animate = true) {
  const c = cur, r = c.run, slot = $('#decision-slot');
  if (!slot) return;
  const ds = r.stages.find((s) => s.key === 'decision');
  const res = r.result?.decision ? r.result : ds?.data?.decision ? ds.data : null;
  const kind = r.status === 'error' ? 'error' : res ? 'card' : 'pending';
  const sig = JSON.stringify([kind, kind === 'card' ? [res, r.review] : kind === 'error' ? r.error : 0]);
  if (sig === c.decisionSig) return;
  c.decisionSig = sig;
  if (kind === 'error') {
    const failed = r.stages.find((s) => s.status === 'failed');
    slot.innerHTML = html`<div class="decision t-reject ${animate ? 'enter' : ''}"><div class="decision-top">
      <div class="decision-word">Stopped</div>
      <p class="headline">This run couldn't finish.</p>
      <p class="explanation">${r.error || failed?.summary || 'Something went wrong while processing this file.'} Try running it again, or tick “Re-extract” to skip the cache.</p></div></div>`;
  } else if (kind === 'pending') {
    slot.innerHTML = html`<div class="decision-pending"><span class="pending-dot" aria-hidden="true"></span><span><strong>Decision pending.</strong> It appears here once every check has run.</span></div>`;
  } else {
    slot.innerHTML = decisionCard(r, res, animate);
  }
}

function decisionCard(r, res, animate) {
  const d = DECISION[res.decision] || { sub: '', tone: 'neutral' };
  const reasons = Array.isArray(res.reasons) ? res.reasons : [];
  const holds = reasons.filter((x) => x.severity !== 'info').sort((a, b) => (b.severity === 'block') - (a.severity === 'block'));
  const notes = reasons.filter((x) => x.severity === 'info');
  const actions = Array.isArray(res.nextActions) ? res.nextActions : [];
  const p = res.payment;
  const email = res.vendorEmail;
  const reasonRow = (x) => {
    const sv = SEVERITY[x.severity] || SEVERITY.info;
    return html`<li class="reason"><span class="tone-text t-${sv.tone}">${icon(sv.icon, 14, sv.label)}</span><span><span class="code">${x.code}</span> ${x.message || ''}</span></li>`;
  };
  const body = [
    holds.length && html`<h3 class="mini-title">Reasons</h3><ul class="reasons">${holds.map(reasonRow)}</ul>`,
    notes.length && html`<h3 class="mini-title">Notes</h3><ul class="reasons notes">${notes.map(reasonRow)}</ul>`,
    actions.length && html`<h3 class="mini-title">Next actions</h3><ul class="actions">${actions.map((a) => html`<li><label><input type="checkbox"><span>${a}</span></label></li>`)}</ul>`,
    email && emailBlock(email),
    res.decision === 'REVIEW' && reviewBox(r),
  ].filter(Boolean);
  return html`<article class="decision t-${d.tone} ${animate ? 'enter' : ''}" aria-label="Decision: ${d.sub || res.decision}">
    <div class="decision-top">
      <div class="decision-row">
        <div class="decision-id"><span class="tone-text">${icon(d.icon || 'info', 22)}</span><span><span class="decision-word tone-text">${res.decision}</span><span class="decision-sub">${d.sub}</span></span></div>
        ${res.route ? html`<div class="route"><span class="route-label">Routed to</span><strong>${res.route}</strong></div>` : ''}
      </div>
      ${res.headline ? html`<p class="headline">${res.headline}</p>` : ''}
      ${res.explanation ? html`<p class="explanation">${res.explanation}</p>` : ''}
      ${p && p.amount != null ? html`<p class="payment"><span class="payment-label">Scheduled</span><span class="mono strong">${money(p.amount, p.currency)}</span>${p.scheduledFor ? html`<span>on ${day(p.scheduledFor)}</span>` : ''}</p>` : ''}
    </div>
    ${body.length ? html`<div class="decision-body">${body}</div>` : ''}
  </article>`;
}

function emailBlock(e) {
  const text = `To: ${e.to || ''}\nSubject: ${e.subject || ''}\n\n${e.body || ''}`;
  return html`<details class="email">
    <summary><span class="chev">${icon('chev', 14)}</span><span class="email-title">Draft email · not sent</span>${e.to ? html`<span class="email-to mono">${e.to}</span>` : ''}</summary>
    <div class="email-box">
      <dl class="email-meta"><dt>To</dt><dd class="mono">${e.to || '—'}</dd><dt>Subject</dt><dd>${e.subject || '—'}</dd></dl>
      <pre class="email-text">${e.body || ''}</pre>
      <div class="email-tools"><span class="muted small">Nothing is sent from here.</span>${copyButton(text)}</div>
    </div>
  </details>`;
}

function reviewBox(r) {
  const rv = r.review;
  if (rv) {
    const ok = rv.action === 'approve';
    return html`<div class="reviewed t-${ok ? 'approve' : 'reject'}"><span class="tone-text">${icon(ok ? 'passed' : 'failed', 16)}</span>
      <span><strong>${ok ? 'Approved by reviewer' : 'Rejected by reviewer'}</strong> <span class="muted mono">${clock(rv.at)}</span>
      ${rv.note ? html`<span class="reviewed-note">“${rv.note}”</span>` : ''}</span></div>`;
  }
  return html`<div class="review-box">
    <h3 class="mini-title">Human review</h3>
    <label class="field-label" for="review-note">Note for the audit trail</label>
    <textarea id="review-note" rows="2" placeholder="What did you check? For example: called the vendor on the number on file."></textarea>
    <div class="review-actions">
      <button type="button" class="btn approve" data-review="approve">${icon('check', 14)}Approve anyway</button>
      <button type="button" class="btn reject" data-review="reject">Reject</button>
    </div>
    <p class="form-error" id="review-error" role="alert"></p>
  </div>`;
}

async function submitReview(action, btn) {
  const c = cur;
  const note = $('#review-note')?.value.trim() || '';
  const err = $('#review-error');
  root.querySelectorAll('[data-review]').forEach((b) => { b.disabled = true; });
  btn.classList.add('busy');
  try {
    await api(`/api/runs/${encodeURIComponent(c.id)}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note }) });
    const run = await api(`/api/runs/${encodeURIComponent(c.id)}`);
    if (c !== cur) return;
    c.run.review = run.review || { action, note, at: new Date().toISOString() };
    renderDecisionSlot(true);
    runsChanged();
  } catch (e) {
    if (err) err.textContent = `Couldn't save the review: ${e.message}`;
    root.querySelectorAll('[data-review]').forEach((b) => { b.disabled = false; });
    btn.classList.remove('busy');
  }
}

// ---------------------------------------------------------------- document column
function renderDoc() {
  const c = cur, r = c.run, id = encodeURIComponent(c.id);
  const isImg = /^image\//.test(r.mime || '') || /\.(png|jpe?g)$/i.test(r.filename || '');
  const tab = (k, label) => html`<button type="button" role="tab" id="tab-${k}" data-doctab="${k}" aria-controls="pane-${k}" aria-selected="${c.docTab === k ? 'true' : 'false'}" tabindex="${c.docTab === k ? '0' : '-1'}">${label}</button>`;
  $('#doc-col').innerHTML = html`${switcher('doc')}<div class="card doc-card">
    <div class="doc-tabs"><div role="tablist" aria-label="Document view" class="tabs">${tab('doc', 'Document')}${tab('json', 'Extracted JSON')}</div>
      <a class="link small doc-open" href="/api/runs/${id}/file" target="_blank" rel="noopener">Open ${icon('external', 13)}</a></div>
    <div class="doc-pane" id="pane-doc" role="tabpanel" aria-labelledby="tab-doc" ${c.docTab === 'doc' ? '' : raw('hidden')}>
      ${isImg ? html`<img src="/api/runs/${id}/file" alt="Invoice ${r.filename || ''}">` : html`<iframe src="/api/runs/${id}/file#toolbar=0&navpanes=0&view=FitH" title="Invoice ${r.filename || ''}"></iframe>`}
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
  if (!x) { pane.innerHTML = html`<p class="muted pad">The extracted fields appear here once the read stage finishes.</p>`; return; }
  const text = JSON.stringify(x, null, 2);
  pane.innerHTML = html`<div class="json-tools"><span class="muted small">What the model read, exactly as stored</span>${copyButton(text)}</div><pre class="json">${highlightJson(text)}</pre>`;
}

// ---------------------------------------------------------------- events
function onRunClick(e) {
  const t = e.target;
  const head = t.closest('.stage-head');
  if (head) {
    const key = head.closest('.stage').dataset.key;
    const s = cur?.run.stages.find((x) => x.key === key);
    if (s) { cur.manual.set(key, !isOpen(s)); renderStage(key, false); }
    return;
  }
  const rv = t.closest('[data-review]');
  if (rv) return submitReview(rv.dataset.review, rv);
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
  $('#run-col').innerHTML = html`<div class="empty-run"><h1 class="page-title">${e.status === 404 ? 'This run no longer exists' : "Couldn't open this run"}</h1>
    <p class="lede">${e.status === 404 ? 'It may have been cleared by Reset demo.' : e.message}</p>
    <p><a class="btn" href="#/runs">Go to runs</a></p></div>`;
}
