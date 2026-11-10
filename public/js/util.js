// Shared helpers: safe HTML templating, API calls, formatting, icons, stamps.

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const part = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));

/** Tagged template: interpolations are escaped unless they come from html`` or raw(). */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}

export async function api(path, opts = {}) {
  // Every write carries X-Demo: the server rejects POSTs without it (CSRF guard).
  if ((opts.method || 'GET').toUpperCase() !== 'GET') opts = { ...opts, headers: { ...opts.headers, 'X-Demo': '1' } };
  const res = await fetch(path, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error((body && body.error) || (typeof body === 'string' && body) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export const runsChanged = () => window.dispatchEvent(new Event('runs-changed'));
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- formatting ----
const nf = new Map();
const fmt = (locale, opts) => { const k = locale + JSON.stringify(opts); if (!nf.has(k)) nf.set(k, new Intl.NumberFormat(locale, opts)); return nf.get(k); };

export function money(n, cur, digits) {
  if (n == null || n === '' || isNaN(n)) return '—';
  if (!cur) return num(n, null, digits ?? 2);
  const o = digits == null ? {} : { minimumFractionDigits: digits, maximumFractionDigits: digits };
  try { return fmt(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, ...o }).format(n); } catch { return `${num(n, cur, digits ?? 2)} ${cur}`; }
}
/** Grouped number without currency symbol; Indian grouping for INR. */
export function num(n, cur, digits = 2) {
  if (n == null || n === '' || isNaN(n)) return '—';
  return fmt(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}
export const qty = (n) => (n == null || isNaN(n) ? '—' : Number.isInteger(+n) ? String(n) : num(n));
export const pct = (r) => (r == null || isNaN(r) ? '—' : `${Math.round(r * 100)}%`);
export const signedPct = (p) => (p == null || isNaN(p) ? '—' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`);

export function dur(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')} s`;
}
const valid = (iso) => iso && !isNaN(new Date(iso));
export const clock = (iso) => (valid(iso) ? new Date(iso).toLocaleTimeString('en-GB', { hour12: false }) : '—');
export const stamp = (iso) => (valid(iso) ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
/** 'YYYY-MM-DD' → '27 Nov 2026' without a timezone shift. */
export function day(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  if (!m) return ymd || '—';
  return new Date(Date.UTC(+m[1], m[2] - 1, +m[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/** Server prose: ISO dates → '15 Nov 2026', and '((510) 555-0142)' → '(510) 555-0142'. */
export const prose = (t) => (t == null ? '' : String(t)
  .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (m) => day(m))
  .replace(/\(\(([^()]*)\)([^()]*)\)/g, '($1)$2'));
/** ISO timestamp → '10 Nov 2026, 14:03'. */
export const when = (iso) => (valid(iso) ? `${day(new Date(iso).toISOString())}, ${new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');
export function ago(iso) {
  if (!valid(iso)) return '—';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return day(new Date(iso).toISOString());
}

// ---- domain vocabulary ----
// copy: the carbon copy an outcome lands on (white = AP file, canary = reviewer, pink = return to vendor).
export const DECISION = {
  APPROVE: { sub: 'Approved', word: 'Approved', tone: 'approve', copy: 'white' },
  REVIEW: { sub: 'On hold for review', word: 'On hold', tone: 'review', copy: 'canary' },
  REJECT: { sub: 'Rejected', word: 'Void', tone: 'reject', copy: 'pink' },
};
export const COPIES = [['white', 'White', 'AP file'], ['canary', 'Canary', 'Reviewer'], ['pink', 'Pink', 'Return to vendor']];
export const CHECK_TONE = { pass: 'approve', warn: 'review', fail: 'reject', info: 'neutral' };
export const SEVERITY = { block: { mark: 'fail', tone: 'reject', label: 'Blocks payment' }, hold: { mark: 'warn', tone: 'review', label: 'Hold' }, info: { mark: 'info', tone: 'neutral', label: 'Note' } };

const ACRONYM = { po: 'PO', id: 'ID', ai: 'AI', gst: 'GST', gstin: 'GSTIN' };
/** QTY_EXCEEDS_RECEIPT → 'Qty exceeds receipt' (fallback when the server sends no label). */
export const humanize = (code) => String(code || '').toLowerCase().split('_').filter(Boolean)
  .map((w, i) => ACRONYM[w] || (i ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
export const reasonLabel = (x) => (x ? x.label || humanize(x.code) || x.message || '' : '');
export const isCode = (s) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s || '');

/** The outcome that stands once a person decided: v2 `final` / `final_decision`, else v1 `review`. Null while nobody has. */
export function finalOf(r) {
  if (!r) return null;
  const rv = typeof r.review === 'string' ? { action: r.review } : r.review || null;
  const f = r.final && typeof r.final === 'object' ? r.final : null;
  const decision = f?.decision ?? r.final_decision ?? (rv ? (rv.action === 'approve' ? 'APPROVE' : 'REJECT') : null);
  if (!decision) return null;
  const by = f?.by ?? (rv || r.reviewer || r.decision === 'REVIEW' ? 'reviewer' : 'system');
  return { decision, by, reviewer: rv?.reviewer ?? r.reviewer ?? null, at: f?.at ?? rv?.at ?? null, payment: f?.payment ?? null, review: rv };
}

/** The stamp a run carries now: a person's decision on a held run replaces the system's hold. */
export function outcomeOf(r, decision = r?.decision) {
  const f = decision === 'REVIEW' ? finalOf(r) : null;
  if (f && f.by === 'reviewer' && DECISION[f.decision]) {
    const d = DECISION[f.decision];
    return { decision: f.decision, word: f.decision === 'APPROVE' ? 'Approved' : 'Rejected', sub: 'By reviewer', tone: d.tone, copy: d.copy, human: f };
  }
  const d = DECISION[decision];
  return d ? { decision, word: d.word, sub: null, tone: d.tone, copy: d.copy, human: null } : null;
}

/** Small inked stamp for registers and the in-tray. */
export function miniStamp(r, decision = r?.decision) {
  if (r?.status === 'running') return html`<span class="mark-running"><span class="caret" aria-hidden="true"></span>Processing</span>`;
  if (r?.status === 'error') return html`<span class="mark-error">Not finished</span>`;
  const o = outcomeOf(r || {}, decision);
  if (!o) return html`<span class="muted">—</span>`;
  return html`<span class="mini-stamp t-${o.tone}">${o.word}</span>`;
}

/** The sheet-corner swatch in the copy colour. */
export function copySwatch(copy) {
  const c = COPIES.find(([k]) => k === copy);
  return c ? html`<svg class="swatch sw-${copy}" width="14" height="18" viewBox="0 0 14 18" role="img" aria-label="${c[1]} copy, ${c[2]}"><path class="sw-sheet" d="M.75.75h8.5l4 4v12.5H.75z"/><path class="sw-fold" d="M9.25.75v4h4"/></svg>` : '';
}

// ---- icons: one line set, 20-unit grid, 1.5 stroke, round caps ----
const P = {
  // the seven stages
  tray: '<path d="M10 2.75v6.5M7.25 6.5 10 9.25l2.75-2.75"/><path d="M2.75 11.25h4.1l1.15 2h4l1.15-2h4.1M2.75 11.25v4.5c0 .69.56 1.25 1.25 1.25h12c.69 0 1.25-.56 1.25-1.25v-4.5l-2-4.5h-1.6M2.75 11.25l2-4.5h1.6"/>',
  read: '<path d="M8.75 17.25H5.25C4.56 17.25 4 16.69 4 16V4c0-.69.56-1.25 1.25-1.25h5.5L14 6v2.25"/><path d="M10.75 2.75V6H14M6.75 7.75h3M6.75 10.25h1.75"/><circle cx="13" cy="13.25" r="2.75"/><path d="m15 15.25 2.25 2.25"/>',
  sum: '<path d="M14.75 4.25V3.5h-9.5l5.25 6.5-5.25 6.5h9.5v-.75"/>',
  building: '<path d="M2.75 17.25h14.5M4.75 17.25V3.75c0-.55.45-1 1-1h5.5c.55 0 1 .45 1 1v13.5M12.25 7.75h3c.55 0 1 .45 1 1v8.5M7.25 6h2.5M7.25 9h2.5M7.25 12h2.5M14 11h.5M14 14h.5"/>',
  dupe: '<path d="M7.25 5.5V4c0-.69.56-1.25 1.25-1.25h7.25c.69 0 1.25.56 1.25 1.25v8.75c0 .69-.56 1.25-1.25 1.25h-1.5"/><rect x="3.25" y="5.75" width="10.5" height="11.5" rx="1.25"/><path d="M6 9.5h5M6 12.25h3.25"/>',
  link: '<rect x="2.75" y="2.75" width="6.5" height="8.5" rx="1"/><rect x="10.75" y="8.75" width="6.5" height="8.5" rx="1"/><path d="M6 11.25v2.25c0 .55.45 1 1 1h3.75M5 5.75h2M13 11.75h2M13 14.25h2"/>',
  stamp: '<circle cx="10" cy="4.75" r="2"/><path d="M8.85 6.6 8.5 9.25M11.15 6.6l.35 2.65M4.5 9.25h11c.41 0 .75.34.75.75v2.75H3.75V10c0-.41.34-.75.75-.75zM4 16.25h12"/>',
  // interface
  upload: '<path d="M10 12.75V3.5M6.5 7 10 3.5 13.5 7M3.5 12.25v3c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-3"/>',
  retry: '<path d="M3.75 10a6.25 6.25 0 1 0 1.9-4.5L3.75 7.4"/><path d="M3.75 3.5v3.9h3.9"/>',
  copy: '<rect x="7" y="7" width="9.75" height="9.75" rx="1.5"/><path d="M13 7V4.5c0-.69-.56-1.25-1.25-1.25H4.5c-.69 0-1.25.56-1.25 1.25v7.25c0 .69.56 1.25 1.25 1.25H7"/>',
  external: '<path d="M11.5 3.25h5.25V8.5M16.75 3.25 9.5 10.5M14.75 11.75v3.75c0 .69-.56 1.25-1.25 1.25h-9c-.69 0-1.25-.56-1.25-1.25v-9c0-.69.56-1.25 1.25-1.25h3.75"/>',
  chev: '<path d="m7.75 4.75 5.25 5.25-5.25 5.25"/>',
  clip: '<path d="M13.25 6.5v7.25a3.25 3.25 0 0 1-6.5 0V5a2.25 2.25 0 0 1 4.5 0v8.25a1.25 1.25 0 0 1-2.5 0V6.5"/>',
  arrowRight: '<path d="M3.75 10h12.5M11.75 5.5l4.5 4.5-4.5 4.5"/>',
  arrowLeft: '<path d="M16.25 10H3.75M8.25 5.5 3.75 10l4.5 4.5"/>',
  doc: '<path d="M11.5 2.75H5.25C4.56 2.75 4 3.31 4 4v12c0 .69.56 1.25 1.25 1.25h9.5c.69 0 1.25-.56 1.25-1.25V7.25z"/><path d="M11.25 2.75v4.5h4.5M7 10.75h6M7 13.5h4"/>',
  sun: '<circle cx="10" cy="10" r="3.25"/><path d="M10 2.5v1.5M10 16v1.5M2.5 10H4M16 10h1.5M4.7 4.7l1.06 1.06M14.24 14.24l1.06 1.06M4.7 15.3l1.06-1.06M14.24 5.76l1.06-1.06"/>',
  moon: '<path d="M16.5 12.4A6.75 6.75 0 1 1 7.6 3.5a5.5 5.5 0 0 0 8.9 8.9z"/>',
  monitor: '<rect x="2.75" y="3.5" width="14.5" height="10.25" rx="1.25"/><path d="M7 16.75h6M10 13.75v3"/>',
  info: '<circle cx="10" cy="10" r="7.25"/><path d="M10 9.25v4.5"/><path d="M10 6.4h.01" stroke-width="2"/>',
};
export const icon = (name, size = 20, label) =>
  raw(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'}>${P[name] || ''}</svg>`);

// ---- pen marks: what a clerk writes in a tick box (pathLength lets CSS draw them in) ----
const PEN = {
  pass: '<path pathLength="1" d="M3.6 10.6c1.3.9 2.4 2.3 3.3 4.1C8.9 10 12 5.9 16.9 3"/>',
  warn: '<path pathLength="1" d="M10.2 3.4c-.25 2.9-.35 5.6-.3 8.3"/><path pathLength="1" d="M9.9 15.6l.05.1"/>',
  fail: '<path pathLength="1" d="M4.8 4.6c3.4 3.2 6.9 7 10.6 10.9"/><path pathLength="1" d="M15.3 4.3c-3.9 3.4-7.3 7.1-10.4 11.3"/>',
  skip: '<path pathLength="1" d="M5 10.4c3.3-.35 6.6-.4 10-.1"/>',
  info: '<path pathLength="1" d="M10 8.9v5.4"/><path pathLength="1" d="M10 5.6v.1"/>',
};
export const pen = (kind, size = 20, label) =>
  raw(`<svg class="pen pen-${kind}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'}>${PEN[kind] || ''}</svg>`);

// ---- copy buttons: register text, render a button, one delegated handler in app.js ----
const copies = new Map();
let copySeq = 0;
export function copyButton(text, label = 'Copy') {
  const id = `c${++copySeq}`;
  copies.set(id, text);
  return html`<button type="button" class="btn sm" data-copy="${id}">${icon('copy', 16)}<span>${label}</span></button>`;
}
export async function handleCopy(btn) {
  const text = copies.get(btn.dataset.copy) ?? '';
  const span = btn.querySelector('span');
  const before = span.textContent;
  try { await navigator.clipboard.writeText(text); span.textContent = 'Copied'; } catch { span.textContent = 'Copy failed'; }
  setTimeout(() => { span.textContent = before; }, 1500);
}
