import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_TODAY ??= '2026-11-10';
const { today } = await import('../src/config.js');
const { validate, matchVendor, matchPO, checkDuplicates, normalizeInvoiceNumber, normalizePO, tokenSim, digitsOnly } = await import('../src/rules.js');
const { decide } = await import('../src/decide.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = today();

// Tiny CSV reader for the tests (db.js owns the real loader): quoted fields with "" escapes.
function csv(file) {
  const text = fs.readFileSync(path.join(root, 'data', file), 'utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(Boolean)) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some(Boolean)) rows.push(row);
  const [h, ...body] = rows;
  const NUM = new Set(['qty', 'unit_price', 'net_total', 'qty_received', 'line_no', 'payment_terms_days']);
  return body.map((r) => Object.fromEntries(h.map((k, j) => [k, NUM.has(k) && r[j] !== '' ? Number(r[j]) : r[j] ?? ''])));
}
const master = {
  vendors: csv('vendors.csv').map((v) => ({ ...v, aliases: v.aliases.split(';').filter(Boolean) })),
  pos: csv('purchase_orders.csv'),
  poLines: csv('po_lines.csv'),
  receipts: csv('goods_receipts.csv'),
};
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', `${name}.json`), 'utf8'));

/** Full rules pipeline for one extraction against an in-memory ledger. */
function run(ex, ledger, { runId = 'r', fileSha, priorFileShas = [], m = master } = {}) {
  const v = validate(ex, { today: TODAY });
  if (v.reasons.some((r) => r.code === 'NOT_AN_INVOICE')) return { result: decide({ ex, reasons: v.reasons, today: TODAY }), v };
  const mv = matchVendor(ex, m.vendors);
  const mp = matchPO(ex, mv.vendor, { ...m, ledger });
  const dup = checkDuplicates(ex, mv.vendor, ledger, { fileSha, priorFileShas });
  const reasons = [...v.reasons, ...mv.reasons, ...mp.reasons, ...dup.reasons];
  const result = decide({ ex, vendor: mv.vendor, po: mp.po, reasons, today: TODAY, inferred: mp.inferred, original: dup.original });
  const row = {
    run_id: runId, vendor_id: mv.vendor?.vendor_id ?? null, invoice_number: ex.invoice_number, invoice_number_norm: normalizeInvoiceNumber(ex.invoice_number),
    invoice_date: ex.invoice_date, net: mp.net, total: ex.total, currency: ex.currency, po_number: mp.po?.po_number ?? ex.po_number, lines: mp.ledgerLines,
  };
  return { result, v, mv, mp, dup, row, codes: reasons.map((r) => r.code) };
}

// ---------- demo sequence ----------
const EXPECT = {
  '01_acme_happy': { decision: 'APPROVE', codes: [] },
  '02_brightline_fuel_surcharge': { decision: 'APPROVE', codes: ['VARIANCE_WITHIN_TOLERANCE'] },
  '03_peakvalley_scanned_no_po': { decision: 'APPROVE', codes: ['PO_INFERRED'] },
  '04_northstar_split_1of2': { decision: 'APPROVE', codes: [] },
  '05_northstar_split_2of2': { decision: 'REVIEW', codes: ['QTY_EXCEEDS_RECEIPT'], route: 'Receiving' },
  '06_acme_duplicate_resend': { decision: 'REJECT', codes: ['DUPLICATE_INVOICE'], route: 'AP clerk' },
  '07_kestrel_bank_change': { decision: 'REVIEW', codes: ['BANK_DETAILS_CHANGED'], route: 'Treasury & Security' },
  '08_lumen_missing_fields': { decision: 'REVIEW', codes: ['MISSING_FIELD'], route: 'AP clerk' },
  '09_sharma_gst_inr': { decision: 'APPROVE', codes: [] },
};

test('demo sequence over the 9 sample fixtures', async (t) => {
  const ledger = [];
  const seen = [];
  const out = {};
  for (const [name, exp] of Object.entries(EXPECT)) {
    await t.test(name, () => {
      const r = run(fixture(name), ledger, { runId: name.slice(0, 2), fileSha: name, priorFileShas: seen });
      seen.push(name);
      out[name] = r;
      assert.equal(r.result.decision, exp.decision, `${name}: ${r.result.headline}\n${r.result.reasons.map((x) => `${x.code}: ${x.message}`).join('\n')}`);
      for (const c of exp.codes) assert.ok(r.codes.includes(c), `${name} should include ${c}; got ${r.codes.join(', ')}`);
      if (exp.decision === 'APPROVE') {
        assert.deepEqual(r.codes.filter((c) => !['VARIANCE_WITHIN_TOLERANCE', 'PO_INFERRED', 'TAX_INCLUSIVE'].includes(c)), []);
        assert.equal(r.result.route, null);
        assert.ok(r.result.payment && r.result.payment.amount === r.row.total);
      } else assert.equal(r.result.payment, null);
      if (exp.route) assert.equal(r.result.route, exp.route);
      const n = r.result.explanation.split(/(?<=[.!?])\s+/).length;
      assert.ok(n >= 2 && n <= 4, `${name}: explanation has ${n} sentences: ${r.result.explanation}`);
      if (r.result.decision === 'APPROVE') ledger.push({ ...r.row, status: 'approved' });
      if (r.result.decision === 'REVIEW') ledger.push({ ...r.row, status: 'on_hold' });
    });
  }

  await t.test('scenario details', () => {
    const r1 = out['01_acme_happy'];
    assert.equal(r1.mv.method, 'tax_id');
    assert.deepEqual(r1.result.payment, { amount: 4111.07, currency: 'USD', scheduledFor: '2026-11-27' });

    const r3 = out['03_peakvalley_scanned_no_po'];
    assert.equal(r3.mp.po.po_number, 'PO-2026-0377');
    assert.equal(r3.mp.inferred, true);
    assert.ok(r3.mp.score >= 0.85);
    assert.equal(r3.mp.candidates[1].po_number, 'PO-2026-0378');
    assert.match(r3.result.vendorEmail.subject, /PO-2026-0377/);
    assert.equal(r3.result.payment.scheduledFor, '2026-11-15'); // no due date printed: 2026-10-31 + 15 days terms

    const r5 = out['05_northstar_split_2of2'];
    const laptop = r5.mp.lineMatches.find((l) => l.poLineNo === 1);
    assert.deepEqual([laptop.ordered, laptop.received, laptop.previouslyInvoicedQty, laptop.qty], [10, 8, 6, 4]);
    assert.ok(r5.result.reasons.some((x) => x.message === 'Billed 4 × Laptop 14" Pro 32GB/1TB but only 2 received and not yet invoiced (8 received, 6 already invoiced).'));
    assert.ok(r5.result.reasons.some((x) => /none received and not yet invoiced \(6 received, 6 already invoiced\)/.test(x.message)));
    assert.ok(!r5.codes.includes('QTY_EXCEEDS_PO'), '4 + 6 = 10 ordered, so the PO itself is not exceeded');
    assert.match(r5.result.vendorEmail.body, /credit note/);

    const r6 = out['06_acme_duplicate_resend'];
    assert.equal(r6.dup.original.run_id, '01');
    assert.match(r6.result.headline, /^Reject/);
    assert.match(r6.result.vendorEmail.subject, /already received/);

    const r7 = out['07_kestrel_bank_change'];
    assert.equal(r7.result.vendorEmail.to, 'ap@kestrelsupply.com');
    assert.match(r7.result.vendorEmail.body, /\(510\) 555-0199/);
    assert.doesNotMatch(JSON.stringify(r7.result.vendorEmail), /kestrel-supply\.co/);
    assert.match(r7.result.explanation, /Kestrel Industrial Supply/);
    assert.match(r7.result.explanation, /PO-2026-0405/);
    assert.match(r7.result.explanation, /\$15,765\.05/);
    assert.ok(r7.mv.checks.some((c) => c.label === 'Contact email domain' && c.status === 'warn'));

    const r8 = out['08_lumen_missing_fields'];
    assert.equal(r8.result.vendorEmail.to, 'hello@lumenprint.co');
    assert.match(r8.result.vendorEmail.body, /an invoice number and an invoice date/);
    assert.ok(r8.dup.checks.some((c) => c.status === 'warn' && /no number/.test(c.detail)));

    const r9 = out['09_sharma_gst_inr'];
    assert.equal(r9.mv.method, 'tax_id');
    assert.equal(r9.mp.net, 99000);
    assert.match(r9.result.explanation, /₹1,16,820\.00/);
  });
});

// ---------- focused unit tests ----------
test('invoice number normalisation', () => {
  const n = normalizeInvoiceNumber;
  assert.equal(n('ACM-INV-10458'), n('ACM INV 010458'));
  assert.equal(n('ACM-INV-10458'), n('acm-inv-0010458'));
  assert.notEqual(n('INV-1045'), n('INV-10450'));
  assert.equal(n('INV-2026-0042'), n('INV-2026-42'));
  assert.equal(n('INV-000'), 'INV0');
  assert.equal(n(null), null);
  assert.equal(normalizePO(' po 2026-0412 '), 'PO20260412');
  assert.equal(digitsOnly('(510) 555-0142'), '5105550142');
  assert.equal(tokenSim('Office cleaning — October', 'office CLEANING october'), 1);
  assert.equal(tokenSim('', 'x'), 0);
});

// Synthetic world for edge cases: one big PO and one small PO for a test vendor.
const V = { vendor_id: 'VT1', name: 'Testco Industrial Inc', aliases: [], tax_id: '12-3456789', country: 'US', currency: 'USD', bank_name: 'Test Bank',
  bank_account: '1111222233', bank_routing: '021000021', remit_email: 'ar@testco.com', phone: '(555) 555-0100', status: 'active', payment_terms_days: 30 };
const world = (over = {}) => ({
  vendors: [V, { ...V, vendor_id: 'VT2', name: 'Blocked Widgets LLC', tax_id: '98-7654321', status: 'blocked' }],
  pos: [
    { po_number: 'PO-T-1', vendor_id: 'VT1', buyer_entity: 'Halden Robotics, Inc.', issue_date: '2026-10-01', currency: 'USD', net_total: 100, category: 'goods', requester: 'Tess', status: 'open', description: 'Widgets' },
    { po_number: 'PO-T-BIG', vendor_id: 'VT1', buyer_entity: 'Halden Robotics, Inc.', issue_date: '2026-10-01', currency: 'USD', net_total: 10000, category: 'services', requester: 'Tess', status: 'open', description: 'Consulting' },
  ],
  poLines: [
    { po_number: 'PO-T-1', line_no: 1, item_code: 'WID-1', description: 'Blue widget', qty: 1, unit_price: 100, uom: 'ea' },
    { po_number: 'PO-T-BIG', line_no: 1, item_code: 'CONS', description: 'Consulting retainer', qty: 1, unit_price: 10000, uom: 'job' },
  ],
  receipts: [{ grn_number: 'G1', po_number: 'PO-T-1', line_no: 1, qty_received: 1, received_date: '2026-10-05' }],
  ...over,
});
const inv = (o = {}) => ({
  is_invoice: true, document_type: 'invoice', vendor: { name: 'Testco Industrial Inc', tax_id: '12-3456789', address: null, email: 'ar@testco.com', phone: null },
  bill_to_name: 'Halden Robotics, Inc.', invoice_number: 'T-1', invoice_date: '2026-11-01', due_date: null, po_number: 'PO-T-1', currency: 'USD', payment_terms: null,
  line_items: [{ description: 'Blue widget', item_code: 'WID-1', quantity: 1, unit_price: 100, amount: 100 }],
  subtotal: 100, tax_lines: [], tax_total: null, tax_inclusive: false, shipping: null, total: 100, bank_details: null, notices: [],
  source_quality: { kind: 'digital_text', legibility: 'high' }, confidence: { vendor_name: 0.99, invoice_number: 0.99, invoice_date: 0.99, po_number: 0.99, total: 0.99 }, ...o,
});
const atPrice = (p, o = {}) => inv({ line_items: [{ description: 'Blue widget', item_code: 'WID-1', quantity: 1, unit_price: p, amount: p }], subtotal: p, total: p, ...o });

test('unit price tolerance boundaries: exactly 2% passes, 2.01% holds', () => {
  // Use a cheap PO so the header $100 cap doesn't interfere: 2% of $100 = $2.
  const ok = run(atPrice(102), [], { m: world() });
  assert.equal(ok.result.decision, 'APPROVE', ok.codes.join());
  assert.ok(ok.codes.includes('VARIANCE_WITHIN_TOLERANCE'));
  const bad = run(atPrice(102.01), [], { m: world() });
  assert.equal(bad.result.decision, 'REVIEW');
  assert.ok(bad.codes.includes('PRICE_VARIANCE'));
  assert.equal(bad.result.route, 'Procurement');
  assert.match(bad.result.reasons.find((r) => r.code === 'PRICE_VARIANCE').message, /2\.01% above the PO price of \$100\.00/);
  // Real-world float: 42.50 × 1.02 = 43.35 must count as exactly 2%.
  const w = world({ poLines: [{ po_number: 'PO-T-1', line_no: 1, item_code: 'WID-1', description: 'Blue widget', qty: 1, unit_price: 42.5, uom: 'ea' }], pos: [{ ...world().pos[0], net_total: 42.5 }] });
  assert.ok(!run(atPrice(43.35), [], { m: w }).codes.includes('PRICE_VARIANCE'));
});

test('header tolerance: $101 over a $10,000 PO holds even though it is only 1.01%', () => {
  const big = (extra) => inv({ po_number: 'PO-T-BIG', line_items: [
    { description: 'Consulting retainer', item_code: 'CONS', quantity: 1, unit_price: 10000, amount: 10000 },
    { description: 'Travel expenses', item_code: null, quantity: null, unit_price: null, amount: extra },
  ], subtotal: 10000 + extra, total: 10000 + extra });
  const over = run(big(101), [], { m: world() });
  assert.equal(over.result.decision, 'REVIEW');
  assert.ok(over.codes.includes('PO_OVERRUN'), over.codes.join());
  assert.match(over.result.reasons.find((r) => r.code === 'PO_OVERRUN').message, /\$101\.00 \(1\.01%\)/);
  const within = run(big(100), [], { m: world() });
  assert.equal(within.result.decision, 'APPROVE', within.codes.join());
  assert.ok(within.codes.includes('VARIANCE_WITHIN_TOLERANCE'));
});

test('cumulative overrun across invoices on the same PO', () => {
  const m = world();
  const first = run(inv({ po_number: 'PO-T-BIG', invoice_number: 'B-1', line_items: [{ description: 'Consulting retainer', item_code: 'CONS', quantity: 0.6, unit_price: 10000, amount: 6000 }], subtotal: 6000, total: 6000 }), [], { m });
  assert.equal(first.result.decision, 'APPROVE', first.codes.join());
  const ledger = [{ ...first.row, status: 'approved' }];
  const second = run(inv({ po_number: 'PO-T-BIG', invoice_number: 'B-2', line_items: [{ description: 'Consulting retainer', item_code: 'CONS', quantity: 0.6, unit_price: 10000, amount: 6000 }], subtotal: 6000, total: 6000 }), ledger, { m });
  assert.ok(second.codes.includes('PO_OVERRUN') && second.codes.includes('QTY_EXCEEDS_PO'), second.codes.join());
  assert.match(second.result.reasons.find((r) => r.code === 'PO_OVERRUN').message, /already invoiced/);
});

test('PO inference: unique fit, ambiguous, and nothing fits', () => {
  const twin = world({
    pos: [
      { ...world().pos[0], po_number: 'PO-A', net_total: 500, category: 'services' },
      { ...world().pos[0], po_number: 'PO-B', net_total: 500, category: 'services' },
    ],
    poLines: [
      { po_number: 'PO-A', line_no: 1, item_code: '', description: 'Monthly gardening service', qty: 1, unit_price: 500, uom: 'mo' },
      { po_number: 'PO-B', line_no: 1, item_code: '', description: 'Monthly gardening service', qty: 1, unit_price: 500, uom: 'mo' },
    ],
    receipts: [],
  });
  const ex = inv({ po_number: null, line_items: [{ description: 'Monthly gardening service', item_code: null, quantity: 1, unit_price: 500, amount: 500 }], subtotal: 500, total: 500 });
  const amb = run(ex, [], { m: twin });
  assert.equal(amb.result.decision, 'REVIEW');
  assert.ok(amb.codes.includes('PO_AMBIGUOUS'));
  assert.equal(amb.mp.po, null);
  assert.equal(amb.mp.candidates.length, 2);
  assert.equal(amb.result.route, 'Procurement');

  const one = run(ex, [], { m: { ...twin, pos: [twin.pos[0]] } });
  assert.ok(one.codes.includes('PO_INFERRED'));
  assert.equal(one.result.decision, 'APPROVE');

  const none = run(inv({ po_number: null, line_items: [{ description: 'Snow removal', item_code: null, quantity: 1, unit_price: 90, amount: 90 }], subtotal: 90, total: 90 }), [], { m: { ...twin, pos: [twin.pos[0]] } });
  assert.ok(none.codes.includes('PO_NOT_FOUND'), none.codes.join());
});

test('blocked vendor rejects; unknown vendor holds for Procurement', () => {
  const blocked = run(inv({ vendor: { name: 'Blocked Widgets LLC', tax_id: '98-7654321', email: null, phone: null, address: null } }), [], { m: world() });
  assert.equal(blocked.result.decision, 'REJECT');
  assert.ok(blocked.codes.includes('VENDOR_BLOCKED'));
  assert.equal(blocked.result.route, 'Procurement');
  assert.equal(blocked.result.vendorEmail, null);

  // Real master: V008 Globex is blocked, matched by name alone
  const globex = run(inv({ vendor: { name: 'Globex Trading Company', tax_id: null, email: null, phone: null, address: null }, po_number: null }), []);
  assert.equal(globex.mv.vendor.vendor_id, 'V008');
  assert.equal(globex.mv.method, 'name');
  assert.equal(globex.result.decision, 'REJECT');

  const unknown = run(inv({ vendor: { name: 'Totally New Supplier GmbH', tax_id: '55-5555555', email: 'x@new.example', phone: null, address: null } }), [], { m: world() });
  assert.equal(unknown.result.decision, 'REVIEW');
  assert.ok(unknown.codes.includes('VENDOR_UNKNOWN'));
  assert.equal(unknown.result.route, 'Procurement');

  // Name matches but the tax ID on the invoice belongs to nobody on file → don't trust the name
  const imposter = run(inv({ vendor: { name: 'Testco Industrial', tax_id: '11-1111111', email: null, phone: null, address: null } }), [], { m: world() });
  assert.ok(imposter.codes.includes('VENDOR_UNKNOWN'), imposter.codes.join());
});

test('not an invoice rejects', () => {
  const r = run(inv({ is_invoice: false, document_type: 'quote' }), [], { m: world() });
  assert.equal(r.result.decision, 'REJECT');
  assert.deepEqual(r.result.reasons.map((x) => x.code), ['NOT_AN_INVOICE']);
  assert.equal(r.result.route, 'AP clerk');
  assert.match(r.result.explanation, /a quote/);
});

test('PO issued to another vendor holds', () => {
  const r = run(inv({ po_number: 'PO-2026-0412' }), [], { m: { ...world(), pos: [...world().pos, ...master.pos], vendors: [...world().vendors, ...master.vendors] } });
  assert.ok(r.codes.includes('PO_VENDOR_MISMATCH'), r.codes.join());
  assert.match(r.result.reasons.find((x) => x.code === 'PO_VENDOR_MISMATCH').message, /issued to Acme Office Supplies LLC, not Testco Industrial Inc/);
  assert.equal(r.result.decision, 'REVIEW');
});

test('currency mismatch holds and skips price comparison', () => {
  const r = run(inv({ currency: 'EUR' }), [], { m: world() });
  assert.ok(r.codes.includes('CURRENCY_MISMATCH'));
  assert.ok(!r.codes.includes('PRICE_VARIANCE') && !r.codes.includes('PO_OVERRUN'));
  assert.equal(r.result.decision, 'REVIEW');
});

test('duplicates: same number + amount rejects, same number + different amount holds, same amount nearby holds', () => {
  const m = world();
  const first = run(atPrice(100, { invoice_number: 'T-0042' }), [], { m });
  const ledger = [{ ...first.row, run_id: 'orig', status: 'approved' }];
  const same = run(atPrice(100, { invoice_number: 'T-42' }), ledger, { m });
  assert.ok(same.codes.includes('DUPLICATE_INVOICE'));
  assert.equal(same.result.decision, 'REJECT');
  assert.equal(same.dup.original.run_id, 'orig');

  // on_hold original, so the PO quantity is not consumed and the only issue is the number clash
  const corrected = run(atPrice(90, { invoice_number: 'T-42' }), [{ ...ledger[0], status: 'on_hold' }], { m });
  assert.ok(!corrected.codes.includes('DUPLICATE_INVOICE'));
  const pd = corrected.result.reasons.find((x) => x.code === 'POSSIBLE_DUPLICATE');
  assert.match(pd.message, /corrected invoice or a credit memo/);
  assert.equal(corrected.result.decision, 'REVIEW');
  assert.equal(corrected.result.route, 'AP clerk');

  const nearby = run(atPrice(100, { invoice_number: 'T-77', invoice_date: '2026-11-09' }), ledger, { m });
  assert.ok(nearby.codes.includes('POSSIBLE_DUPLICATE'));
  assert.match(nearby.result.reasons.find((x) => x.code === 'POSSIBLE_DUPLICATE').message, /8 days apart/);

  // Rejected rows never count; on_hold rows do.
  assert.ok(!run(atPrice(100, { invoice_number: 'T-42' }), [{ ...ledger[0], status: 'rejected' }], { m }).codes.includes('DUPLICATE_INVOICE'));
  assert.ok(run(atPrice(100, { invoice_number: 'T-42' }), [{ ...ledger[0], status: 'on_hold' }], { m }).codes.includes('DUPLICATE_INVOICE'));

  // Same file bytes seen before: a hold, not a reject
  const file = run(atPrice(100, { invoice_number: 'T-99', invoice_date: '2026-06-01' }), ledger, { m, fileSha: 'abc', priorFileShas: ['abc'] });
  assert.ok(file.codes.includes('DUPLICATE_FILE'));
  assert.equal(file.result.decision, 'REVIEW');
});

test('validation: arithmetic, tax rate, dates, confidence, tax ID', () => {
  const v = (o) => validate(inv(o), { today: TODAY }).reasons.map((r) => r.code);
  assert.ok(v({ line_items: [{ description: 'Blue widget', item_code: 'WID-1', quantity: 2, unit_price: 50, amount: 90 }], subtotal: 90, total: 90 }).includes('ARITHMETIC_MISMATCH'));
  assert.ok(v({ subtotal: 100, tax_lines: [{ label: 'Sales tax', rate_pct: 8.5, amount: 9.5 }], tax_total: 9.5, total: 109.5 }).includes('ARITHMETIC_MISMATCH'));
  assert.deepEqual(v({ subtotal: 100, tax_lines: [{ label: 'Sales tax', rate_pct: 8.5, amount: 8.5 }], tax_total: 8.5, total: 108.5 }), []);
  assert.ok(v({ invoice_date: '2026-11-12' }).includes('DATE_OUT_OF_RANGE'));
  assert.deepEqual(v({ invoice_date: '2026-11-11' }), []); // today + 1 allowed (time zones)
  assert.ok(v({ invoice_date: '2025-11-09' }).includes('DATE_OUT_OF_RANGE'));
  assert.ok(v({ invoice_date: '2026-02-30' }).includes('DATE_OUT_OF_RANGE'));
  assert.ok(v({ confidence: { vendor_name: 0.99, invoice_number: 0.5, invoice_date: 0.99, po_number: 0.99, total: 0.99 } }).includes('LOW_CONFIDENCE'));
  assert.ok(v({ vendor: { name: 'Testco', tax_id: '123-45-678' } }).includes('TAX_ID_INVALID'));
  assert.deepEqual(v({ vendor: { name: 'Testco', tax_id: null } }), []); // missing tax ID is only an info check
  assert.ok(v({ currency: 'INR', vendor: { name: 'Testco', tax_id: '29AABCS1234F1Z' } }).includes('TAX_ID_INVALID'));
  // INR rounds to the rupee: a 0.60 difference passes there but would fail in USD
  assert.deepEqual(v({ currency: 'INR', vendor: { name: 'Testco', tax_id: '29AABCS1234F1Z5' }, subtotal: 100, tax_lines: [{ label: 'IGST 18%', rate_pct: 18, amount: 18.6 }], tax_total: 18.6, total: 118.6 }), []);
});

test('tax-inclusive invoice compares net (total − tax) with the PO', () => {
  const ex = inv({ tax_inclusive: true, line_items: [{ description: 'Blue widget', item_code: 'WID-1', quantity: 1, unit_price: 118, amount: 118 }],
    subtotal: 118, tax_lines: [{ label: 'GST 18%', rate_pct: 18, amount: 18 }], tax_total: 18, total: 118 });
  const r = run(ex, [], { m: world() });
  assert.equal(r.mp.net, 100);
  assert.equal(r.mp.lineMatches[0].unitPrice, 100);
  assert.ok(r.codes.includes('TAX_INCLUSIVE'));
  assert.equal(r.result.decision, 'APPROVE', r.codes.join());
});

test('missing quantity is treated as qty 1 at the line amount; masked account compares the tail', () => {
  const r = run(inv({ line_items: [{ description: 'Blue widget', item_code: 'WID-1', quantity: null, unit_price: null, amount: 100 }],
    bank_details: { bank_name: 'Test Bank', account_number: '******2233', routing_code: '021000021', iban: null, swift: null } }), [], { m: world() });
  assert.equal(r.mp.lineMatches[0].qty, 1);
  assert.equal(r.result.decision, 'APPROVE', r.codes.join());
  const changed = run(inv({ bank_details: { bank_name: 'Other Bank', account_number: '******9999', routing_code: null, iban: null, swift: null } }), [], { m: world() });
  assert.ok(changed.codes.includes('BANK_DETAILS_CHANGED'));
  assert.equal(changed.result.route, 'Treasury & Security');
  assert.equal(changed.result.vendorEmail.to, 'ar@testco.com');
});

test('a payment due date in the past is scheduled for today', () => {
  const r = run(inv({ invoice_date: '2026-09-01', due_date: '2026-10-01' }), [], { m: world() });
  assert.equal(r.result.payment.scheduledFor, TODAY);
});

test('PO inference survives how a vision model paraphrases the scanned line', () => {
  const base = fixture('03_peakvalley_scanned_no_po');
  const vendor = matchVendor(base, master.vendors).vendor;
  for (const d of ['Office Cleaning Services - Oct 2026', 'Monthly office cleaning, October', 'Janitorial services October 2026']) {
    const ex = { ...base, line_items: [{ ...base.line_items[0], description: d }] };
    const r = matchPO(ex, vendor, { ...master, ledger: [] });
    assert.equal(r.po?.po_number, 'PO-2026-0377', d);
    assert.deepEqual(r.reasons.filter((x) => x.severity !== 'info'), [], d);
  }
});
