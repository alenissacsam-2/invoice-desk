// Procurement data: POs (expandable lines), vendors, goods receipts, ledger, and the matching policy form.
import { api, html, raw, money, num, qty, day, icon, pen } from './util.js';

const SECTIONS = [['pos', 'Purchase orders'], ['vendors', 'Vendors'], ['receipts', 'Goods receipts'], ['ledger', 'Ledger']];
const LEDGER = { approved: ['approve', 'Approved'], on_hold: ['review', 'On hold'], rejected: ['reject', 'Rejected'], superseded: ['neutral', 'Superseded'] };

let root = null;
const openPos = new Set();
let showSetAside = false; // ledger rows of replaced runs (status superseded) stay hidden unless asked for
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
    if (t) {
      const po = t.dataset.po, open = !openPos.has(po);
      open ? openPos.add(po) : openPos.delete(po);
      t.setAttribute('aria-expanded', open);
      document.getElementById(t.getAttribute('aria-controls')).hidden = !open;
      return;
    }
    const sa = e.target.closest('[data-setaside]');
    if (sa) { showSetAside = !showSetAside; sa.textContent = setAsideLabel(); root.querySelector('#ledger-rows').innerHTML = ledgerRows(); return; }
    const s = e.target.closest('[data-scroll]');
    if (s) { e.preventDefault(); const el = document.getElementById(`sec-${s.dataset.scroll}`); el?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); el?.focus({ preventScroll: true }); }
  };
}
export function unmountData() { if (root) root.onclick = null; root = null; }

const arr = (x) => (Array.isArray(x) ? x : []);

function render(d) {
  const vendors = arr(d.vendors), pos = arr(d.pos), receipts = arr(d.receipts), ledger = arr(d.ledger);
  const vName = Object.fromEntries(vendors.map((v) => [v.vendor_id, v.name]));
  const counts = { pos: pos.length, vendors: vendors.length, receipts: receipts.length, ledger: ledger.filter(liveRow).length };
  const section = (key, title, body) => html`<section class="sheet data-section" id="sec-${key}" tabindex="-1" aria-labelledby="h-${key}">
    <div class="sheet-head"><h2 class="sheet-title" id="h-${key}">${title}</h2><span class="count">${counts[key]}</span></div>${body}</section>`;
  root.innerHTML = html`<div class="page data-page">
    <header class="page-head"><div><h1 class="page-title">Procurement data</h1>
      <p class="page-sub">The procurement spreadsheet, loaded from <code>data/*.csv</code> on boot. The ledger fills in as invoices are approved or held.</p></div></header>
    <div class="data-grid">
      <div class="data-main">
        ${section('pos', 'Purchase orders', poTable(pos, vName, d.policy))}
        ${section('vendors', 'Vendors', vendorTable(vendors))}
        ${section('receipts', 'Goods receipts', receiptTable(receipts, pos))}
        ${section('ledger', 'Ledger', ledgerTable(ledger, vName))}
      </div>
      <aside class="data-aside">
        <nav class="toc" aria-labelledby="toc-title"><h2 class="form-h" id="toc-title">On this page</h2>
          <ul>${SECTIONS.map(([k, t]) => html`<li><a href="#/data" data-scroll="${k}">${t}<span class="muted">${counts[k]}</span></a></li>`)}</ul></nav>
        ${policyCard(d.policy)}
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

function poTable(pos, vName, policy) {
  return wrap(html`<table class="tbl po-tbl">
    <thead><tr><th>PO</th><th>Vendor</th><th>Type</th><th>Requester</th><th class="r">Net total</th><th class="r">Invoiced</th><th class="r">Remaining</th><th class="bar-col">Invoiced share</th></tr></thead>
    <tbody>${pos.length ? pos.map((p) => {
      const total = +p.net_total || 0, inv = +p.invoiced || 0;
      const share = total ? inv / total : 0;
      const tone = overTone(p, policy);
      const open = openPos.has(p.po_number);
      const id = `pol-${String(p.po_number).replace(/[^\w-]/g, '')}`;
      return html`<tr>
        <td class="nowrap"><button type="button" class="row-toggle" data-po="${p.po_number}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${id}"><span class="chev">${icon('chev', 16)}</span>${p.po_number}</button></td>
        <td>${vName[p.vendor_id] || p.vendor_id}<span class="cell-file">${p.vendor_id}${p.buyer_entity && /india/i.test(p.buyer_entity) ? ` · ${p.buyer_entity}` : ''}</span></td>
        <td class="nowrap">${p.category === 'services' ? html`<span class="ftab">Services · 2-way</span>` : html`<span class="ftab tab-sky">Goods · 3-way</span>`}</td>
        <td class="nowrap">${p.requester || '—'}</td>
        <td class="num">${money(p.net_total, p.currency)}</td>
        <td class="num">${money(p.invoiced ?? 0, p.currency)}</td>
        <td class="num ${tone ? 'cell-' + tone : ''}" ${tone === 'warn' ? raw('title="Over the PO, within the header tolerance"') : ''}>${money(p.remaining ?? total - inv, p.currency)}</td>
        <td class="bar-col"><span class="ink-bar wide ${tone ? 'over ' + tone : ''}" title="${Math.round(share * 100)}% invoiced"><i style="width:${Math.min(1, share) * 100}%"></i></span><span class="sr-only">${Math.round(share * 100)}% invoiced</span></td>
      </tr>
      <tr class="sub-row" id="${id}" ${open ? '' : 'hidden'}><td colspan="8"><table class="tbl inner">
        <thead><tr><th>Line</th><th>Item code</th><th>Description</th><th class="r">Ordered</th><th class="r">Received</th><th class="r">Invoiced</th><th class="r">Unit price</th></tr></thead>
        <tbody>${arr(p.lines).map((l) => html`<tr><td class="muted">${l.line_no}</td><td>${l.item_code || '—'}</td><td>${l.description}</td>
          <td class="num">${qty(l.qty)}</td><td class="num" ${l.received == null ? raw('title="Services: no goods receipt"') : ''}>${qty(l.received)}</td>
          <td class="num ${l.received != null && l.invoiced_qty > l.received ? 'cell-fail' : ''}">${qty(l.invoiced_qty ?? 0)}</td><td class="num">${money(l.unit_price, p.currency)}</td></tr>`)}</tbody>
      </table></td></tr>`;
    }) : none(8, 'No purchase orders loaded.')}</tbody></table>`);
}

const mask = (acct) => (acct ? `•••• ${String(acct).slice(-4)}` : '—');

function vendorTable(vendors) {
  return wrap(html`<table class="tbl">
    <thead><tr><th>ID</th><th>Name</th><th>Tax ID</th><th>Country</th><th>Bank</th><th>Remit email</th><th>Status</th></tr></thead>
    <tbody>${vendors.length ? vendors.map((v) => html`<tr>
      <td class="muted">${v.vendor_id}</td><td>${v.name}</td><td class="nowrap">${v.tax_id || '—'}</td><td>${v.country || '—'}</td>
      <td class="nowrap">${v.bank_name || '—'}<span class="cell-file">${mask(v.bank_account)}${v.bank_routing ? ` · ${v.bank_routing}` : ''}</span></td>
      <td class="small">${v.remit_email || '—'}</td>
      <td>${v.status === 'blocked' ? html`<span class="mini-stamp t-reject">Blocked</span>` : html`<span class="status-ok">Active</span>`}</td>
    </tr>`) : none(7, 'No vendors loaded.')}</tbody></table>`);
}

function receiptTable(receipts, pos) {
  const line = (po, n) => arr(pos.find((p) => p.po_number === po)?.lines).find((l) => +l.line_no === +n);
  return wrap(html`<table class="tbl">
    <thead><tr><th>GRN</th><th>PO</th><th class="r">Line</th><th>Item</th><th class="r">Qty received</th><th>Received</th></tr></thead>
    <tbody>${receipts.length ? receipts.map((g) => { const l = line(g.po_number, g.line_no); return html`<tr>
      <td>${g.grn_number}</td><td>${g.po_number}</td><td class="num muted">${g.line_no}</td>
      <td>${l?.description || '—'}${l?.item_code ? html`<span class="cell-file">${l.item_code}</span>` : ''}</td>
      <td class="num">${qty(g.qty_received)}</td><td class="nowrap">${day(g.received_date)}</td></tr>`; }) : none(6, 'No goods receipts loaded.')}</tbody></table>`);
}

const setAsideLabel = () => {
  const n = ledgerCtx.ledger.filter((l) => !liveRow(l)).length;
  return showSetAside ? 'Hide set-aside rows' : `Show ${n} set-aside ${n === 1 ? 'row' : 'rows'}`;
};

function ledgerTable(ledger, vName) {
  ledgerCtx = { ledger, vName };
  const setAside = ledger.some((l) => !liveRow(l));
  return html`${wrap(html`<table class="tbl">
    <thead><tr><th>Invoice no.</th><th>Vendor</th><th>PO</th><th class="r">Net</th><th class="r">Total</th><th>Status</th><th><span class="sr-only">Run</span></th></tr></thead>
    <tbody id="ledger-rows">${ledgerRows()}</tbody></table>`)}
    ${setAside ? html`<p class="table-note"><button type="button" class="link small" data-setaside>${setAsideLabel()}</button></p>` : ''}`;
}

function ledgerRows() {
  const { vName } = ledgerCtx;
  const ledger = showSetAside ? ledgerCtx.ledger : ledgerCtx.ledger.filter(liveRow);
  return html`${ledger.length ? ledger.map((l) => { const [tone, label] = LEDGER[l.status] || ['neutral', l.status]; return html`<tr>
      <td class="nowrap">${l.invoice_number || html`<span class="muted">No number</span>`}</td>
      <td>${l.vendor_name || vName[l.vendor_id] || l.vendor_id}</td><td class="nowrap">${l.po_number || '—'}</td>
      <td class="num">${money(l.net, l.currency)}</td><td class="num">${money(l.total, l.currency)}</td>
      <td><span class="mini-stamp t-${tone}">${label}</span></td>
      <td class="r">${l.run_id ? html`<a class="link small nowrap" href="#/run/${encodeURIComponent(l.run_id)}">See the slip ${icon('arrowRight', 16)}</a>` : ''}</td></tr>`; })
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
export function policyCard(p) {
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
  return html`<section class="sheet policy" aria-labelledby="policy-title">
    <div class="sheet-head"><h2 class="sheet-title" id="policy-title">Matching policy</h2></div>
    <dl class="policy-form">${ordered.map(([k, v, note, full]) => html`<div class="pf-row${full ? ' wide' : ''}"><dt class="fl">${k}</dt><dd class="typed">${v}</dd><dd class="pf-note">${note}</dd></div>`)}</dl>
    <p class="policy-foot">Set in <code>src/config.js</code>. The rules read these limits; the model never does.</p>
  </section>`;
}
