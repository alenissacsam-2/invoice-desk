// Procurement data: POs (expandable lines), vendors, goods receipts, ledger, and the matching policy form.
import { api, html, raw, money, num, qty, day, icon, pen } from './util.js';

const SECTIONS = [['pos', 'Purchase orders'], ['vendors', 'Vendors'], ['receipts', 'Goods receipts'], ['ledger', 'Ledger']];
const LEDGER = { approved: ['approve', 'Approved'], on_hold: ['review', 'On hold'], rejected: ['reject', 'Rejected'], superseded: ['neutral', 'Superseded'] };

let root = null;
const openPos = new Set();
let showSetAside = false; // ledger rows of replaced runs (status superseded) stay hidden unless asked for
let spy = null; // scrollspy observer
let ledgerCtx = null; // { ledger, vName } for redrawing the ledger on toggle
const liveRow = (l) => l.status !== 'superseded';

export async function mountData(main) {
  root = main;
  root.innerHTML = html`<div class="page"><p class="loading muted"><span class="caret" aria-hidden="true"></span> Pulling the procurement files…</p></div>`;
  let d;
  try { d = await api('/api/data'); } catch (e) {
    root.innerHTML = html`<div class="page"><div class="notice t-reject"><p class="notice-title">${pen('fail', 18)}Couldn't load the procurement data</p><p>${e.message}</p></div></div>`;
    return;
  }
  if (root !== main) return;
  render(d || {});
  root.onclick = (e) => {
    const t = e.target.closest('[data-po]');
    if (t) { togglePo(t); return; }
    const pl = e.target.closest('[data-po-link]');
    if (pl) { e.preventDefault(); gotoPo(pl.dataset.poLink); return; }
    const sa = e.target.closest('[data-setaside]');
    if (sa) { showSetAside = !showSetAside; sa.textContent = setAsideLabel(); root.querySelector('#ledger-rows').innerHTML = ledgerRows(); return; }
    const s = e.target.closest('[data-scroll]');
    if (s) { e.preventDefault(); const el = document.getElementById(`sec-${s.dataset.scroll}`); el?.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); el?.focus({ preventScroll: true }); }
  };
  startSpy();
}
export function unmountData() { if (root) root.onclick = null; root = null; spy?.disconnect(); spy = null; }

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const poId = (po) => String(po).replace(/[^\w-]/g, '');

function togglePo(t, force) {
  const po = t.dataset.po, open = force ?? !openPos.has(po);
  open ? openPos.add(po) : openPos.delete(po);
  t.setAttribute('aria-expanded', open);
  document.getElementById(t.getAttribute('aria-controls')).hidden = !open;
}

/** Ledger PO cell → scroll to the PO row, open its lines, flash it. */
function gotoPo(po) {
  const row = document.getElementById(`porow-${poId(po)}`);
  if (!row) return;
  togglePo(row.querySelector('[data-po]'), true);
  row.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'center' });
  row.classList.add('row-flash');
  setTimeout(() => row.classList.remove('row-flash'), 1800);
}

/** Marks the "On this page" link of the section under the top of the viewport. */
function startSpy() {
  const links = [...root.querySelectorAll('.toc [data-scroll]')];
  const cur = (k) => links.forEach((a) => (a.dataset.scroll === k ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
  cur(SECTIONS[0][0]);
  if (!('IntersectionObserver' in window)) return;
  spy = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && cur(e.target.id.slice(4))), { rootMargin: '-15% 0px -70% 0px' });
  SECTIONS.forEach(([k]) => { const el = document.getElementById(`sec-${k}`); el && spy.observe(el); });
}

const arr = (x) => (Array.isArray(x) ? x : []);

function render(d) {
  const vendors = arr(d.vendors), pos = arr(d.pos), receipts = arr(d.receipts), ledger = arr(d.ledger);
  const vName = Object.fromEntries(vendors.map((v) => [v.vendor_id, v.name]));
  const live = ledger.filter(liveRow);
  const counts = { pos: pos.length, vendors: vendors.length, receipts: new Set(receipts.map((g) => g.grn_number)).size, ledger: live.length };
  const section = (key, title, body) => html`<section class="sheet data-section" id="sec-${key}" tabindex="-1" aria-labelledby="h-${key}">
    <div class="sheet-head"><h2 class="sheet-title" id="h-${key}">${title}</h2><span class="count">${counts[key]}</span></div>${body}</section>`;
  root.innerHTML = html`<div class="page data-page">
    <header class="page-head"><div><h1 class="page-title">Procurement data</h1>
      <p class="page-sub">The procurement spreadsheet, loaded from <code>data/*.csv</code> on boot. The ledger fills in as invoices are approved or held.</p></div></header>
    <div class="data-grid">
      <div class="data-main">
        ${section('pos', 'Purchase orders', poTable(pos, vName, d.policy, live))}
        ${section('vendors', 'Vendors', vendorTable(vendors, live))}
        ${section('receipts', 'Goods receipts', receiptTable(receipts, pos))}
        ${section('ledger', 'Ledger', ledgerTable(ledger, vName))}
        <details class="policy-fold"><summary>Matching policy</summary>${policyCard(d.policy, 'policy-title-m')}</details>
      </div>
      <aside class="data-aside">
        <nav class="toc" aria-labelledby="toc-title"><h2 class="form-h" id="toc-title">On this page</h2>
          <ul>${SECTIONS.map(([k, t]) => html`<li><a href="#/data" data-scroll="${k}">${t}<span class="count">${counts[k]}</span></a></li>`)}</ul></nav>
        <div class="policy-rail">${policyCard(d.policy)}</div>
      </aside>
    </div>
  </div>`;
}

const wrap = (inner) => html`<div class="tbl-wrap">${inner}</div>`;
const none = (cols, text) => html`<tr><td colspan="${cols}" class="muted pad-cell">${text}</td></tr>`;

/** Over-invoiced within the header tolerance is violet (the invoice was allowed), beyond it vermilion. */
function overTone(p, policy) {
  const total = +p.net_total || 0, over = (+p.invoiced || 0) - total;
  if (over <= 0.005) return '';
  const a = policy?.headerAbs, abs = a == null ? null : typeof a === 'object' ? a[p.currency] ?? a.default : a;
  const within = policy?.headerPct != null && over <= total * policy.headerPct / 100 + 0.005 && (abs == null || over <= abs + 0.005);
  return within ? 'warn' : 'fail';
}

function poTable(pos, vName, policy, live) {
  return wrap(html`<table class="tbl po-tbl stack">
    <thead><tr><th>PO</th><th>Vendor</th><th>Status</th><th>Type</th><th>Requester</th><th class="r">Net total</th><th class="r">Invoiced</th><th class="r">Remaining</th><th class="bar-col">Invoiced share</th></tr></thead>
    <tbody>${pos.length ? pos.map((p) => {
      const total = +p.net_total || 0, inv = +p.invoiced || 0, rem = +(p.remaining ?? total - inv);
      const share = total ? inv / total : 0;
      const tone = overTone(p, policy);
      const open = openPos.has(p.po_number);
      const id = `pol-${poId(p.po_number)}`;
      const mine = live.filter((l) => l.po_number === p.po_number);
      const split = mine.length >= 2;
      const sum = (st) => mine.filter((l) => l.status === st).reduce((a, l) => a + (+l.net || 0), 0);
      const ap = sum('approved'), hold = sum('on_hold');
      const pct = (x) => (total ? Math.min(100, x / total * 100) : 0);
      const tip = `Approved ${money(ap, p.currency)}, on hold ${money(hold, p.currency)}, of ${money(total, p.currency)}`;
      const bar = split
        ? html`<span class="ink-bar wide split" title="${tip}"><i class="seg-a" style="width:${pct(ap)}%"></i><i class="seg-h" style="width:${pct(hold)}%"></i></span><span class="sr-only">${tip}</span>`
        : html`<span class="ink-bar wide ${tone ? 'over ' + tone : ''} ${rem < -0.005 ? 'tick' : ''}" title="${Math.round(share * 100)}% invoiced"><i style="width:${Math.min(1, share) * 100}%"></i></span><span class="sr-only">${Math.round(share * 100)}% invoiced</span>`;
      return html`<tr id="porow-${poId(p.po_number)}">
        <td class="nowrap no-label"><button type="button" class="row-toggle" data-po="${p.po_number}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${id}"><span class="chev">${icon('chev', 16)}</span>${p.po_number}</button>${split ? html` <span class="split-tag">Split · ${mine.length} invoices</span>` : ''}</td>
        <td data-label="Vendor">${vName[p.vendor_id] || p.vendor_id}<span class="cell-file">${p.vendor_id}${p.buyer_entity && /india/i.test(p.buyer_entity) ? ` · ${p.buyer_entity}` : ''}</span></td>
        <td data-label="Status" class="nowrap">${p.status === 'closed' ? html`<span class="mini-stamp t-neutral">Closed</span>` : html`<span class="muted">Open</span>`}</td>
        <td data-label="Type" class="nowrap">${p.category === 'services' ? html`<span class="ftab">Services · 2-way</span>` : html`<span class="ftab tab-sky">Goods · 3-way</span>`}</td>
        <td data-label="Requester" class="nowrap">${p.requester || '—'}</td>
        <td data-label="Net total" class="num">${money(p.net_total, p.currency)}</td>
        <td data-label="Invoiced" class="num">${money(p.invoiced ?? 0, p.currency)}</td>
        <td data-label="Remaining" class="num ${tone ? 'cell-' + tone : ''}" ${tone === 'warn' ? raw('title="Over the PO, within the header tolerance"') : ''}>${money(rem, p.currency)}${rem < -0.005 && total ? html`<span class="over-note">+${num(-rem / total * 100, null, 1)}% over</span>` : ''}</td>
        <td data-label="Invoiced share" class="bar-col">${bar}</td>
      </tr>
      <tr class="sub-row" id="${id}" ${open ? '' : 'hidden'}><td colspan="9"><table class="tbl inner stack">
        <thead><tr><th>Line</th><th>Item code</th><th>Description</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Invoiced</th><th class="r">Unit price</th></tr></thead>
        <tbody>${arr(p.lines).map((l) => html`<tr><td data-label="Line" class="muted">${l.line_no}</td><td data-label="Item code">${l.item_code || '—'}</td><td data-label="Description">${l.description}</td>
          <td data-label="Ordered" class="num">${qty(l.qty)}</td><td data-label="Received" class="num" ${l.received == null ? raw('title="Services: no goods receipt"') : ''}>${qty(l.received)}</td>
          <td data-label="Invoiced" class="num ${l.received != null && l.invoiced_qty > l.received ? 'cell-fail' : ''}">${qty(l.invoiced_qty ?? 0)}</td><td data-label="Unit price" class="num">${money(l.unit_price, p.currency)}</td></tr>`)}</tbody>
      </table></td></tr>`;
    }) : none(9, 'No purchase orders loaded.')}</tbody></table>`);
}

const mask = (acct) => (acct ? `•••• ${String(acct).slice(-4)}` : '—');

function vendorTable(vendors, live) {
  return wrap(html`<table class="tbl stack">
    <thead><tr><th>ID</th><th>Name</th><th>Tax ID</th><th>Country</th><th>Bank</th><th>Remit email</th><th>Terms</th><th>Status</th></tr></thead>
    <tbody>${vendors.length ? vendors.map((v) => {
      const blocked = v.status === 'blocked';
      const held = live.filter((l) => l.vendor_id === v.vendor_id && l.status === 'on_hold');
      return html`<tr class="${blocked ? 'v-blocked' : ''}">
      <td data-label="ID" class="muted">${v.vendor_id}</td>
      <td data-label="Name">${v.name}${blocked ? html`<span class="cell-file blocked-note">Blocked: no invoice from this vendor can be paid</span>` : ''}${held.length ? html`<a class="hold-note" href="#/run/${encodeURIComponent(held[0].run_id)}">${held.length} on hold</a>` : ''}</td>
      <td data-label="Tax ID" class="nowrap">${v.tax_id || '—'}</td><td data-label="Country">${v.country || '—'}</td>
      <td data-label="Bank" class="nowrap">${v.bank_name || '—'}<span class="cell-file">${mask(v.bank_account)}${v.bank_routing ? ` · ${v.bank_routing}` : ''}</span></td>
      <td data-label="Remit email" class="small">${v.remit_email || '—'}</td>
      <td data-label="Terms" class="nowrap">${v.payment_terms_days != null ? `Net ${v.payment_terms_days}` : '—'}</td>
      <td data-label="Status">${blocked ? html`<span class="mini-stamp t-reject">Blocked</span>` : html`<span class="status-ok">Active</span>`}</td>
    </tr>`; }) : none(8, 'No vendors loaded.')}</tbody></table>`);
}

/** One header row per GRN (number, date, PO), then its lines. */
function receiptTable(receipts, pos) {
  const line = (po, n) => arr(pos.find((p) => p.po_number === po)?.lines).find((l) => +l.line_no === +n);
  const groups = new Map();
  receipts.forEach((g) => (groups.get(g.grn_number) || groups.set(g.grn_number, []).get(g.grn_number)).push(g));
  return wrap(html`<table class="tbl grn-tbl stack">
    <thead><tr><th class="r">Line</th><th>Item</th><th class="r">Qty received</th></tr></thead>
    <tbody>${groups.size ? [...groups.values()].map((gs) => html`<tr class="grn-head"><td colspan="3"><span class="nowrap">${gs[0].grn_number}</span> · ${day(gs[0].received_date)} · <span class="nowrap">${gs[0].po_number}</span></td></tr>
      ${gs.map((g) => { const l = line(g.po_number, g.line_no); return html`<tr>
        <td data-label="Line" class="num muted">${g.line_no}</td>
        <td data-label="Item">${l?.description || '—'}${l?.item_code ? html`<span class="cell-file">${l.item_code}</span>` : ''}</td>
        <td data-label="Qty received" class="num">${qty(g.qty_received)}</td></tr>`; })}`) : none(3, 'No goods receipts loaded.')}</tbody></table>`);
}

const setAsideLabel = () => {
  const n = ledgerCtx.ledger.filter((l) => !liveRow(l)).length;
  return showSetAside ? 'Hide set-aside rows' : `Show ${n} set-aside ${n === 1 ? 'row' : 'rows'}`;
};

function ledgerTable(ledger, vName) {
  ledgerCtx = { ledger, vName };
  const setAside = ledger.some((l) => !liveRow(l));
  return html`${wrap(html`<table class="tbl stack">
    <thead><tr><th>Invoice no.</th><th>Vendor</th><th>PO</th><th class="r">Net</th><th class="r">Total</th><th>Status</th><th><span class="sr-only">Run</span></th></tr></thead>
    <tbody id="ledger-rows">${ledgerRows()}</tbody></table>`)}
    ${setAside ? html`<p class="table-note"><button type="button" class="link small" data-setaside>${setAsideLabel()}</button></p>` : ''}`;
}

function ledgerRows() {
  const { vName } = ledgerCtx;
  const ledger = showSetAside ? ledgerCtx.ledger : ledgerCtx.ledger.filter(liveRow);
  return html`${ledger.length ? ledger.map((l) => { const [tone, label] = LEDGER[l.status] || ['neutral', l.status]; return html`<tr>
      <td data-label="Invoice no." class="nowrap">${l.invoice_number || html`<span class="muted">No number</span>`}</td>
      <td data-label="Vendor">${l.vendor_name || vName[l.vendor_id] || l.vendor_id}</td>
      <td data-label="PO" class="nowrap">${l.po_number ? html`<a class="link" href="#/data" data-po-link="${l.po_number}">${l.po_number}</a>` : '—'}</td>
      <td data-label="Net" class="num">${money(l.net, l.currency)}</td><td data-label="Total" class="num">${money(l.total, l.currency)}</td>
      <td data-label="Status"><span class="mini-stamp t-${tone}">${label}</span></td>
      <td class="r no-label">${l.run_id ? html`<a class="link small nowrap" href="#/run/${encodeURIComponent(l.run_id)}">See the slip ${icon('arrowRight', 16)}</a>` : ''}</td></tr>`; })
      : none(7, 'No ledger entries yet. Approved and held invoices are entered here.')}`;
}

/** headerAbs is {USD:100, INR:8000, default:100} (v2) or a plain number (v1) → "at most $100 (₹8,000 for INR)". */
function absLimit(a) {
  if (a == null) return '';
  if (typeof a !== 'object') return ` and at most ${num(a, null, 0)}`;
  const base = a.USD ?? a.default;
  const others = Object.entries(a).filter(([c, v]) => c !== 'USD' && c !== 'default' && v != null);
  const extra = others.map(([c, v]) => `${money(v, c, 0)} for ${c}`).join(', ');
  return base == null ? (extra ? ` and at most ${extra}` : '') : ` and at most ${money(base, 'USD', 0)}${extra ? ` (${extra})` : ''}`;
}

/** The matching policy as a pre-printed form: each rule a boxed field with its typed limit. */
export function policyCard(p, titleId = 'policy-title') {
  if (!p || typeof p !== 'object') return '';
  const has = (k) => p[k] != null;
  const rows = [
    has('unitPricePct') && ['Unit price variance', `±${p.unitPricePct}%`, 'per line vs PO price'],
    has('headerPct') && ['Header variance', `±${p.headerPct}%${absLimit(p.headerAbs)}`, 'net vs PO, in PO currency; both must hold'],
    ['Quantity over receipt', String(p.qtyOverReceipt ?? p.qtyTolerance ?? 0), 'goods: billed ≤ received − already invoiced'],
    has('arithAbs') && ['Arithmetic rounding', `±${num(p.arithAbs)}`, 'lines, tax and total must add up within this'],
    has('poInferMin') && ['PO inference', `≥ ${num(p.poInferMin)}`, has('poAmbiguityMargin') ? `match score; the runner-up must trail by ${num(p.poAmbiguityMargin)}` : 'match score'],
    has('lowConfidence') && ['Low confidence', `< ${num(p.lowConfidence)}`, 'on key extracted fields'],
    has('maxAgeDays') && ['Invoice age', `≤ ${p.maxAgeDays} days`, 'older, or dated in the future, is held'],
    has('dupWindowDays') && ['Duplicate window', `${p.dupWindowDays} days`, 'same vendor and amount, different number'],
  ].filter(Boolean);
  // Long limits take a full-width box first; an odd box left over at the end takes the full width too.
  const wide = rows.filter(([, v]) => v.length > 14), short = rows.filter(([, v]) => v.length <= 14);
  const ordered = [...wide.map((x) => [...x, true]), ...short.map((x, i) => [...x, i === short.length - 1 && short.length % 2 === 1])];
  return html`<section class="sheet policy" aria-labelledby="${titleId}">
    <div class="sheet-head"><h2 class="sheet-title" id="${titleId}">Matching policy</h2></div>
    <dl class="policy-form">${ordered.map(([k, v, note, full]) => html`<div class="pf-row${full ? ' wide' : ''}"><dt class="fl">${k}</dt><dd class="typed">${v}</dd><dd class="pf-note">${note}</dd></div>`)}</dl>
    <p class="policy-foot">Set in <code>src/config.js</code>. The rules read these limits; the model never does.</p>
  </section>`;
}
