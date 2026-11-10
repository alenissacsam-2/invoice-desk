// Pure AP rules: validation, vendor match, PO match/inference, duplicates. No I/O, no clock.
// Every stage returns { checks, reasons, data, ...stageFields } so the UI can show exactly why.
import { TOL } from './config.js';

// Rounding slack: INR invoices round to the rupee (often with a "round off" line), so allow 1 unit there.
const INR_SLACK = 1;
// Min description similarity for an invoice line to count as a given PO line when item codes don't match.
const LINE_MATCH_MIN = 0.5;
// Min name similarity for a vendor name/alias match (SPEC: token Jaccard >= 0.6).
const NAME_MATCH_MIN = 0.6;
const EPS = 1e-6; // float noise, so "exactly 2%" is not 2.0000000001%

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'to', 'in', 'on', 'at', 'by', 'with', 'per', 'from',
  'inc', 'llc', 'ltd', 'pvt', 'co', 'corp', 'corporation', 'company', 'limited', 'private', 'plc', 'gmbh']);

// ---------- small helpers ----------
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const r2 = (x) => Math.round(x * 100) / 100;
const pct1 = (x) => `${(Math.round(x * 100) / 100).toString()}%`;
const qtyStr = (q) => (Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100));
const alnum = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const last4 = (s) => String(s ?? '').slice(-4);
const humanList = (xs, and = 'and') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs.at(-1)}`);
const slackFor = (cur) => (cur === 'INR' ? INR_SLACK : TOL.arithAbs);

export const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');

/** Display money: $4,111.07, ₹1,16,820.00 (Indian grouping), else Intl's symbol or "12.00 XYZ". */
export function money(n, cur = 'USD') {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'an unknown amount';
  try {
    return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur || 'USD' }).format(n).replace(/^-/, '−');
  } catch { return `${n.toFixed(2)} ${cur}`.replace(/^-/, '−'); }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-11-15' (or an ISO timestamp) → '15 Nov 2026'; anything else comes back unchanged. The one date format for messages. */
export function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  return m && MON[+m[2] - 1] ? `${+m[3]} ${MON[+m[2] - 1]} ${m[1]}` : s;
}

/**
 * Uppercase, keep alphanumerics, strip leading zeros of each digit run.
 * Zeros are stripped per separator-delimited segment, so INV-2026-0042 == INV-2026-42 (zero padding)
 * while INV-1045 != INV-10450. Two digit runs split by a separator keep a "-" between them,
 * so INV-1045-0 != INV-10450.
 */
export function normalizeInvoiceNumber(s) {
  if (s === null || s === undefined) return null;
  const segs = String(s).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
    .map((seg) => seg.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, '')));
  const out = segs.reduce((acc, seg) => acc + (/\d$/.test(acc) && /^\d/.test(seg) ? '-' : '') + seg, '');
  return out || null;
}

export const normalizePO = (s) => alnum(s) || null;

// Digit groups without zero padding: labels and prefixes ("PO# ", "Your Ref:", "PO-") drop out by themselves.
const poDigitKey = (s) => (String(s ?? '').match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, '')).join('-');
/** Find the PO an invoice quotes: exact (alphanumerics), else the one PO whose digit groups match ("2026-0412", "PO-2026-412", "PO# PO-2026-0412"). */
export function resolvePO(quoted, pos = []) {
  const exact = pos.find((p) => normalizePO(p.po_number) === normalizePO(quoted));
  if (exact) return exact;
  const key = poDigitKey(quoted);
  if (!key) return null;
  const hits = pos.filter((p) => poDigitKey(p.po_number) === key);
  return hits.length === 1 ? hits[0] : null;
}

// Labels printed in front of a tax ID ("EIN: ", "GSTIN ", "Tax ID No.").
const TAXID_LABEL_RE = /^\s*(?:(?:f?ein|tin|gstin|gst(?:\s*(?:no|reg(?:istration)?))?|vat(?:\s*reg(?:istration)?)?|tax\s*(?:id|identification)|federal\s+tax\s+id)\b\s*(?:no\.?|number|#)?\s*[:#.-]?\s*)+/i;
/** Tax ID without its printed label, uppercase, no spaces. */
export const cleanTaxId = (s) => (s === null || s === undefined || s === '' ? null : String(s).replace(TAXID_LABEL_RE, '').toUpperCase().replace(/\s+/g, '') || null);
// Labels printed in front of a routing/bank code ("ABA 121000248", "Routing No.: ", "IFSC: ").
const ROUTING_LABEL_RE = /^\s*(?:(?:aba|rtn|ach|routing|ifsc|sort|bsb|transit|swift|bic)\b\s*(?:code|no\.?|number|#)?\s*[:#.-]?\s*)+/i;
const cleanRouting = (s) => alnum(String(s ?? '').replace(ROUTING_LABEL_RE, ''));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Light stemming so 'monthly'~'month', 'services'~'service', 'October'~'Oct' (vision models paraphrase).
const stem = (t) => {
  const m = MONTHS.find((x) => t.startsWith(x) && t.length >= 3);
  if (m && /^[a-z]+$/.test(t)) return m;
  if (t.length > 5 && t.endsWith('ly')) t = t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
};
const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOPWORDS.has(t)).map(stem);

/** Overlap coefficient |A∩B| / min(|A|,|B|): a short PO description fully contained in a wordier invoice line scores 1. */
function overlap(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Token Jaccard over lowercased alphanumeric tokens, stopwords and legal suffixes ignored. */
export function tokenSim(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 'YYYY-MM-DD' → UTC ms, or null when not a real calendar date. */
function parseDate(s) {
  const m = DATE_RE.exec(String(s ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}
const DAY = 86400000;
export const addDays = (s, d) => { const t = parseDate(s); return t === null ? null : new Date(t + d * DAY).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);

/** Header numbers. Net (pre-tax, incl. shipping/surcharges) is always total − tax when a total exists. */
export function invoiceTotals(ex) {
  const lines = ex?.line_items ?? [];
  const sumLines = sum(lines.map((l) => num(l.amount)));
  const taxLines = ex?.tax_lines ?? [];
  const tax = num(ex?.tax_total) ?? sum(taxLines.map((t) => num(t.amount)));
  const total = num(ex?.total);
  const shipping = num(ex?.shipping) ?? 0;
  const net = total !== null ? total - tax
    : ex?.tax_inclusive ? sumLines + shipping - tax
      : (num(ex?.subtotal) ?? sumLines) + shipping;
  return { sumLines, tax, total, shipping, net };
}

function stage() {
  const checks = [], reasons = [];
  return {
    checks, reasons,
    check: (label, status, detail = '') => checks.push({ label, status, detail }),
    reason: (code, severity, message) => reasons.push({ code, severity, message }),
  };
}

// ---------- 3. validate ----------
const DOC_TYPE_WORDS = { credit_note: 'a credit note', quote: 'a quote', statement: 'a statement of account', receipt: 'a payment receipt', other: 'a document' };
const EIN_RE = /^\d{2}-?\d{7}$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** A credit note (or an "invoice" with a negative total) reduces what we owe; it is handled, not rejected. */
export const isCreditNote = (ex) => ex?.document_type === 'credit_note'
  || ((!ex?.document_type || ex.document_type === 'invoice') && num(ex?.total) !== null && num(ex.total) < 0);

// Credit notes print amounts with either sign; compare magnitudes so a credit passes the same arithmetic as an invoice.
const absNum = (x) => (num(x) === null ? x : Math.abs(num(x)));
const absAmounts = (ex) => ({
  ...ex, subtotal: absNum(ex.subtotal), tax_total: absNum(ex.tax_total), shipping: absNum(ex.shipping), total: absNum(ex.total),
  line_items: (ex.line_items ?? []).map((l) => ({ ...l, quantity: absNum(l.quantity), unit_price: absNum(l.unit_price), amount: absNum(l.amount) })),
  tax_lines: (ex.tax_lines ?? []).map((x) => ({ ...x, amount: absNum(x.amount) })),
});

export function validate(ex, { today } = {}) {
  const s = stage();
  const cur = ex?.currency || 'USD';
  const m = (n) => money(n, cur);
  const credit = isCreditNote(ex);

  if (!credit && (!ex || ex.is_invoice === false || (ex.document_type && ex.document_type !== 'invoice'))) {
    const what = DOC_TYPE_WORDS[ex?.document_type] ?? 'a document';
    s.check('Document is an invoice', 'fail', `Looks like ${what}`);
    s.reason('NOT_AN_INVOICE', 'block', `This is ${what}, not an invoice, so there is nothing to pay.`);
    return { checks: s.checks, reasons: s.reasons, data: { documentType: ex?.document_type ?? null } };
  }
  if (credit) s.check('Document type', 'info', 'Credit note: reduces what we owe the vendor');
  else s.check('Document is an invoice', 'pass', 'document_type = invoice');
  const ax = credit ? absAmounts(ex) : ex; // arithmetic view

  // Required fields
  const required = [
    ['invoice number', ex.invoice_number], ['invoice date', ex.invoice_date],
    ['vendor name', ex.vendor?.name], ['total', num(ex.total)],
  ];
  const missing = required.filter(([, v]) => v === null || v === undefined || v === '').map(([k]) => k);
  for (const [k, v] of required) s.check(`Has ${k}`, missing.includes(k) ? 'fail' : 'pass', missing.includes(k) ? 'Not on the document' : String(v));
  if (missing.length) {
    const why = missing.includes('invoice number') ? ' and to check it is not a duplicate' : '';
    s.reason('MISSING_FIELD', 'hold', `The ${credit ? 'credit note' : 'invoice'} shows no ${humanList(missing, 'or')}; we need ${missing.length > 1 ? 'them' : 'it'} to book it${why}.`);
  }

  // Arithmetic
  const t = invoiceTotals(ax);
  const slack = slackFor(cur);
  const lines = ax.line_items ?? [];
  let arithOk = true;
  const mismatch = (label, msg) => { arithOk = false; s.check(label, 'fail', msg); s.reason('ARITHMETIC_MISMATCH', 'hold', msg); };
  lines.forEach((l, i) => {
    const q = num(l.quantity), u = num(l.unit_price), a = num(l.amount);
    if (q === null || u === null || a === null) return;
    if (Math.abs(q * u - a) > slack + EPS)
      mismatch(`Line ${i + 1} arithmetic`, `Line ${i + 1} (${l.description}) says ${qtyStr(q)} × ${m(u)} = ${m(a)}, but that comes to ${m(q * u)}.`);
  });
  const subtotal = num(ax.subtotal);
  if (subtotal !== null && lines.length) {
    // Tax-inclusive invoices may print a gross or a net subtotal; accept either.
    const ok = Math.abs(t.sumLines - subtotal) <= slack + EPS || (ax.tax_inclusive && Math.abs(t.sumLines - t.tax - subtotal) <= slack + EPS);
    if (ok) s.check('Lines add up to subtotal', 'pass', `${m(t.sumLines)}`);
    else mismatch('Lines add up to subtotal', `The lines add up to ${m(t.sumLines)}, but the subtotal says ${m(subtotal)}.`);
  }
  const taxLines = ax.tax_lines ?? [];
  if (taxLines.length && num(ax.tax_total) !== null) {
    const st = sum(taxLines.map((x) => num(x.amount)));
    if (Math.abs(st - num(ax.tax_total)) > slack + EPS)
      mismatch('Tax lines add up to tax total', `The tax lines add up to ${m(st)}, but the tax total says ${m(num(ax.tax_total))}.`);
  }
  let totalOk = false;
  if (t.total !== null) {
    const expected = ax.tax_inclusive ? (subtotal !== null && Math.abs(subtotal - t.sumLines) > slack ? subtotal + t.tax : t.sumLines) + t.shipping
      : (subtotal ?? t.sumLines) + t.tax + t.shipping;
    if (lines.length || subtotal !== null) {
      totalOk = Math.abs(expected - t.total) <= slack + EPS;
      if (totalOk) s.check('Total adds up', 'pass', `${m(t.total)}`);
      else mismatch('Total adds up', ax.tax_inclusive
        ? `The prices include tax and add up to ${m(expected)}, but the invoice total says ${m(t.total)}.`
        : `Subtotal ${m(subtotal ?? t.sumLines)} + tax ${m(t.tax)}${t.shipping ? ` + shipping ${m(t.shipping)}` : ''} = ${m(expected)}, but the invoice total says ${m(t.total)}.`);
    }
  }
  // Tax rate × taxable base ≈ tax amount. Inclusive: back the tax out of the gross with the combined rate.
  const rated = taxLines.filter((x) => num(x.rate_pct) !== null && num(x.amount) !== null);
  const sumRates = sum(rated.map((x) => num(x.rate_pct)));
  const base = subtotal ?? t.sumLines;
  for (const x of rated) {
    const rate = num(x.rate_pct), amt = num(x.amount);
    const label = x.label || `Tax ${rate}%`;
    if (ax.tax_inclusive) {
      const gross = t.total ?? t.sumLines;
      const exp = (gross * rate) / (100 + sumRates);
      if (Math.abs(exp - amt) <= slack + EPS) s.check(`${label} rate`, 'pass', `${rate}% included in ${m(gross)} = ${m(exp)}`);
      else mismatch(`${label} rate`, `${label} at ${rate}% included in ${m(gross)} should be about ${m(exp)}, but the invoice shows ${m(amt)}.`);
    } else {
      const exp = (base * rate) / 100, expShip = ((base + t.shipping) * rate) / 100; // shipping is taxable in some places
      if (Math.abs(exp - amt) <= slack + EPS || (t.shipping && Math.abs(expShip - amt) <= slack + EPS))
        s.check(`${label} rate`, 'pass', `${rate}% of ${m(base)} = ${m(r2(exp))}`);
      // Taxed on part of the base (non-taxable lines, or one tax line per HSN code at the same rate): fine when the total reconciles.
      else if (totalOk && rate > 0 && amt >= 0 && (amt * 100) / rate <= base + t.shipping + slack + EPS)
        s.check(`${label} rate`, 'warn', `${rate}% of ${m((amt * 100) / rate)}, part of the ${m(base)} subtotal (some lines not taxed at this rate); the total adds up`);
      else mismatch(`${label} rate`, `${label} at ${rate}% of ${m(base)} should be ${m(exp)}, but the invoice shows ${m(amt)}.`);
    }
  }
  if (arithOk && lines.length) s.check('Arithmetic', 'pass', `All amounts agree within ${m(slack)}`);
  if (ax.tax_inclusive) {
    s.check('Tax-inclusive prices', 'info', `Net ${m(t.net)} = total ${m(t.total)} − tax ${m(t.tax)}`);
    s.reason('TAX_INCLUSIVE', 'info', `Prices on this invoice include tax, so we compare ${m(t.net)} (the total less ${m(t.tax)} tax) with the PO.`);
  }

  // Dates
  if (ex.invoice_date) {
    const d = ex.invoice_date;
    if (parseDate(d) === null) {
      s.check('Invoice date is valid', 'fail', d);
      s.reason('DATE_OUT_OF_RANGE', 'hold', `The invoice date "${d}" is not a real calendar date.`);
    } else if (today && daysBetween(today, d) > 1) {
      s.check('Invoice date not in the future', 'fail', `${d} vs today ${today}`);
      s.reason('DATE_OUT_OF_RANGE', 'hold', `The invoice is dated ${fmtDate(d)}, which is in the future (today is ${fmtDate(today)}).`);
    } else if (today && daysBetween(d, today) > TOL.maxAgeDays) {
      s.check('Invoice date within a year', 'fail', `${daysBetween(d, today)} days old`);
      s.reason('DATE_OUT_OF_RANGE', 'hold', `The invoice is dated ${fmtDate(d)}, ${daysBetween(d, today)} days ago, which is past our ${TOL.maxAgeDays}-day limit.`);
    } else s.check('Invoice date in range', 'pass', today ? `${d} (${daysBetween(d, today)} days ago)` : d);
    // A due date that contradicts the printed terms (or precedes the invoice) usually means a day/month misread.
    if (ex.due_date && parseDate(ex.due_date) !== null && parseDate(d) !== null) {
      const gap = daysBetween(d, ex.due_date);
      const netN = Number(String(ex.payment_terms ?? '').match(/\bnet\s*(\d{1,3})\b/i)?.[1] ?? NaN);
      const dates = `Invoice date ${fmtDate(d)} and due date ${fmtDate(ex.due_date)}`;
      const check = 'the date may have been misread (5/11 vs 11/5). Check the document.';
      if (gap < 0) {
        s.check('Dates fit payment terms', 'fail', `Due ${ex.due_date} is before the invoice date ${d}`);
        s.reason('LOW_CONFIDENCE', 'hold', `${dates}: the due date is before the invoice date — ${check}`);
      } else if (Number.isFinite(netN) && Math.abs(gap - netN) > 3) {
        s.check('Dates fit payment terms', 'fail', `${gap} days apart, terms say Net ${netN}`);
        s.reason('LOW_CONFIDENCE', 'hold', `${dates} don't fit the printed Net ${netN} terms — ${check}`);
      } else if (Number.isFinite(netN)) s.check('Dates fit payment terms', 'pass', `${gap} days apart, Net ${netN}`);
    }
  }
  if (ex.due_date && parseDate(ex.due_date) === null)
    s.check('Due date is valid', 'warn', `"${ex.due_date}" is not a real calendar date; we use the invoice date plus the vendor's terms`);

  // Low confidence on key fields (only fields that have a value; an absent field is already MISSING_FIELD)
  const conf = ex.confidence ?? {};
  const keyVals = { vendor_name: ex.vendor?.name, invoice_number: ex.invoice_number, invoice_date: ex.invoice_date, po_number: ex.po_number, total: ex.total };
  const unsure = Object.entries(keyVals)
    .filter(([k, v]) => v !== null && v !== undefined && num(conf[k]) !== null && num(conf[k]) < TOL.lowConfidence)
    .map(([k]) => ({ k: k.replace('_', ' '), c: num(conf[k]) }));
  if (unsure.length) {
    s.check('Extraction confidence', 'fail', unsure.map((u) => `${u.k} ${Math.round(u.c * 100)}%`).join(', '));
    s.reason('LOW_CONFIDENCE', 'hold', `The document reader was not sure about the ${humanList(unsure.map((u) => `${u.k} (${Math.round(u.c * 100)}% sure)`))}, so a person should check against the original.`);
  } else s.check('Extraction confidence', 'pass', `Key fields at or above ${Math.round(TOL.lowConfidence * 100)}%`);
  if (ex.source_quality?.legibility === 'low') s.check('Legibility', 'warn', 'Document is hard to read');
  else if (ex.source_quality?.kind === 'scanned_image') s.check('Source', 'info', `Scanned image, legibility ${ex.source_quality.legibility}`);

  // Tax ID format for the vendor's country, inferred from the invoice currency (the vendor is not matched yet);
  // with no currency read, from the shape of the ID itself, so a GSTIN is never checked as an EIN.
  const rawTid = ex.vendor?.tax_id;
  const tid = cleanTaxId(rawTid);
  const country = ex.currency === 'USD' ? 'US' : ex.currency === 'INR' ? 'IN'
    : !ex.currency && tid ? (GSTIN_RE.test(tid) ? 'IN' : EIN_RE.test(tid) ? 'US' : null) : null;
  if (!tid) s.check('Tax ID format', 'info', 'No tax ID on the invoice');
  else if (!country) s.check('Tax ID format', 'info', `${rawTid} (format not checked${ex.currency ? ` for ${ex.currency}` : ': currency not read'})`);
  else {
    const ok = country === 'US' ? EIN_RE.test(tid) : GSTIN_RE.test(tid);
    const kind = country === 'US' ? 'US EIN (NN-NNNNNNN)' : 'Indian GSTIN (15 characters, like 29AABCS1234F1Z5)';
    s.check('Tax ID format', ok ? 'pass' : 'fail', `${rawTid}${ok ? '' : ` is not a valid ${kind}`}`);
    if (!ok) s.reason('TAX_ID_INVALID', 'hold', `The tax ID "${rawTid}" on the invoice is not a valid ${kind}.`);
  }

  if (ex.notices?.length) s.check('Notices on the document', 'info', ex.notices.join(' | '));
  return { checks: s.checks, reasons: s.reasons, data: { ...invoiceTotals(ex), slack, missing, creditNote: credit } };
}

// ---------- 4. vendor ----------
function nameScore(name, v) {
  const na = tokens(name).join(' ');
  let best = 0;
  for (const c of [v.name, ...(v.aliases ?? [])]) {
    const nb = tokens(c).join(' ');
    let sc = tokenSim(name, c);
    // "one name contains the other", on whole tokens, and only for names with some substance
    if (na && nb && Math.min(na.length, nb.length) >= 4 && (` ${na} `.includes(` ${nb} `) || ` ${nb} `.includes(` ${na} `))) sc = Math.max(sc, 0.9);
    best = Math.max(best, sc);
  }
  return best;
}
const domainOf = (email) => String(email ?? '').toLowerCase().split('@')[1]?.replace(/[^a-z0-9.-]/g, '') || null;
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'zoho.com', 'rediffmail.com', 'mail.com']);
const SLD = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);
/** Registrable label without TLD or subdomains: mail.kestrel-supply.co.uk → kestrel-supply. */
function coreLabel(d) {
  const parts = String(d ?? '').split('.').filter(Boolean);
  const tld = parts.pop();
  if (parts.length > 1 && tld?.length === 2 && SLD.has(parts.at(-1))) parts.pop();
  return parts.at(-1) ?? '';
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const DIGIT_LOOKS = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b' };
const skeleton = (l) => l.replace(/[-_]/g, '').replace(/\d/g, (d) => DIGIT_LOOKS[d] ?? d).replace(/i/g, 'l');
/** SPEC: edit distance ≤ 2 on the core label, or the same letters with a hyphen added or a digit swapped in. */
export function isLookalikeDomain(a, b) {
  const x = coreLabel(a), y = coreLabel(b);
  if (!x || !y || a === b || a.endsWith('.' + b) || b.endsWith('.' + a)) return false; // a subdomain of the real domain is the real domain
  if (x === y || skeleton(x) === skeleton(y)) return true; // TLD swap, hyphen, 0↔o, 1↔l
  // The real domain used as a prefix or part of another one: acmeofficesupply.com.payments-portal.net, acmeofficesupply-billing.com
  if (a.startsWith(b + '.') || a.includes('.' + b + '.') || b.startsWith(a + '.')) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  return Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= 2;
}

// Text on the document that tries to steer how it is processed (prompt injection, social engineering).
// - patterns: imperatives aimed at whoever processes the invoice (approve/pay/skip/ignore + verification/checks/
//   instructions), "pre-approved" claims, AI/automation addressed directly, and a few Spanish/German equivalents.
//   Scanned in notices and payment terms only: line descriptions ("Edge AI processor", "Same-day transfer") are goods.
// - tells: things no genuine invoice prints anywhere — our extraction schema's field names and chat-role prefixes.
//   Scanned in every extracted string (vendor name/address, bill-to, bank name, item codes, lines…).
// - urgency + payment in one text: urgency alone is normal dunning ("Payment due immediately upon receipt" is fine),
//   so only deadline pressure ("within 24 hours", "final warning", "urgent") together with a payment word counts.
// All text is normalised first (NFKC, zero-width characters removed, "a p p r o v e" collapsed).
const STEERING = {
  patterns: [
    /\bpre-?(?:approved|authori[sz]ed|verified|cleared)\b/i,
    /\balready\s+(?:been\s+)?(?:approved|authori[sz]ed|verified|cleared)\b/i,
    /\b(?:auto-?approve|approve\s+(?:this|it|immediately|now|without|today|at\s+once|right\s+away))\b/i,
    /\b(?:do\s+not|don'?t|no\s+need\s+to|skip(?:ping)?|bypass(?:ing)?)\s+(?:any\s+|the\s+|further\s+|this\s+|our\s+|your\s+)?(?:verif|check|call|confirm|review|validat|approv|contact)\w*/i,
    /\bwithout\s+(?:any\s+|further\s+|the\s+)?(?:verification|verifying|checks?|checking|call-?\s?backs?|calling|review|validation)\b/i,
    /\bno\s+(?:call-?\s?backs?|verification|confirmation|checks?)\s+(?:is\s+|are\s+)?(?:required|needed|necessary)\b/i,
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|other|usual|standard|existing|normal)?\s*(?:instructions?|rules?|checks?|controls?|polic(?:y|ies)|prompts?|verification)\b/i,
    /\byour\s+new\s+instructions\b|\bnew\s+instructions\s+(?:are|follow)\b/i,
    // An AI addressed with an imperative ("AI reviewers must approve…"); case-sensitive AI so "ai" inside words doesn't count.
    /\b(?:AI|LLM|GPT|[Ll]anguage [Mm]odel)s?\b[^.]{0,60}\b(?:[Aa]pprove|[Pp]ay|[Pp]rocess|[Ii]gnore|[Ss]kip|must|should|[Mm]ark|[Aa]ccept|[Rr]elease)\b/,
    /\b(?:[Aa]pprove|[Ii]gnore|[Ss]kip|[Pp]ay)\b[^.]{0,60}\b(?:AI|LLM|GPT)s?\b/,
    /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?(?:automated|AI|AP\s+(?:system|bot|software)|systems?|processors?|reviewers?|bots?|assistants?)\b/i,
    /\bautomated\s+(?:\w+\s+)?(?:systems?|processors?|processing|reviews?|tools?|agents?)\b/i,
    // Spanish / German: approve immediately, skip / without verification.
    /\b(?:aprobar|apruebe|aprueben)\s+(?:de\s+inmediato|inmediatamente|ya|sin)\b|\b(?:sin|no)\s+(?:verificar|verificaci[oó]n|comprobar|revisar)\b|\bomitir\s+(?:la\s+)?verificaci[oó]n\b/i,
    /\bsofort\s+(?:genehmigen|freigeben)\b|\bohne\s+(?:weitere\s+)?(?:Prüfung|Überprüfung|Verifizierung|Kontrolle)\b|\b(?:Prüfung|Überprüfung|Verifizierung)\s+überspringen\b|\bnicht\s+(?:prüfen|überprüfen|verifizieren)\b/i,
  ],
  tells: [
    /\b(?:po_number|bank_details|is_invoice|invoice_number|document_type|line_items|tax_inclusive|source_quality|routing_code|account_number|vendor_name)\b/i,
    /["']?\b(?:notices|confidence)\b["']?\s*[:=]\s*["'[{\d]/i,
  ],
  // Chat-role prefix ("SYSTEM:", "[assistant]:"); everywhere except line descriptions ("System: 4-axis CNC" is a product).
  role: /(?:^|\n)\s*[[<]?(?:system|assistant)\s*[\]>]?\s*:/i,
  urgency: /\b(?:urgent(?:ly)?|asap|within\s+(?:24|48|72)\s+hours|final\s+(?:warning|notice)|today\s+only)\b/i,
  payment: /\b(?:pay|payment|wire|transfer|remit(?:tance)?)\b/i,
};
/** NFKC, zero-width and soft-hyphen characters removed, spaced-out letters ("a p p r o v e") collapsed. */
const normText = (t) => String(t).normalize('NFKC').replace(/[​-‏⁠-⁤﻿­]/g, '')
  .replace(/\b(?:\p{L}[ .]){3,}\p{L}\b/gu, (m) => m.replace(/[ .]/g, ''));
const strings = (o) => (typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : []);
const freeTexts = (ex) => [...(ex?.notices ?? []), ex?.payment_terms].filter((t) => typeof t === 'string' && t);
const steerHit = (t) => STEERING.patterns.some((re) => re.test(t)) || (STEERING.urgency.test(t) && STEERING.payment.test(t));
/** Texts on the document that try to steer its processing (original wording, for display). */
export function findSteering(ex) {
  const free = new Set(freeTexts(ex));
  const descs = new Set((ex?.line_items ?? []).map((l) => l?.description));
  return [...new Set(strings(ex ?? {}))].filter((t) => {
    const n = normText(t);
    return STEERING.tells.some((re) => re.test(n)) || (!descs.has(t) && STEERING.role.test(n)) || (free.has(t) && steerHit(n));
  });
}
function checkSteering(s, ex) {
  const hits = findSteering(ex);
  if (!hits.length) { s.check('Instructions aimed at processors', 'pass', 'None found'); return; }
  s.check('Instructions aimed at processors', 'fail', hits.join(' | '));
  // Quote the trigger phrases, not the whole text (the full text is in the check above).
  const phrases = [...new Set(hits.map(normText).flatMap((t) => [...STEERING.patterns, ...STEERING.tells, STEERING.role, STEERING.urgency].map((re) => re.exec(t)?.[0]).filter(Boolean)))].slice(0, 2);
  s.reason('SUSPICIOUS_INSTRUCTIONS', 'hold', `The document carries instructions aimed at whoever processes it (${phrases.map((p) => `"${p.trim()}"`).join(', ')}); we never follow those, and genuine vendors don't send them, so the vendor must confirm the invoice before anything is paid.`);
}
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function matchVendor(ex, vendors = []) {
  const s = stage();
  const name = ex?.vendor?.name ?? null;
  const tid = alnum(cleanTaxId(ex?.vendor?.tax_id));
  let vendor = null, method = null, score = 0;

  if (tid) {
    vendor = vendors.find((v) => alnum(cleanTaxId(v.tax_id)) === tid) ?? null;
    if (vendor) {
      method = 'tax_id'; score = 1;
      s.check('Tax ID on file', 'pass', `${ex.vendor.tax_id} → ${vendor.vendor_id} ${vendor.name}`);
      if (name && nameScore(name, vendor) < NAME_MATCH_MIN) {
        // The name is another vendor's (e.g. a blocked one) while the tax ID is this one's: identity conflict, never approve.
        const other = vendors.filter((v) => v !== vendor).map((v) => ({ v, sc: nameScore(name, v) })).sort((a, b) => b.sc - a.sc)[0];
        if (other && other.sc >= NAME_MATCH_MIN) {
          s.check('Name matches master', 'fail', `Invoice says "${name}", which is ${other.v.vendor_id} ${other.v.name}${other.v.status === 'blocked' ? ' (blocked)' : ''}, but the tax ID is ${vendor.vendor_id} ${vendor.name}'s`);
          s.reason('VENDOR_UNKNOWN', 'hold', `The invoice is in the name of ${other.v.name}${other.v.status === 'blocked' ? ', a blocked vendor,' : ''} but carries ${vendor.name}'s tax ID (${vendor.tax_id}), so we can't be sure who sent it.`);
        } else s.check('Name matches master', 'warn', `Invoice says "${name}", master says "${vendor.name}" (trading name?)`);
      }
    } else s.check('Tax ID on file', 'warn', `${ex.vendor.tax_id} is not in the vendor master`);
  }
  if (!vendor && name) {
    const ranked = vendors.map((v) => ({ v, sc: nameScore(name, v) })).sort((a, b) => b.sc - a.sc);
    const [best, second] = ranked;
    if (best && best.sc >= NAME_MATCH_MIN) {
      vendor = best.v; method = 'name'; score = r2(best.sc);
      s.check('Name match', 'pass', `"${name}" → ${vendor.vendor_id} ${vendor.name} (similarity ${Math.round(best.sc * 100)}%)`);
      if (second && second.sc >= NAME_MATCH_MIN && best.sc - second.sc < 0.1)
        s.check('Name is unambiguous', 'warn', `Also resembles ${second.v.vendor_id} ${second.v.name}`);
      if (tid && alnum(cleanTaxId(vendor.tax_id)) && alnum(cleanTaxId(vendor.tax_id)) !== tid)
        s.reason('VENDOR_UNKNOWN', 'hold', `The name matches ${vendor.name}, but the tax ID on the invoice (${ex.vendor.tax_id}) is not the one on file (${vendor.tax_id}), so we can't be sure who sent it.`);
    } else score = best ? r2(best.sc) : 0;
  }
  if (!vendor) {
    s.check('Vendor in master', 'fail', name ? `No match for "${name}"` : 'No vendor name or tax ID');
    s.reason('VENDOR_UNKNOWN', 'hold', `${name ? `"${name}"` : 'The sender'} is not in our vendor master (no tax ID or name match), so it must be identified or set up before we can pay it.`);
    checkSteering(s, ex);
    return { checks: s.checks, reasons: s.reasons, data: { name, taxId: ex?.vendor?.tax_id ?? null }, vendor: null, method: null, score };
  }

  if (vendor.status === 'blocked') {
    s.check('Vendor status', 'fail', 'blocked');
    s.reason('VENDOR_BLOCKED', 'block', `${vendor.name} is blocked in the vendor master, so we cannot pay its invoices.`);
  } else s.check('Vendor status', 'pass', vendor.status);
  if (ex.currency && vendor.currency && ex.currency !== vendor.currency)
    s.check('Currency matches vendor', 'warn', `Invoice ${ex.currency}, vendor usually bills ${vendor.currency}`);

  // Bank details: any difference from the master is a payment-redirection risk until verified by call-back.
  const bd = ex.bank_details ?? {};
  const mAcct = digitsOnly(vendor.bank_account), mRout = cleanRouting(vendor.bank_routing);
  const diffs = [];
  const invAcctRaw = String(bd.account_number ?? '');
  const invAcct = digitsOnly(invAcctRaw);
  if (invAcct) {
    const masked = /[*xX•#]/.test(invAcctRaw); // "****2233" style: compare only the visible tail
    const same = mAcct && (masked ? mAcct.endsWith(invAcct) : invAcct === mAcct);
    s.check('Bank account matches master', same ? 'pass' : 'fail', `Invoice …${last4(invAcct)}, master ${mAcct ? `…${last4(mAcct)}` : 'none on file'}`);
    if (!same) diffs.push('account');
  }
  const invRout = cleanRouting(bd.routing_code);
  if (invRout) {
    const same = invRout === mRout;
    s.check('Routing code matches master', same ? 'pass' : 'fail', `Invoice ${bd.routing_code}, master ${vendor.bank_routing || 'none on file'}`);
    if (!same) diffs.push('routing');
  }
  if (bd.iban) {
    const same = mAcct && digitsOnly(bd.iban).includes(mAcct);
    s.check('IBAN matches master account', same ? 'pass' : 'fail', `IBAN ${bd.iban}`);
    if (!same) diffs.push('iban');
  }
  if (!invAcct && !invRout && !bd.iban) s.check('Bank details', 'info', 'No bank details printed; we pay the account on file');
  // A notice announcing a change; "have NOT changed", "unchanged", "will never change" are fraud-awareness footers, not changes.
  const NEGATED = /\b(?:not|never|no\s+longer|n't)\b[^.]{0,30}\b(?:chang|updat|mov|switch)|\bunchanged\b|\bremain(?:s|ing)?\s+(?:the\s+)?same\b|\bsame\s+as\s+(?:before|always)\b/i;
  const bankNotice = (ex.notices ?? []).find((n) => /bank|account|remit|payment details/i.test(n) && /chang|new|updat|moved|switch/i.test(n) && !NEGATED.test(n));
  if (bankNotice) s.check('Bank change notice', 'fail', bankNotice);

  // Contact/remit email domains on the invoice (vendor block and notices) vs the master's remit email.
  // A free-mail master address (gmail…) proves nothing by domain, so there the whole address has to match.
  const invDom = domainOf(ex.vendor?.email), mDom = domainOf(vendor.remit_email);
  const addr = (e) => String(e ?? '').trim().toLowerCase();
  const invAddrs = [...new Set([ex.vendor?.email, ...(ex.notices ?? []).flatMap((n) => n.match(EMAIL_RE) ?? [])].map(addr).filter((e) => domainOf(e)))];
  let domainNote = '', lookalikeDom = null;
  for (const e of mDom ? invAddrs : []) {
    const d = domainOf(e);
    if (FREEMAIL.has(mDom) && d === mDom) {
      if (e === addr(vendor.remit_email)) s.check('Contact email domain', 'pass', e);
      else {
        s.check('Contact email domain', 'warn', `${e} is not ${vendor.remit_email} on file (${mDom} is a free-mail domain, so the whole address must match)`);
        domainNote ||= `, and the invoice's contact email (${e}) is not the one on file (${vendor.remit_email})`;
      }
      continue;
    }
    if (d === mDom || d.endsWith('.' + mDom)) { s.check('Contact email domain', 'pass', d); continue; }
    if (isLookalikeDomain(d, mDom)) {
      lookalikeDom ??= d;
      s.check('Contact email domain', 'fail', `${d} imitates ${mDom} on file (lookalike domain)`);
    } else {
      s.check('Contact email domain', 'warn', `${d} differs from ${mDom} on file`);
      domainNote ||= `, and the invoice's contact email domain (${d}) is not the one on file (${mDom})`;
    }
  }
  if (ex.vendor?.phone && vendor.phone && digitsOnly(ex.vendor.phone) !== digitsOnly(vendor.phone))
    s.check('Phone matches master', 'warn', `Invoice ${ex.vendor.phone}, master ${vendor.phone}: call back on the master number only`);

  if (diffs.length || bankNotice) {
    const routingDiff = diffs.includes('routing');
    const onFile = mAcct ? `${vendor.bank_name} account ending ${last4(mAcct)}${routingDiff && vendor.bank_routing ? ` (routing ${vendor.bank_routing})` : ''}` : 'no bank account';
    const asked = diffs.length
      ? `${bd.bank_name || 'a different bank'}${invAcct ? ` account ending ${last4(invAcct)}` : ''}${invRout ? ` (routing ${bd.routing_code})` : ''}${bd.iban && !invAcct ? ` IBAN ${bd.iban}` : ''}`
      : null;
    const msg = asked
      ? (diffs.length === 1 && routingDiff && invAcct
        ? `The invoice shows routing ${bd.routing_code} for account ending ${last4(invAcct)}, but our vendor master has routing ${vendor.bank_routing || 'none'} for ${vendor.name}${domainNote}.`
        : `The invoice asks us to pay ${asked}, but our vendor master has ${onFile} for ${vendor.name}${domainNote}.`)
      : invAcct || invRout
        // Notice says "changed" but the printed details are the ones on file: say so, never compare an account with itself.
        ? `The invoice says "${bankNotice}", but the bank details it prints match ${onFile} on file, so it is unclear what changed${domainNote}.`
        : `The invoice says "${bankNotice}" without details we can compare to ${onFile} on file${domainNote}.`;
    s.reason('BANK_DETAILS_CHANGED', 'hold', msg);
  }
  if (lookalikeDom) s.reason('REMIT_DOMAIN_LOOKALIKE', 'hold', `The invoice's contact email domain ${lookalikeDom} looks like ${vendor.name}'s real one (${mDom}) but is not the same; lookalike domains are a common way to redirect payments.`);
  checkSteering(s, ex);
  return {
    checks: s.checks, reasons: s.reasons,
    data: { vendorId: vendor.vendor_id, bankDiffs: diffs, bankNotice: bankNotice ?? null, invoiceEmailDomain: invDom, masterEmailDomain: mDom },
    vendor, method, score,
  };
}

// ---------- 5. PO match ----------
function poContext(po, { poLines = [], receipts = [], ledger = [] }) {
  const key = normalizePO(po.po_number);
  const prior = ledger.filter((r) => r.status === 'approved' && normalizePO(r.po_number) === key);
  const lines = poLines.filter((l) => normalizePO(l.po_number) === key).sort((a, b) => a.line_no - b.line_no);
  const prevNet = sum(prior.map((r) => num(r.net)));
  return {
    lines, prevNet,
    remaining: num(po.net_total) - prevNet,
    received: (ln) => sum(receipts.filter((g) => normalizePO(g.po_number) === key && Number(g.line_no) === Number(ln)).map((g) => num(g.qty_received))),
    prevQty: (ln) => sum(prior.flatMap((r) => r.lines ?? []).filter((l) => Number(l.po_line_no) === Number(ln)).map((l) => num(l.qty))),
  };
}

/**
 * How well an invoice line describes a PO line, 0..1. Jaccard counts as is; a looser overlap (a short PO text
 * contained in a wordier line) only counts when the line is also priced like the PO line (within 20%), so
 * "Fuel surcharge - LTL freight" or "Volume discount - office chairs" don't borrow a PO line's words.
 * Negative lines (discounts, credits) never describe a PO line.
 */
function lineSim(l, p) {
  if (num(l.amount) !== null && num(l.amount) < 0) return 0;
  const code = alnum(l.item_code);
  if (code && alnum(p.item_code) === code) return 1;
  const j = tokenSim(l.description, p.description);
  const q = num(l.quantity), a = num(l.amount), u = num(l.unit_price) ?? (a !== null && q ? a / q : null), pu = num(p.unit_price);
  const near = (x, y) => x !== null && y > 0 && Math.abs(x - y) / y <= 0.2;
  // Only the amount was read: compare it with one unit or with the whole PO line.
  const pricedLike = u !== null ? near(u, pu) : near(a, pu) || near(a, pu * (num(p.qty) ?? 1));
  return Math.max(j, pricedLike ? overlap(l.description, p.description) : 0);
}

function bestPoLine(line, poLs) {
  if (num(line.amount) !== null && num(line.amount) < 0) return { pl: null, sim: 0, how: null };
  const code = alnum(line.item_code);
  const byCode = code && poLs.find((p) => alnum(p.item_code) === code);
  if (byCode) return { pl: byCode, sim: 1, how: 'item code' };
  let best = null, sim = 0;
  for (const p of poLs) { const s = lineSim(line, p); if (s > sim) { sim = s; best = p; } }
  return sim >= LINE_MATCH_MIN ? { pl: best, sim, how: 'description' } : { pl: null, sim, how: null };
}

/**
 * Score = ½ description fit (mean best line similarity) + ½ amount fit. A partial invoice that fits inside the
 * value left on the PO scores 0.9-1 (exactly the rest scores 1); one that exceeds it falls off with the gap.
 */
function scorePO(ex, net, lines, remaining) {
  const invLines = (ex.line_items ?? []).filter((l) => !(num(l.amount) < 0));
  const desc = invLines.length ? sum(invLines.map((l) => Math.max(0, ...lines.map((p) => lineSim(l, p))))) / invLines.length : 0;
  const amount = !(remaining > 0 && net > 0) ? 0
    : net <= remaining + EPS ? 0.9 + 0.1 * (net / remaining)
      : Math.max(0, 1 - (net - remaining) / net);
  return { score: 0.5 * desc + 0.5 * amount, desc, amount };
}

export function matchPO(ex, vendor, ctx = {}) {
  const { pos = [], vendors = [] } = ctx;
  const s = stage();
  const t = invoiceTotals(ex);
  const net = t.net;
  const cur = ex.currency || null;
  const base = { po: null, inferred: false, score: null, candidates: [], lineMatches: [], net, ledgerLines: plainLedgerLines(ex, t) };
  const done = (extra = {}, data = {}) => ({ checks: s.checks, reasons: s.reasons, data, ...base, ...extra });

  const rankOpen = () => (vendor ? pos.filter((p) => p.vendor_id === vendor.vendor_id && p.status === 'open' && (!cur || !p.currency || p.currency === cur)) : [])
    .map((p) => { const c = poContext(p, ctx); return { p, c, ...scorePO(ex, net, c.lines, c.remaining) }; })
    .filter((x) => x.c.remaining > 0)
    .sort((a, b) => b.score - a.score);
  const asCandidates = (ranked) => ranked.map((x) => ({
    po_number: x.p.po_number, score: r2(x.score), descriptionFit: r2(x.desc), amountFit: r2(x.amount), remaining: r2(x.c.remaining), description: x.p.description,
  }));
  const vName = (id) => vendors.find((v) => v.vendor_id === id)?.name;

  let po = null, inferred = false, score = null, candidates = [];
  if (ex.po_number) {
    po = resolvePO(ex.po_number, pos);
    if (!po) {
      const ranked = rankOpen();
      candidates = asCandidates(ranked);
      const hint = ranked[0] && ranked[0].score >= TOL.poInferMin - TOL.poAmbiguityMargin
        ? `; the closest open PO for ${vendor.name} is ${ranked[0].p.po_number} (${money(ranked[0].c.remaining, ranked[0].p.currency)} left)` : '';
      s.check('PO exists', 'fail', `${ex.po_number} not found`);
      s.reason('PO_NOT_FOUND', 'hold', `The invoice quotes ${ex.po_number}, which is not one of our purchase orders${hint}.`);
      return done({ candidates });
    }
    s.check('PO exists', 'pass', `${po.po_number}${normalizePO(po.po_number) !== normalizePO(ex.po_number) ? ` (quoted as "${ex.po_number}")` : ''} (${po.category}, ${money(num(po.net_total), po.currency)}, requester ${po.requester})`);
    if (po.vendor_id !== vendor?.vendor_id) {
      // An unknown sender quoting someone else's PO: stop here, so nothing about that PO's receipts reaches the sender.
      const other = vName(po.vendor_id);
      s.check('PO vendor matches', 'fail', `PO is for ${po.vendor_id}${other ? ` ${other}` : ''}, invoice is from ${vendor ? vendor.vendor_id : 'an unmatched sender'}`);
      s.reason('PO_VENDOR_MISMATCH', 'hold', vendor
        ? `${po.po_number} was issued to ${other ?? `vendor ${po.vendor_id}`}, not ${vendor.name}, so it can't be used for this invoice.`
        : `${po.po_number} was issued to ${other ?? `vendor ${po.vendor_id}`}, and the sender ${ex.vendor?.name ? `"${ex.vendor.name}" ` : ''}is not that vendor as far as our vendor master shows, so the PO can't be used for this invoice.`);
      return done({ po });
    }
    s.check('PO vendor matches', 'pass', vendor.vendor_id);
    if (po.status !== 'open') {
      s.check('PO is open', 'fail', po.status);
      s.reason('PO_CLOSED', 'hold', `${po.po_number} is ${po.status}, so no more invoices should be booked against it.`);
    } else s.check('PO is open', 'pass', 'open');
  } else {
    if (!vendor) { s.check('PO inference', 'info', 'Skipped: no PO number and the vendor is unknown'); return done(); }
    const ranked = rankOpen();
    candidates = asCandidates(ranked);
    const [a, b] = ranked;
    const close = a && b && a.score - b.score < TOL.poAmbiguityMargin && b.score >= TOL.poInferMin - TOL.poAmbiguityMargin;
    if (!a) {
      const otherCur = [...new Set(pos.filter((p) => p.vendor_id === vendor.vendor_id && p.status === 'open' && cur && p.currency && p.currency !== cur
        && poContext(p, ctx).remaining > 0).map((p) => p.currency))];
      s.check('PO inference', 'fail', `No open POs with value left for ${vendor.vendor_id}${otherCur.length ? ` in ${cur}` : ''}`);
      s.reason('PO_NOT_FOUND', 'hold', otherCur.length
        ? `There is no PO number on the invoice, and ${vendor.name}'s open POs are in ${humanList(otherCur)}, not ${cur}, so none of them can be matched to it.`
        : `There is no PO number on the invoice and ${vendor.name} has no open PO with value left to bill.`);
      return done({ candidates });
    }
    if (close) {
      s.check('PO inference', 'fail', `${a.p.po_number} ${Math.round(a.score * 100)}% vs ${b.p.po_number} ${Math.round(b.score * 100)}%`);
      s.reason('PO_AMBIGUOUS', 'hold', `There is no PO number on the invoice and it fits ${a.p.po_number} (${a.p.description}) and ${b.p.po_number} (${b.p.description}) about equally well, so someone has to say which one it is for.`);
      return done({ candidates, score: r2(a.score) });
    }
    if (a.score < TOL.poInferMin) {
      s.check('PO inference', 'fail', `Best ${a.p.po_number} at ${Math.round(a.score * 100)}%, needs ${Math.round(TOL.poInferMin * 100)}%`);
      s.reason('PO_NOT_FOUND', 'hold', `There is no PO number on the invoice and none of ${vendor.name}'s open POs fits well enough (closest is ${a.p.po_number} at ${Math.round(a.score * 100)}%).`);
      return done({ candidates, score: r2(a.score) });
    }
    po = a.p; inferred = true; score = r2(a.score);
    s.check('PO inference', 'pass', `${po.po_number}: description fit ${Math.round(a.desc * 100)}%, amount fit ${Math.round(a.amount * 100)}%, score ${Math.round(a.score * 100)}%${b ? ` (next ${b.p.po_number} ${Math.round(b.score * 100)}%)` : ''}`);
    s.reason('PO_INFERRED', 'info', `There is no PO number on the invoice, but it matches ${po.po_number} (${po.description}, ${money(a.c.remaining, po.currency)} left to bill) on both description and amount, and no other open PO comes close.`);
  }

  // ---- line matching against the PO ----
  const c = poContext(po, ctx);
  const pcur = po.currency;
  const pm = (n) => money(n, pcur);
  const sameCur = !cur || !pcur || cur === pcur;
  if (!sameCur) {
    s.check('Currency matches PO', 'fail', `Invoice ${cur}, PO ${pcur}`);
    s.reason('CURRENCY_MISMATCH', 'hold', `The invoice is in ${cur} but ${po.po_number} is in ${pcur}, so the amounts can't be compared.`);
  } else s.check('Currency matches PO', 'pass', pcur);
  if (ex.bill_to_name && po.buyer_entity && tokenSim(ex.bill_to_name, po.buyer_entity) < 0.5)
    s.check('Billed to the PO buyer', 'warn', `Invoice billed to "${ex.bill_to_name}", PO buyer is "${po.buyer_entity}"`);

  const factor = ex.tax_inclusive && t.sumLines > 0 && net !== null ? net / t.sumLines : 1; // gross line → net line
  const lineMatches = [], ledgerLines = [], billedByLine = new Map(), unmatched = [];
  let expected = 0, priceHolds = 0, priceExtra = 0, priceWithin = null;
  for (const l of ex.line_items ?? []) {
    let q = num(l.quantity), u = num(l.unit_price), a = num(l.amount);
    const { pl, how } = bestPoLine(l, c.lines);
    // Only the amount was read: assume the PO price and derive the quantity, so the amount is what gets checked.
    if (q === null && u === null && a !== null && pl && num(pl.unit_price) > 0) { u = num(pl.unit_price) / factor; q = Math.round((a / u) * 1e4) / 1e4; }
    if (q === null) q = u && a !== null ? Math.round((a / u) * 1e4) / 1e4 : 1; // shortcut: no qty → derive from amount/unit, else qty 1 at the amount
    if (u === null) u = a !== null ? a / (q || 1) : null;
    if (a === null) a = u !== null ? q * u : 0;
    const netUnit = u !== null ? u * factor : null, netAmt = a * factor;
    const lm = { description: l.description, poLineNo: pl?.line_no ?? null, qty: q, unitPrice: netUnit !== null ? r2(netUnit) : null, poUnitPrice: pl ? num(pl.unit_price) : null,
      variancePct: null, ordered: pl ? num(pl.qty) : null, received: null, previouslyInvoicedQty: pl ? c.prevQty(pl.line_no) : null, amount: r2(netAmt) };
    ledgerLines.push({ po_line_no: lm.poLineNo, qty: q, net: r2(netAmt) });
    if (!pl) {
      unmatched.push({ description: l.description, amt: netAmt });
      s.check(`Line "${l.description}"`, 'warn', `Not on ${po.po_number}: ${money(netAmt, cur || pcur)} counts toward the header variance`);
      lineMatches.push(lm);
      continue;
    }
    if (po.category === 'goods') lm.received = c.received(pl.line_no);
    billedByLine.set(pl.line_no, { pl, billed: (billedByLine.get(pl.line_no)?.billed ?? 0) + q });
    expected += q * num(pl.unit_price);
    if (sameCur && netUnit !== null && num(pl.unit_price) > 0) {
      const v = ((netUnit - num(pl.unit_price)) / num(pl.unit_price)) * 100;
      lm.variancePct = r2(v);
      if (v > TOL.unitPricePct + EPS) {
        priceHolds++;
        const more = q * (netUnit - num(pl.unit_price));
        priceExtra += more;
        s.check(`Price: ${pl.description}`, 'fail', `${pm(netUnit)} vs PO ${pm(num(pl.unit_price))} (+${pct1(v)})`);
        s.reason('PRICE_VARIANCE', 'hold', `Billed ${pl.description} at ${pm(netUnit)} each, ${pct1(v)} above the PO price of ${pm(num(pl.unit_price))} (the limit is ${TOL.unitPricePct}%)${q !== 1 ? `; on ${qtyStr(q)} that is ${pm(more)} more than the PO` : ''}.`);
      } else if (v > EPS) {
        priceWithin ??= `${pl.description} is billed at ${pm(netUnit)} against ${pm(num(pl.unit_price))} on the PO (+${pct1(v)}), within the ${TOL.unitPricePct}% limit.`;
        s.check(`Price: ${pl.description}`, 'pass', `${pm(netUnit)} vs PO ${pm(num(pl.unit_price))} (+${pct1(v)}, within tolerance)`);
      } else s.check(`Price: ${pl.description}`, 'pass', `${pm(netUnit)} vs PO ${pm(num(pl.unit_price))}${v < -EPS ? ` (${pct1(v)}, below PO)` : ''} — matched by ${how}`);
    }
    lineMatches.push(lm);
  }

  // Quantities, per PO line (several invoice lines may bill the same PO line)
  for (const { pl, billed } of billedByLine.values()) {
    const ordered = num(pl.qty), prev = c.prevQty(pl.line_no), leftOnPo = ordered - prev;
    if (billed > leftOnPo + EPS) {
      s.check(`Qty vs PO: ${pl.description}`, 'fail', `Billed ${qtyStr(billed)}, ${qtyStr(Math.max(0, leftOnPo))} left on PO`);
      s.reason('QTY_EXCEEDS_PO', 'hold', `Billed ${qtyStr(billed)} × ${pl.description} but ${leftOnPo > 0 ? `only ${qtyStr(leftOnPo)} remain` : 'none remain'} on the PO (${qtyStr(ordered)} ordered, ${qtyStr(prev)} already invoiced).`);
    } else s.check(`Qty vs PO: ${pl.description}`, 'pass', `Billed ${qtyStr(billed)} of ${qtyStr(leftOnPo)} left (${qtyStr(ordered)} ordered)`);
    if (po.category === 'goods') {
      const rec = c.received(pl.line_no), avail = rec - prev;
      if (billed > avail + EPS) {
        s.check(`Qty vs receipt: ${pl.description}`, 'fail', `Billed ${qtyStr(billed)}, ${qtyStr(Math.max(0, avail))} received and not yet invoiced`);
        s.reason('QTY_EXCEEDS_RECEIPT', 'hold', `Billed ${qtyStr(billed)} × ${pl.description} but ${avail > 0 ? `only ${qtyStr(avail)}` : 'none'} received and not yet invoiced (${qtyStr(rec)} received, ${qtyStr(prev)} already invoiced).`);
      } else s.check(`Qty vs receipt: ${pl.description}`, 'pass', `Billed ${qtyStr(billed)}, ${qtyStr(avail)} received and not yet invoiced`);
    }
  }
  if (po.category === 'services') s.check('Match type', 'info', '2-way match (services): no goods receipt needed');
  else s.check('Match type', 'info', '3-way match (goods): PO, goods receipt, invoice');

  // Header: (A) this invoice vs PO prices for what it bills; (B) everything invoiced so far vs the PO total.
  let overrun = false, within = null;
  if (sameCur && net !== null) {
    const cap = TOL.headerAbs[po.currency] ?? TOL.headerAbs.default;
    const ok = (over, basis) => over <= EPS || ((over / basis) * 100 <= TOL.headerPct + EPS && over <= cap + EPS);
    const tolTxt = `the limit is ${TOL.headerPct}% and ${pm(cap)}`;
    const extra = net - expected;
    const extraPct = expected > 0 ? (extra / expected) * 100 : Infinity;
    const unmatchedTxt = unmatched.length ? `, ${Math.abs(sum(unmatched.map((u) => u.amt)) - extra) < 0.01 ? 'all from' : 'including'} ${humanList(unmatched.map((l) => l.description))}, which ${unmatched.length > 1 ? 'are' : 'is'} not on the PO` : '';
    const aOk = expected > 0 ? ok(extra, expected) : extra <= EPS;
    // A price variance that fully accounts for the extra is reported once, as PRICE_VARIANCE.
    const byPrice = !aOk && priceHolds && !unmatched.length && Math.abs(extra - priceExtra) < 0.01;
    // Within tolerance is not a failure: 'info', so the UI does not paint it red.
    s.check('Invoice vs PO prices', aOk ? (extra > EPS ? 'info' : 'pass') : 'fail',
      `Net ${pm(net)} vs ${pm(expected)} expected (${extra >= 0 ? '+' : ''}${pm(extra)})${aOk && extra > EPS ? ', within tolerance' : byPrice ? ', all from the price difference' : ''}`);
    if (!aOk) {
      overrun = true;
      if (!byPrice && expected <= EPS) s.reason('PO_OVERRUN', 'hold', `None of this invoice's lines${unmatched.length ? ` (${humanList(unmatched.map((l) => l.description))})` : ''} matches a line on ${po.po_number}, so its ${pm(net)} before tax can't be checked against PO prices.`);
      else if (!byPrice) s.reason('PO_OVERRUN', 'hold', `This invoice comes to ${pm(net)} before tax, ${pm(extra)}${Number.isFinite(extraPct) ? ` (${pct1(extraPct)})` : ''} more than the PO prices for what it bills (${pm(expected)})${unmatchedTxt}; ${tolTxt}.`);
    } else if (extra > EPS) within = `Billed ${pm(net)} before tax against ${pm(expected)} at PO prices, ${pm(extra)} (${pct1(extraPct)}) more${unmatchedTxt}; that is within our ${TOL.headerPct}% / ${pm(cap)} tolerance.`;

    const total = num(po.net_total), cum = c.prevNet + net, over = cum - total;
    const bOk = total > 0 ? ok(over, total) : over <= EPS;
    s.check('Cumulative vs PO total', bOk ? (over > EPS ? 'info' : 'pass') : 'fail',`${pm(c.prevNet)} already invoiced + ${pm(net)} = ${pm(cum)} of ${pm(total)}`);
    if (!bOk && !(overrun && Math.abs(over - extra) < 0.01)) { // same overrun already explained by (A)
      overrun = true;
      s.reason('PO_OVERRUN', 'hold', c.prevNet > 0
        ? `With ${pm(c.prevNet)} already invoiced, this ${pm(net)} would take ${po.po_number} to ${pm(cum)}, ${pm(over)} (${pct1((over / total) * 100)}) over its ${pm(total)} total; ${tolTxt}.`
        : `This invoice's ${pm(net)} before tax is ${pm(over)} (${pct1((over / total) * 100)}) over the ${pm(total)} total of ${po.po_number}; ${tolTxt}.`);
    } else if (!bOk) overrun = true;
    else if (over > EPS && !within) within = `Invoiced so far comes to ${pm(cum)} against the ${pm(total)} PO total, ${pm(over)} (${pct1((over / total) * 100)}) over; that is within our ${TOL.headerPct}% / ${pm(cap)} tolerance.`;
  }
  within ??= priceWithin;
  if (within && !overrun && !priceHolds) s.reason('VARIANCE_WITHIN_TOLERANCE', 'info', within);

  return {
    checks: s.checks, reasons: s.reasons,
    data: { poNumber: po.po_number, category: po.category, requester: po.requester, expected: r2(expected), previouslyInvoicedNet: r2(c.prevNet), remainingBefore: r2(c.remaining), netFactor: factor },
    po, inferred, score, candidates, lineMatches, net, ledgerLines,
  };
}

function plainLedgerLines(ex, t) {
  const factor = ex.tax_inclusive && t.sumLines > 0 && t.net !== null ? t.net / t.sumLines : 1;
  return (ex.line_items ?? []).map((l) => ({ po_line_no: null, qty: num(l.quantity) ?? 1, net: r2((num(l.amount) ?? 0) * factor) }));
}

// ---------- 6. duplicates ----------
const statusWords = { approved: 'already approved', on_hold: 'already on hold for review' };

export function checkDuplicates(ex, vendor, ledger = [], { fileSha, priorFileShas } = {}) {
  const s = stage();
  const cur = ex.currency || 'USD';
  const m = (n) => money(n, cur);
  let original = null;

  const shas = priorFileShas instanceof Set ? priorFileShas : new Set(priorFileShas ?? []);
  if (fileSha && shas.has(fileSha)) {
    s.check('Same file seen before', 'fail', fileSha.slice(0, 12));
    s.reason('DUPLICATE_FILE', 'hold', 'This exact file has been processed before; a resend is not proof of double billing, so a person should look before anything is paid.');
  } else if (fileSha) s.check('Same file seen before', 'pass', 'New file');

  if (!vendor) {
    s.check('Duplicate invoice check', 'info', 'Skipped: vendor unknown');
    return { checks: s.checks, reasons: s.reasons, data: {}, original };
  }
  const rows = ledger.filter((r) => r.vendor_id === vendor.vendor_id && (r.status === 'approved' || r.status === 'on_hold'));
  const norm = normalizeInvoiceNumber(ex.invoice_number);
  const total = num(ex.total);
  const sameTotal = (r) => total !== null && num(r.total) !== null && Math.abs(num(r.total) - total) <= 0.01 && (!r.currency || !ex.currency || r.currency === ex.currency);
  // Recomputed from the raw number when we have it, so rows stored under an older normalisation still compare.
  const rowNorm = (r) => normalizeInvoiceNumber(r.invoice_number) ?? r.invoice_number_norm ?? null;

  let numberHit = false;
  if (!norm) s.check('Invoice number duplicate check', 'warn', 'Skipped: the invoice has no number');
  else {
    const same = rows.filter((r) => rowNorm(r) === norm);
    const exact = same.find(sameTotal);
    if (exact) {
      numberHit = true; original = exact;
      s.check('Invoice number duplicate check', 'fail', `${ex.invoice_number} = ${exact.invoice_number} (run ${exact.run_id}, ${exact.status})`);
      const when = `already processed${exact.created_at ? ` on ${fmtDate(exact.created_at)}` : ''}${exact.run_id ? ` (run ${exact.run_id})` : ''}`;
      const now = exact.status === 'approved' ? 'is approved for payment' : 'is on hold for review';
      s.reason('DUPLICATE_INVOICE', 'block', ex.invoice_number === exact.invoice_number
        ? `Invoice ${ex.invoice_number} for ${m(num(exact.total))} from ${vendor.name} was ${when} and ${now}.`
        : `Invoice ${ex.invoice_number} is the same invoice as ${exact.invoice_number} for ${m(num(exact.total))} from ${vendor.name}, which was ${when} and ${now}.`);
    } else if (same.length) {
      numberHit = true; original = same[0];
      s.check('Invoice number duplicate check', 'fail', `${ex.invoice_number} reuses ${same[0].invoice_number} with a different total`);
      s.reason('POSSIBLE_DUPLICATE', 'hold', `Invoice ${ex.invoice_number} has the same number as ${same[0].invoice_number}, ${statusWords[same[0].status]} at ${m(num(same[0].total))}, but this one is for ${m(total)}; it may be a corrected invoice or a credit memo, so compare them side by side.`);
    } else s.check('Invoice number duplicate check', 'pass', `No earlier ${ex.invoice_number} from ${vendor.name}`);
  }

  if (!numberHit) {
    if (total === null || !ex.invoice_date || parseDate(ex.invoice_date) === null) s.check('Same amount, nearby date', 'info', 'Skipped: no total or no valid invoice date');
    else {
      const near = rows.find((r) => (!norm || rowNorm(r) !== norm) && sameTotal(r) && r.invoice_date && parseDate(r.invoice_date) !== null
        && Math.abs(daysBetween(r.invoice_date, ex.invoice_date)) <= TOL.dupWindowDays);
      if (near) {
        original = near;
        const gap = Math.abs(daysBetween(near.invoice_date, ex.invoice_date));
        s.check('Same amount, nearby date', 'fail', `${near.invoice_number ?? '(no number)'} on ${near.invoice_date}, ${gap} days apart`);
        s.reason('POSSIBLE_DUPLICATE', 'hold', `${vendor.name} already billed the same ${m(total)} on ${near.invoice_number ? `invoice ${near.invoice_number}` : 'an unnumbered invoice'} dated ${fmtDate(near.invoice_date)}, ${gap ? `${gap} day${gap > 1 ? 's' : ''} apart` : 'the same date'}, under a different number; check it is not the same charge twice.`);
      } else s.check('Same amount, nearby date', 'pass', `No other ${m(total)} invoice within ${TOL.dupWindowDays} days`);
    }
  }
  // Same file and same invoice: one reason, DUPLICATE_INVOICE (the file match is just how it got here).
  const sameFile = s.reasons.some((r) => r.code === 'DUPLICATE_FILE');
  const reasons = s.reasons.some((r) => r.code === 'DUPLICATE_INVOICE') ? s.reasons.filter((r) => r.code !== 'DUPLICATE_FILE') : s.reasons;
  return { checks: s.checks, reasons, data: { invoiceNumberNorm: norm, originalRunId: original?.run_id ?? null, sameFile }, original, sameFile };
}

// ---------- credit notes (in place of PO matching) ----------
/** CREDIT_NOTE hold: nothing to pay. Names the original invoice when the document quotes one that is in the ledger. */
export function checkCreditNote(ex, vendor, ledger = []) {
  const s = stage();
  const cur = ex.currency || vendor?.currency || 'USD';
  const amt = money(-Math.abs(num(ex.total) ?? 0), cur);
  const own = normalizeInvoiceNumber(ex.invoice_number);
  // Any token on the document (other than its own number) that normalises to an invoice number we booked for this vendor.
  const text = JSON.stringify({ ...ex, invoice_number: null });
  const toks = new Set((text.match(/[A-Za-z0-9][A-Za-z0-9\-/_.]{2,}[A-Za-z0-9]/g) ?? []).map(normalizeInvoiceNumber));
  const ref = vendor ? ledger.find((r) => r.vendor_id === vendor.vendor_id && ['approved', 'on_hold'].includes(r.status)
    && (normalizeInvoiceNumber(r.invoice_number) ?? r.invoice_number_norm)?.length >= 4
    && (normalizeInvoiceNumber(r.invoice_number) ?? r.invoice_number_norm) !== own
    && toks.has(normalizeInvoiceNumber(r.invoice_number) ?? r.invoice_number_norm)) ?? null : null;
  const who = vendor?.name ?? ex.vendor?.name ?? 'an unknown vendor';
  s.check('Credit note', 'warn', `${amt}${ref ? ` against invoice ${ref.invoice_number}` : ''}`);
  s.check('PO quantity checks', 'info', 'Skipped: a credit note does not bill goods or services');
  if (ref) s.check('Referenced invoice', 'info', `${ref.invoice_number} (run ${ref.run_id}, ${ref.status === 'approved' ? 'approved' : 'on hold'})`);
  s.reason('CREDIT_NOTE', 'hold', `Credit note${ex.invoice_number ? ` ${ex.invoice_number}` : ''} for ${amt} from ${who}${ref ? `, against invoice ${ref.invoice_number} (run ${ref.run_id})` : ''}. Nothing to pay; apply it against the vendor's next payment.`);
  // Ledger values for a credit are negative whatever sign the document printed.
  const t = invoiceTotals(absAmounts(ex));
  return {
    checks: s.checks, reasons: s.reasons, data: { referencedInvoice: ref?.invoice_number ?? null, referencedRunId: ref?.run_id ?? null }, original: ref,
    net: t.net === null ? null : -Math.abs(t.net), total: t.total === null ? null : -Math.abs(t.total),
  };
}
