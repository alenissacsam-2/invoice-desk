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
    return new Intl.NumberFormat(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur || 'USD' }).format(n);
  } catch { return `${n.toFixed(2)} ${cur}`; }
}

/**
 * Uppercase, keep alphanumerics, strip leading zeros of each digit run.
 * Zeros are stripped per separator-delimited segment first, so INV-2026-0042 == INV-2026-42
 * (zero padding of the sequence part) while INV-1045 != INV-10450.
 */
export function normalizeInvoiceNumber(s) {
  if (s === null || s === undefined) return null;
  const out = String(s).toUpperCase().split(/[^A-Z0-9]+/)
    .map((seg) => seg.replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''))).join('');
  return out || null;
}

export const normalizePO = (s) => alnum(s) || null;

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
export const addDays = (s, d) => new Date(parseDate(s) + d * DAY).toISOString().slice(0, 10);
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

export function validate(ex, { today } = {}) {
  const s = stage();
  const cur = ex?.currency || 'USD';
  const m = (n) => money(n, cur);

  if (!ex || ex.is_invoice === false || (ex.document_type && ex.document_type !== 'invoice')) {
    const what = DOC_TYPE_WORDS[ex?.document_type] ?? 'a document';
    s.check('Document is an invoice', 'fail', `Looks like ${what}`);
    s.reason('NOT_AN_INVOICE', 'block', `This is ${what}, not an invoice, so there is nothing to pay.`);
    return { checks: s.checks, reasons: s.reasons, data: { documentType: ex?.document_type ?? null } };
  }
  s.check('Document is an invoice', 'pass', 'document_type = invoice');

  // Required fields
  const required = [
    ['invoice number', ex.invoice_number], ['invoice date', ex.invoice_date],
    ['vendor name', ex.vendor?.name], ['total', num(ex.total)],
  ];
  const missing = required.filter(([, v]) => v === null || v === undefined || v === '').map(([k]) => k);
  for (const [k, v] of required) s.check(`Has ${k}`, missing.includes(k) ? 'fail' : 'pass', missing.includes(k) ? 'Not on the document' : String(v));
  if (missing.length) {
    const why = missing.includes('invoice number') ? ' and to check it is not a duplicate' : '';
    s.reason('MISSING_FIELD', 'hold', `The invoice shows no ${humanList(missing, 'or')}; we need ${missing.length > 1 ? 'them' : 'it'} to book it${why}.`);
  }

  // Arithmetic
  const t = invoiceTotals(ex);
  const slack = slackFor(cur);
  const lines = ex.line_items ?? [];
  let arithOk = true;
  const mismatch = (label, msg) => { arithOk = false; s.check(label, 'fail', msg); s.reason('ARITHMETIC_MISMATCH', 'hold', msg); };
  lines.forEach((l, i) => {
    const q = num(l.quantity), u = num(l.unit_price), a = num(l.amount);
    if (q === null || u === null || a === null) return;
    if (Math.abs(q * u - a) > slack + EPS)
      mismatch(`Line ${i + 1} arithmetic`, `Line ${i + 1} (${l.description}) says ${qtyStr(q)} × ${m(u)} = ${m(a)}, but that comes to ${m(q * u)}.`);
  });
  const subtotal = num(ex.subtotal);
  if (subtotal !== null && lines.length) {
    // Tax-inclusive invoices may print a gross or a net subtotal; accept either.
    const ok = Math.abs(t.sumLines - subtotal) <= slack + EPS || (ex.tax_inclusive && Math.abs(t.sumLines - t.tax - subtotal) <= slack + EPS);
    if (ok) s.check('Lines add up to subtotal', 'pass', `${m(t.sumLines)}`);
    else mismatch('Lines add up to subtotal', `The lines add up to ${m(t.sumLines)}, but the subtotal says ${m(subtotal)}.`);
  }
  const taxLines = ex.tax_lines ?? [];
  if (taxLines.length && num(ex.tax_total) !== null) {
    const st = sum(taxLines.map((x) => num(x.amount)));
    if (Math.abs(st - num(ex.tax_total)) > slack + EPS)
      mismatch('Tax lines add up to tax total', `The tax lines add up to ${m(st)}, but the tax total says ${m(num(ex.tax_total))}.`);
  }
  if (t.total !== null) {
    const expected = ex.tax_inclusive ? (subtotal !== null && Math.abs(subtotal - t.sumLines) > slack ? subtotal + t.tax : t.sumLines) + t.shipping
      : (subtotal ?? t.sumLines) + t.tax + t.shipping;
    if (lines.length || subtotal !== null) {
      if (Math.abs(expected - t.total) <= slack + EPS) s.check('Total adds up', 'pass', `${m(t.total)}`);
      else mismatch('Total adds up', ex.tax_inclusive
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
    if (ex.tax_inclusive) {
      const gross = t.total ?? t.sumLines;
      const exp = (gross * rate) / (100 + sumRates);
      if (Math.abs(exp - amt) <= slack + EPS) s.check(`${label} rate`, 'pass', `${rate}% included in ${m(gross)} = ${m(exp)}`);
      else mismatch(`${label} rate`, `${label} at ${rate}% included in ${m(gross)} should be about ${m(exp)}, but the invoice shows ${m(amt)}.`);
    } else {
      const exp = (base * rate) / 100, expShip = ((base + t.shipping) * rate) / 100; // shipping is taxable in some places
      if (Math.abs(exp - amt) <= slack + EPS || (t.shipping && Math.abs(expShip - amt) <= slack + EPS))
        s.check(`${label} rate`, 'pass', `${rate}% of ${m(base)} = ${m(r2(exp))}`);
      else mismatch(`${label} rate`, `${label} at ${rate}% of ${m(base)} should be ${m(exp)}, but the invoice shows ${m(amt)}.`);
    }
  }
  if (arithOk && lines.length) s.check('Arithmetic', 'pass', `All amounts agree within ${m(slack)}`);
  if (ex.tax_inclusive) {
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
      s.reason('DATE_OUT_OF_RANGE', 'hold', `The invoice is dated ${d}, which is in the future (today is ${today}).`);
    } else if (today && daysBetween(d, today) > TOL.maxAgeDays) {
      s.check('Invoice date within a year', 'fail', `${daysBetween(d, today)} days old`);
      s.reason('DATE_OUT_OF_RANGE', 'hold', `The invoice is dated ${d}, ${daysBetween(d, today)} days ago, which is past our ${TOL.maxAgeDays}-day limit.`);
    } else s.check('Invoice date in range', 'pass', today ? `${d} (${daysBetween(d, today)} days ago)` : d);
    if (ex.due_date && parseDate(ex.due_date) !== null && parseDate(d) !== null && daysBetween(d, ex.due_date) < 0)
      s.check('Due date after invoice date', 'warn', `Due ${ex.due_date} is before the invoice date ${d}`);
  }

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

  // Tax ID format for the vendor's country (inferred from the invoice currency, since the vendor is not matched yet)
  const rawTid = ex.vendor?.tax_id;
  const country = cur === 'USD' ? 'US' : cur === 'INR' ? 'IN' : null;
  if (!rawTid) s.check('Tax ID format', 'info', 'No tax ID on the invoice');
  else if (!country) s.check('Tax ID format', 'info', `${rawTid} (format not checked for ${cur})`);
  else {
    const tid = String(rawTid).trim().toUpperCase().replace(/\s+/g, '');
    const ok = country === 'US' ? EIN_RE.test(tid) : GSTIN_RE.test(tid);
    const kind = country === 'US' ? 'US EIN (NN-NNNNNNN)' : 'Indian GSTIN (15 characters, like 29AABCS1234F1Z5)';
    s.check('Tax ID format', ok ? 'pass' : 'fail', `${rawTid}${ok ? '' : ` is not a valid ${kind}`}`);
    if (!ok) s.reason('TAX_ID_INVALID', 'hold', `The tax ID "${rawTid}" on the invoice is not a valid ${kind}.`);
  }

  if (ex.notices?.length) s.check('Notices on the document', 'info', ex.notices.join(' | '));
  return { checks: s.checks, reasons: s.reasons, data: { ...t, slack, missing } };
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
const domainOf = (email) => String(email ?? '').toLowerCase().split('@')[1] || null;
const domainCore = (d) => String(d ?? '').split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');

export function matchVendor(ex, vendors = []) {
  const s = stage();
  const name = ex?.vendor?.name ?? null;
  const tid = alnum(ex?.vendor?.tax_id);
  let vendor = null, method = null, score = 0;

  if (tid) {
    vendor = vendors.find((v) => alnum(v.tax_id) === tid) ?? null;
    if (vendor) {
      method = 'tax_id'; score = 1;
      s.check('Tax ID on file', 'pass', `${ex.vendor.tax_id} → ${vendor.vendor_id} ${vendor.name}`);
      if (name && nameScore(name, vendor) < NAME_MATCH_MIN)
        s.check('Name matches master', 'warn', `Invoice says "${name}", master says "${vendor.name}" (trading name?)`);
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
      if (tid && alnum(vendor.tax_id) && alnum(vendor.tax_id) !== tid)
        s.reason('VENDOR_UNKNOWN', 'hold', `The name matches ${vendor.name}, but the tax ID on the invoice (${ex.vendor.tax_id}) is not the one on file (${vendor.tax_id}), so we can't be sure who sent it.`);
    } else score = best ? r2(best.sc) : 0;
  }
  if (!vendor) {
    s.check('Vendor in master', 'fail', name ? `No match for "${name}"` : 'No vendor name or tax ID');
    s.reason('VENDOR_UNKNOWN', 'hold', `${name ? `"${name}"` : 'The sender'} is not in our vendor master (no tax ID or name match), so it must be identified or set up before we can pay it.`);
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
  const mAcct = digitsOnly(vendor.bank_account), mRout = alnum(vendor.bank_routing);
  const diffs = [];
  const invAcctRaw = String(bd.account_number ?? '');
  const invAcct = digitsOnly(invAcctRaw);
  if (invAcct) {
    const masked = /[*xX•#]/.test(invAcctRaw); // "****2233" style: compare only the visible tail
    const same = mAcct && (masked ? mAcct.endsWith(invAcct) : invAcct === mAcct);
    s.check('Bank account matches master', same ? 'pass' : 'fail', `Invoice …${last4(invAcct)}, master ${mAcct ? `…${last4(mAcct)}` : 'none on file'}`);
    if (!same) diffs.push('account');
  }
  const invRout = alnum(bd.routing_code);
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
  const bankNotice = (ex.notices ?? []).find((n) => /bank|account|remit|payment details/i.test(n) && /chang|new|updat|moved|switch/i.test(n));
  if (bankNotice) s.check('Bank change notice', 'fail', bankNotice);

  const invDom = domainOf(ex.vendor?.email), mDom = domainOf(vendor.remit_email);
  let domainNote = '';
  if (invDom && mDom && invDom !== mDom) {
    const lookalike = domainCore(invDom) === domainCore(mDom) || tokenSim(domainCore(invDom), domainCore(mDom)) > 0;
    s.check('Contact email domain', 'warn', `${invDom} differs from ${mDom} on file${lookalike ? ' (lookalike)' : ''}`);
    domainNote = `, and the invoice's contact email domain (${invDom}) is ${lookalike ? 'a lookalike of' : 'not'} the one on file (${mDom})`;
  } else if (invDom && mDom) s.check('Contact email domain', 'pass', invDom);
  if (ex.vendor?.phone && vendor.phone && digitsOnly(ex.vendor.phone) !== digitsOnly(vendor.phone))
    s.check('Phone matches master', 'warn', `Invoice ${ex.vendor.phone}, master ${vendor.phone}: call back on the master number only`);

  if (diffs.length || bankNotice) {
    const onFile = mAcct ? `${vendor.bank_name} account ending ${last4(mAcct)}` : 'no bank account';
    const asked = invAcct || invRout || bd.iban
      ? `${bd.bank_name || 'a different bank'}${invAcct ? ` account ending ${last4(invAcct)}` : ''}${invRout ? ` (routing ${bd.routing_code})` : ''}${bd.iban && !invAcct ? ` IBAN ${bd.iban}` : ''}`
      : null;
    const msg = asked
      ? `The invoice asks us to pay ${asked}, but our vendor master has ${onFile} for ${vendor.name}${domainNote}.`
      : `The invoice says "${bankNotice}" without details we can compare to ${onFile} on file${domainNote}.`;
    s.reason('BANK_DETAILS_CHANGED', 'hold', msg);
  }
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

function bestPoLine(line, poLs) {
  const code = alnum(line.item_code);
  const byCode = code && poLs.find((p) => alnum(p.item_code) === code);
  if (byCode) return { pl: byCode, sim: 1, how: 'item code' };
  let best = null, sim = 0;
  for (const p of poLs) { const s = Math.max(tokenSim(line.description, p.description), overlap(line.description, p.description)); if (s > sim) { sim = s; best = p; } }
  return sim >= LINE_MATCH_MIN ? { pl: best, sim, how: 'description' } : { pl: null, sim, how: null };
}

/** Score = ½ description fit (mean best line similarity) + ½ amount fit (invoice net vs value left on the PO). */
function scorePO(ex, net, lines, remaining) {
  const invLines = ex.line_items ?? [];
  const desc = invLines.length ? sum(invLines.map((l) => {
    const code = alnum(l.item_code);
    if (code && lines.some((p) => alnum(p.item_code) === code)) return 1;
    return Math.max(0, ...lines.map((p) => Math.max(tokenSim(l.description, p.description), overlap(l.description, p.description))));
  })) / invLines.length : 0;
  const amount = remaining > 0 && net > 0 ? Math.max(0, 1 - Math.abs(net - remaining) / Math.max(net, remaining)) : 0;
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
    po = pos.find((p) => normalizePO(p.po_number) === normalizePO(ex.po_number)) ?? null;
    if (!po) {
      const ranked = rankOpen();
      candidates = asCandidates(ranked);
      const hint = ranked[0] && ranked[0].score >= TOL.poInferMin - TOL.poAmbiguityMargin
        ? `; the closest open PO for ${vendor.name} is ${ranked[0].p.po_number} (${money(ranked[0].c.remaining, ranked[0].p.currency)} left)` : '';
      s.check('PO exists', 'fail', `${ex.po_number} not found`);
      s.reason('PO_NOT_FOUND', 'hold', `The invoice quotes ${ex.po_number}, which is not one of our purchase orders${hint}.`);
      return done({ candidates });
    }
    s.check('PO exists', 'pass', `${po.po_number} (${po.category}, ${money(num(po.net_total), po.currency)}, requester ${po.requester})`);
    if (vendor && po.vendor_id !== vendor.vendor_id) {
      const other = vName(po.vendor_id);
      s.check('PO vendor matches', 'fail', `PO is for ${po.vendor_id}${other ? ` ${other}` : ''}, invoice is from ${vendor.vendor_id}`);
      s.reason('PO_VENDOR_MISMATCH', 'hold', `${po.po_number} was issued to ${other ?? `vendor ${po.vendor_id}`}, not ${vendor.name}, so it can't be used for this invoice.`);
      return done({ po });
    }
    if (vendor) s.check('PO vendor matches', 'pass', vendor.vendor_id);
    else s.check('PO vendor', 'info', `PO belongs to ${po.vendor_id}${vName(po.vendor_id) ? ` ${vName(po.vendor_id)}` : ''}; the sender is not matched`);
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
      s.check('PO inference', 'fail', `No open POs with value left for ${vendor.vendor_id}`);
      s.reason('PO_NOT_FOUND', 'hold', `There is no PO number on the invoice and ${vendor.name} has no open PO with value left to bill.`);
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
  let expected = 0, priceHolds = 0, priceWithin = null;
  for (const l of ex.line_items ?? []) {
    let q = num(l.quantity), u = num(l.unit_price), a = num(l.amount);
    if (q === null) q = u && a !== null ? Math.round((a / u) * 1e4) / 1e4 : 1; // shortcut: no qty → derive from amount/unit, else qty 1 at the amount
    if (u === null) u = a !== null ? a / (q || 1) : null;
    if (a === null) a = u !== null ? q * u : 0;
    const netUnit = u !== null ? u * factor : null, netAmt = a * factor;
    const { pl, how } = bestPoLine(l, c.lines);
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
        s.check(`Price: ${pl.description}`, 'fail', `${pm(netUnit)} vs PO ${pm(num(pl.unit_price))} (+${pct1(v)})`);
        s.reason('PRICE_VARIANCE', 'hold', `Billed ${pl.description} at ${pm(netUnit)} each, ${pct1(v)} above the PO price of ${pm(num(pl.unit_price))} (the limit is ${TOL.unitPricePct}%).`);
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
    s.check('Invoice vs PO prices', aOk ? 'pass' : 'fail', `Net ${pm(net)} vs ${pm(expected)} expected (${extra >= 0 ? '+' : ''}${pm(extra)})`);
    if (!aOk) {
      overrun = true;
      s.reason('PO_OVERRUN', 'hold', `This invoice comes to ${pm(net)} before tax, ${pm(extra)}${Number.isFinite(extraPct) ? ` (${pct1(extraPct)})` : ''} more than the PO prices for what it bills (${pm(expected)})${unmatchedTxt}; ${tolTxt}.`);
    } else if (extra > EPS) within = `Billed ${pm(net)} before tax against ${pm(expected)} at PO prices, ${pm(extra)} (${pct1(extraPct)}) more${unmatchedTxt}; that is within our ${TOL.headerPct}% / ${pm(cap)} tolerance.`;

    const total = num(po.net_total), cum = c.prevNet + net, over = cum - total;
    const bOk = total > 0 ? ok(over, total) : over <= EPS;
    s.check('Cumulative vs PO total', bOk ? 'pass' : 'fail', `${pm(c.prevNet)} already invoiced + ${pm(net)} = ${pm(cum)} of ${pm(total)}`);
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
  const rowNorm = (r) => r.invoice_number_norm ?? normalizeInvoiceNumber(r.invoice_number);

  let numberHit = false;
  if (!norm) s.check('Invoice number duplicate check', 'warn', 'Skipped: the invoice has no number');
  else {
    const same = rows.filter((r) => rowNorm(r) === norm);
    const exact = same.find(sameTotal);
    if (exact) {
      numberHit = true; original = exact;
      s.check('Invoice number duplicate check', 'fail', `${ex.invoice_number} = ${exact.invoice_number} (run ${exact.run_id}, ${exact.status})`);
      s.reason('DUPLICATE_INVOICE', 'block', `Invoice ${ex.invoice_number} is the same invoice as ${exact.invoice_number} for ${m(num(exact.total))}, ${statusWords[exact.status]} for ${vendor.name}.`);
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
        s.reason('POSSIBLE_DUPLICATE', 'hold', `${vendor.name} already billed the same ${m(total)} on ${near.invoice_number ? `invoice ${near.invoice_number}` : 'an unnumbered invoice'} dated ${near.invoice_date}, ${gap} days apart, under a different number; check it is not the same charge twice.`);
      } else s.check('Same amount, nearby date', 'pass', `No other ${m(total)} invoice within ${TOL.dupWindowDays} days`);
    }
  }
  return { checks: s.checks, reasons: s.reasons, data: { invoiceNumberNorm: norm, originalRunId: original?.run_id ?? null }, original };
}
