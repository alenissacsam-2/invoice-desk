// Shared helpers: safe HTML templating, API calls, formatting, icons.

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
export const DECISION = {
  APPROVE: { sub: 'Approved', chip: 'Approved', tone: 'approve', icon: 'passed' },
  REVIEW: { sub: 'On hold for review', chip: 'On hold', tone: 'review', icon: 'warning' },
  REJECT: { sub: 'Rejected', chip: 'Rejected', tone: 'reject', icon: 'failed' },
};
export const STAGE_TONE = { pending: 'neutral', running: 'accent', passed: 'approve', warning: 'review', failed: 'reject', skipped: 'neutral' };
export const CHECK_ICON = { pass: 'passed', warn: 'warning', fail: 'failed', info: 'info' };
export const CHECK_TONE = { pass: 'approve', warn: 'review', fail: 'reject', info: 'neutral' };
export const SEVERITY = { block: { icon: 'failed', tone: 'reject', label: 'Blocks payment' }, hold: { icon: 'warning', tone: 'review', label: 'Hold' }, info: { icon: 'info', tone: 'neutral', label: 'Note' } };

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

export function decisionChip(decision, status) {
  if (status === 'running') return html`<span class="chip t-accent"><span class="spin sm" aria-hidden="true"></span>Running</span>`;
  if (status === 'error') return html`<span class="chip t-neutral">${icon('info', 12)}Couldn't finish</span>`;
  const d = DECISION[decision];
  if (!d) return html`<span class="chip">${decision || '—'}</span>`;
  return html`<span class="chip t-${d.tone}">${icon(d.icon, 12)}${d.chip}</span>`;
}

// ---- icons (inline SVG, 16-unit grid) ----
const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const P = {
  passed: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path class="ic-fg" d="M4.9 8.2l2.05 2.05L11.1 6"/>',
  warning: '<path fill="currentColor" d="M6.86 2.2a1.32 1.32 0 0 1 2.28 0l5.68 9.98A1.32 1.32 0 0 1 13.68 14.2H2.32a1.32 1.32 0 0 1-1.14-1.98z"/><path class="ic-fg" d="M8 6.1v3.3"/><circle class="ic-dot" cx="8" cy="11.75" r=".95"/>',
  failed: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path class="ic-fg" d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5"/>',
  pending: `<circle cx="8" cy="8" r="6.25" ${S}/>`,
  skipped: `<circle cx="8" cy="8" r="6.25" ${S}/><path d="M5.5 8h5" ${S}/>`,
  info: `<circle cx="8" cy="8" r="6.25" ${S} stroke-width="1.35"/><path d="M8 7.4v3.5" ${S}/><circle cx="8" cy="5.1" r=".9" fill="currentColor"/>`,
  chev: `<path d="M6 3.5 10.5 8 6 12.5" ${S}/>`,
  upload: `<path d="M8 10.2V2.9M5 5.8l3-3 3 3M2.75 10.2v1.8c0 .66.54 1.2 1.2 1.2h8.1c.66 0 1.2-.54 1.2-1.2v-1.8" ${S}/>`,
  copy: `<rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.5" ${S}/><path d="M10.4 3.5v-.2c0-.66-.54-1.2-1.2-1.2H3.7c-.66 0-1.2.54-1.2 1.2v5.5c0 .66.54 1.2 1.2 1.2h.2" ${S}/>`,
  check: `<path d="M3.5 8.4l2.9 2.9 6.1-6.6" ${S}/>`,
  external: `<path d="M9.5 2.5h4v4M13.5 2.5 7.6 8.4M12 9.6v2.9c0 .66-.54 1.2-1.2 1.2H3.7c-.66 0-1.2-.54-1.2-1.2V5.4c0-.66.54-1.2 1.2-1.2h2.9" ${S}/>`,
  arrowLeft: `<path d="M13 8H3.5M7.3 4.2 3.5 8l3.8 3.8" ${S}/>`,
  arrowRight: `<path d="M3 8h9.5M8.7 4.2 12.5 8l-3.8 3.8" ${S}/>`,
  doc: `<path d="M9.3 1.9H4.4c-.66 0-1.2.54-1.2 1.2v9.8c0 .66.54 1.2 1.2 1.2h7.2c.66 0 1.2-.54 1.2-1.2V5.4z" ${S}/><path d="M9.2 2v3.5h3.5M5.7 8.6h4.6M5.7 11h3" ${S}/>`,
};
export const icon = (name, size = 16, label) =>
  raw(`<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"'}>${P[name] || ''}</svg>`);
export const statusIcon = (status, size = 16) => (status === 'running' ? raw('<span class="spin" aria-hidden="true"></span>') : icon(status, size));

// ---- copy buttons: register text, render a button, one delegated handler in app.js ----
const copies = new Map();
let copySeq = 0;
export function copyButton(text, label = 'Copy') {
  const id = `c${++copySeq}`;
  copies.set(id, text);
  return html`<button type="button" class="btn sm" data-copy="${id}">${icon('copy', 14)}<span>${label}</span></button>`;
}
export async function handleCopy(btn) {
  const text = copies.get(btn.dataset.copy) ?? '';
  const span = btn.querySelector('span');
  const before = span.textContent;
  try { await navigator.clipboard.writeText(text); span.textContent = 'Copied'; } catch { span.textContent = 'Copy failed'; }
  setTimeout(() => { span.textContent = before; }, 1500);
}
