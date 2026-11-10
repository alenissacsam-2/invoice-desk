import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Isolate the DB, pin the date and skip the readability pauses before any module reads the env.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SEED_DB = ''; // start empty, not from the committed data/seed.db
process.env.APP_TODAY ??= '2026-11-10';
process.env.PIPELINE_DELAY = '0';
const { startRun, subscribe, reviewRun, retryRun, summarize, resetAll, recoverInterrupted } = await import('../src/pipeline.js');
const db = await import('../src/db.js');
const { sha256 } = await import('../src/extract.js');

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'manifest.json'), 'utf8'));
const SAMPLE_EXT = /\.(pdf|jpg|jpeg|png)$/;
const fixture = (file) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', file.replace(SAMPLE_EXT, '.json')), 'utf8'));
const mimeOf = (file) => ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' })[SAMPLE_EXT.exec(file)?.[1]];

// Stand-in for Gemini: the ground-truth fixture for whichever sample is being read.
const fixtureExtractor = (file, seen) => async (bytes, mime, opts) => { seen?.push(opts); return { extraction: fixture(file), model: 'fixture', cached: false, latencyMs: 1, attempts: [] }; };
const exOf = (ex) => async () => ({ extraction: ex, model: 'fixture', cached: false, latencyMs: 1, attempts: [] });

/** Resolve with the finished run (subscribing before the first await, so `done` cannot be missed). */
function waitRun(id) {
  return new Promise((resolve) => {
    const unsub = subscribe(id, (type) => { if (type === 'done') { unsub(); resolve(db.getRun(id)); } });
  });
}
const runToEnd = (opts) => waitRun(startRun(opts));
const sampleRun = (file, extra = {}) => runToEnd({ bytes: fs.readFileSync(path.join(root, 'samples', file)), mime: mimeOf(file), filename: file, source: 'sample', extractor: fixtureExtractor(file), ...extra });
const codes = (run) => run.result.reasons.map((r) => r.code);
const stage = (run, key) => run.stages.find((s) => s.key === key);
const review = (id, o) => reviewRun(id, { reviewer: 'Sam Lee', note: 'Checked with the team', ...o });

test(`the ${manifest.length} samples in manifest order`, async (t) => {
  const runs = {};
  for (const s of manifest) {
    await t.test(s.file, async () => {
      const run = await sampleRun(s.file);
      runs[s.file] = run;
      assert.equal(run.status, 'done');
      assert.equal(run.decision, s.expected, `${s.file}: ${run.headline}`);
      for (const c of s.expectedCodes) assert.ok(codes(run).includes(c), `${s.file} should include ${c}; got ${codes(run)}`);
      assert.deepEqual(run.stages.map((x) => x.key), ['intake', 'extract', 'validate', 'vendor', 'duplicate', 'po_match', 'decision']);
      for (const x of run.stages) {
        assert.ok(['passed', 'warning', 'failed', 'skipped'].includes(x.status), `${s.file} ${x.key} is ${x.status}`);
        assert.ok(x.summary, `${s.file} ${x.key} has a summary`);
      }
      assert.equal(stage(run, 'decision').data.decision, s.expected);
      // labels, primary reason and final outcome
      for (const r of run.result.reasons) assert.ok(typeof r.label === 'string' && r.label && r.label !== r.code, `${s.file} ${r.code} has a label`);
      if (s.expected === 'APPROVE') assert.equal(run.result.primaryReason, null);
      else assert.ok(run.result.reasons.some((r) => r.code === run.result.primaryReason.code && r.label === run.result.primaryReason.label));
      if (s.expected === 'REVIEW') assert.equal(run.final, null);
      else assert.deepEqual({ decision: run.final.decision, by: run.final.by, payment: run.final.payment }, { decision: s.expected, by: 'system', payment: run.result.payment });
      assert.doesNotMatch(JSON.stringify(run.result), /\(\(/, `${s.file}: doubled parentheses`);
    });
  }

  await t.test('stage details', () => {
    const r1 = runs['01_acme_happy.pdf'];
    assert.ok(r1.stages.every((x) => x.status === 'passed'), r1.stages.map((x) => `${x.key}:${x.status}`).join(' '));
    const intake = stage(r1, 'intake').data;
    assert.equal(intake.mime, 'application/pdf');
    assert.equal(intake.seenBefore, null);
    assert.match(intake.sha256, /^[0-9a-f]{64}$/);
    assert.equal(stage(r1, 'intake').summary, 'PDF, 1 page, digital');
    assert.equal(stage(runs['03_peakvalley_scanned_no_po.pdf'], 'intake').summary, 'PDF, 1 page, scanned');
    const ext = stage(r1, 'extract').data;
    assert.equal(ext.fields.length, 12);
    assert.deepEqual(ext.fields.find((f) => f.key === 'total'), { key: 'total', label: 'Total', value: 4111.07, confidence: fixture('01_acme_happy.pdf').confidence.total });
    assert.equal(stage(r1, 'vendor').data.method, 'tax_id');
    assert.equal(stage(r1, 'vendor').data.bank.differs, false);
    const po1 = stage(r1, 'po_match').data;
    assert.equal(po1.matchType, '3-way');
    assert.ok(po1.lines.length === 3 && po1.lines.every((l) => l.status === 'pass'));
    assert.match(r1.result.explanation, /scheduled for 27 Nov 2026/);

    // Within-tolerance surcharge: shown as a variance, never as a failure.
    const r2 = stage(runs['02_brightline_fuel_surcharge.pdf'], 'po_match');
    assert.ok(!r2.checks.some((c) => c.status === 'fail'), JSON.stringify(r2.checks));
    assert.equal(r2.checks.find((c) => c.label === 'Invoice vs PO prices').status, 'info');
    assert.equal(r2.data.lines.find((l) => /fuel/i.test(l.description)).status, 'warn');

    const r3 = stage(runs['03_peakvalley_scanned_no_po.pdf'], 'po_match');
    assert.equal(r3.data.po_number, 'PO-2026-0377');
    assert.equal(r3.data.inferred, true);
    assert.match(r3.summary, /^PO-2026-0377 inferred \(score \d+%\)$/);

    const r5 = runs['05_northstar_split_2of2.pdf'];
    assert.equal(stage(r5, 'po_match').status, 'warning');
    const dock = stage(r5, 'po_match').data.lines.find((l) => /dock/i.test(l.description));
    assert.equal(dock.status, 'fail');
    assert.equal(r5.result.route, 'Receiving');
    assert.equal(r5.result.primaryReason.label, 'Billed more than received');

    const r6 = runs['06_acme_duplicate_resend.pdf'];
    assert.equal(stage(r6, 'po_match').status, 'skipped');
    assert.equal(stage(r6, 'po_match').summary, 'Skipped — duplicate of an earlier invoice');
    assert.equal(stage(r6, 'duplicate').data.originalRunId, r1.id);
    assert.equal(r6.result.primaryReason.code, 'DUPLICATE_INVOICE');
    assert.match(r6.result.explanation, /will not be paid again/); // the original is approved
    assert.ok(r6.result.vendorEmail, 'the vendor re-sent a different file: courtesy note drafted');

    const r7 = runs['07_kestrel_bank_change.pdf'];
    assert.equal(stage(r7, 'vendor').status, 'warning');
    assert.equal(stage(r7, 'vendor').data.bank.differs, true);
    assert.equal(stage(r7, 'vendor').data.bank.onInvoice.routing, '063100277');
    assert.equal(r7.result.primaryReason.code, 'BANK_DETAILS_CHANGED');
    assert.ok(codes(r7).includes('REMIT_DOMAIN_LOOKALIKE'));
    assert.ok(!codes(r7).includes('SUSPICIOUS_INSTRUCTIONS'));

    const r10 = runs['10_brightline_photo_injection.jpg'];
    if (r10) {
      assert.equal(stage(r10, 'intake').summary, 'JPEG image (photo)');
      assert.equal(r10.result.primaryReason.code, 'SUSPICIOUS_INSTRUCTIONS');
      assert.equal(r10.result.route, 'Treasury & Security');
      assert.ok(!codes(r10).includes('PO_OVERRUN'), 'the overrun is the price variance, reported once');
    }
  });

  await t.test('run list row: main reason is the primary reason, with label', () => {
    const row = summarize(runs['06_acme_duplicate_resend.pdf']);
    assert.equal(row.main_reason.code, 'DUPLICATE_INVOICE');
    assert.equal(row.main_reason.label, 'Already processed');
    assert.equal(row.final_decision, 'REJECT');
    assert.equal(row.reviewer, null);
    assert.equal(summarize(runs['05_northstar_split_2of2.pdf']).final_decision, null);
  });

  await t.test('ledger state', () => {
    const ledger = db.getLedger();
    const byRun = (file) => ledger.filter((l) => l.run_id === runs[file].id);
    for (const s of manifest) {
      const rows = byRun(s.file);
      if (s.expected === 'REJECT') assert.equal(rows.length, 0, `${s.file} should have no ledger row`);
      else assert.deepEqual(rows.map((r) => r.status), [s.expected === 'APPROVE' ? 'approved' : 'on_hold'], s.file);
    }
    const r4 = byRun('04_northstar_split_1of2.pdf')[0];
    assert.equal(r4.net, 9870);
    assert.deepEqual(r4.lines.map((l) => [l.po_line_no, l.qty]), [[1, 6], [2, 6]]);
  });

  await t.test('review: validation, then approving the held split invoice schedules payment, once', async () => {
    const id = runs['05_northstar_split_2of2.pdf'].id;
    await assert.rejects(reviewRun(id, { action: 'approve', note: 'Docks arrived' }), (e) => e.status === 400 && /name/.test(e.message));
    await assert.rejects(reviewRun(id, { action: 'approve', reviewer: 'S', note: 'Docks arrived' }), (e) => e.status === 400);
    await assert.rejects(reviewRun(id, { action: 'approve', reviewer: 'Sam', note: ' ok ' }), (e) => e.status === 400 && /note/.test(e.message));
    await assert.rejects(reviewRun(id, { action: 'maybe', reviewer: 'Sam', note: 'Docks arrived' }), (e) => e.status === 400);
    const updated = await review(id, { action: 'approve', note: '  Receiving confirmed the docks arrived ' });
    assert.deepEqual({ ...updated.review, at: null }, { action: 'approve', reviewer: 'Sam Lee', note: 'Receiving confirmed the docks arrived', callbackVerified: false, at: null });
    assert.equal(updated.final.decision, 'APPROVE');
    assert.equal(updated.final.by, 'reviewer');
    assert.deepEqual(updated.final.payment, { amount: 7139.3, currency: 'USD', scheduledFor: '2026-12-05' }); // due date printed on NSC-7802
    assert.equal(updated.decision, 'REVIEW', 'the system decision is kept');
    assert.equal(db.getLedger().find((l) => l.run_id === id).status, 'approved');
    assert.equal(summarize(updated).reviewer, 'Sam Lee');
    assert.equal(summarize(updated).final_decision, 'APPROVE');
    await assert.rejects(review(id, { action: 'reject' }), (e) => e.status === 409);
    await assert.rejects(review(runs['01_acme_happy.pdf'].id, { action: 'approve' }), (e) => e.status === 409);
    await assert.rejects(review('r_nope', { action: 'approve' }), (e) => e.status === 404);
  });

  await t.test('review: a bank change needs a verified call-back before approval; reject does not', async () => {
    const id = runs['07_kestrel_bank_change.pdf'].id;
    await assert.rejects(review(id, { action: 'approve' }), (e) => e.status === 400 && /call/i.test(e.message));
    await assert.rejects(review(id, { action: 'approve', callbackVerified: 'yes' }), (e) => e.status === 400);
    const ok = await review(id, { action: 'approve', callbackVerified: true, note: 'Called (510) 555-0199, change confirmed' });
    assert.equal(ok.review.callbackVerified, true);
    assert.equal(ok.final.payment.scheduledFor, '2026-12-02');

    const r10 = runs['10_brightline_photo_injection.jpg'];
    if (r10) {
      await assert.rejects(review(r10.id, { action: 'approve' }), (e) => e.status === 400);
      const rej = await review(r10.id, { action: 'reject', note: 'Injected instructions, vendor denies sending it' });
      assert.deepEqual(rej.final, { decision: 'REJECT', by: 'reviewer', at: rej.final.at, payment: null });
      assert.equal(db.getLedger().find((l) => l.run_id === r10.id).status, 'rejected');
    }
  });

  await t.test('same file again: one DUPLICATE_INVOICE reason, worded without repeating the number, and no email', async () => {
    const run = await sampleRun('01_acme_happy.pdf', { source: 'upload' }); // an upload of the same file: a sample click would replay instead
    assert.equal(stage(run, 'intake').data.seenBefore, runs['01_acme_happy.pdf'].id);
    assert.ok(codes(run).includes('DUPLICATE_INVOICE'));
    assert.ok(!codes(run).includes('DUPLICATE_FILE'), 'DUPLICATE_FILE is folded into DUPLICATE_INVOICE');
    assert.equal(run.decision, 'REJECT');
    const msg = run.result.reasons.find((r) => r.code === 'DUPLICATE_INVOICE').message;
    assert.doesNotMatch(msg, /ACM-INV-10458 is the same invoice as ACM-INV-10458/);
    assert.match(msg, new RegExp(`was already processed on \\d{1,2} [A-Z][a-z]{2} \\d{4} \\(run ${runs['01_acme_happy.pdf'].id}\\)`));
    assert.equal(run.result.vendorEmail, null);
    assert.ok(!run.result.nextActions.some((a) => /courtesy/.test(a)));
  });

  await t.test('retry: re-reads a held invoice fresh as a new run that supersedes the original', async () => {
    const orig = runs['08_lumen_missing_fields.pdf'];
    const seen = [];
    const id = retryRun(orig.id, { extractor: fixtureExtractor('08_lumen_missing_fields.pdf', seen) });
    assert.notEqual(id, orig.id);
    assert.equal(db.getRun(orig.id).superseded_by, id);
    assert.equal(summarize(db.getRun(orig.id)).superseded_by, id);
    const run = await waitRun(id);
    assert.deepEqual(seen.map((o) => o.fresh), [true]);
    assert.equal(run.source, 'sample');
    assert.equal(run.retry_of, orig.id);
    assert.equal(run.file_sha, orig.file_sha);
    assert.equal(run.decision, 'REVIEW', `${run.headline} ${codes(run)}`);
    assert.ok(!codes(run).some((c) => /DUPLICATE/.test(c)), 'not a duplicate of the run it retries');
    assert.equal(stage(run, 'intake').data.seenBefore, null);
    const rows = db.getLedger().filter((l) => [orig.id, id].includes(l.run_id));
    assert.deepEqual(rows.map((r) => [r.run_id, r.status]), [[orig.id, 'superseded'], [id, 'on_hold']]);
    // The original is out of the game: no review, no second retry.
    await assert.rejects(review(orig.id, { action: 'approve' }), (e) => e.status === 409 && e.message === `Replaced by a later run, ${id}.`);
    assert.throws(() => retryRun(orig.id), (e) => e.status === 409);
    // Only failed runs and unreviewed holds can be retried: never an approved, rejected or reviewed one.
    assert.throws(() => retryRun(runs['09_sharma_gst_inr.pdf'].id), (e) => e.status === 409);
    assert.throws(() => retryRun(runs['06_acme_duplicate_resend.pdf'].id), (e) => e.status === 409);
    assert.throws(() => retryRun(runs['05_northstar_split_2of2.pdf'].id), (e) => e.status === 409);
    assert.throws(() => retryRun('r_nope'), (e) => e.status === 404);
  });
});

test('extraction errors end the run as error, with a headline per kind', async () => {
  const bytes = fs.readFileSync(path.join(root, 'samples', '01_acme_happy.pdf'));
  const failWith = (kind, message) => runToEnd({ bytes, filename: 'x.pdf', extractor: async () => { throw Object.assign(new Error(message), kind && { kind }); } });

  const down = await failWith('ai_unavailable', 'Gemini is unavailable (503) after retries on m: overloaded');
  assert.equal(down.status, 'error');
  assert.equal(down.decision, null);
  assert.equal(down.final, null);
  assert.equal(stage(down, 'extract').status, 'failed');
  assert.ok(down.stages.slice(2).every((x) => x.status === 'skipped'));
  assert.equal(down.result.decision, 'REVIEW');
  assert.equal(down.result.errorKind, 'ai_unavailable');
  assert.equal(down.result.headline, "Couldn't read the document: Gemini unavailable — retry in a minute.");
  assert.equal(db.getLedger().filter((l) => l.run_id === down.id).length, 0);
  await assert.rejects(review(down.id, { action: 'approve' }), (e) => e.status === 409);

  const bad = await failWith('unreadable_file', 'Gemini could not open the file (400): bad');
  assert.equal(bad.result.errorKind, 'unreadable_file');
  assert.equal(bad.result.headline, "Couldn't open this file — it may be corrupt or password-protected. Ask the vendor for a new copy.");
  assert.ok(bad.result.nextActions.some((a) => /new copy/.test(a)));

  const bug = await failWith(null, 'boom');
  assert.equal(bug.result.errorKind, 'internal');

  // A failed run can be retried.
  const again = await waitRun(retryRun(down.id, { extractor: fixtureExtractor('01_acme_happy.pdf') }));
  assert.equal(again.status, 'done');
});

test('not an invoice: extract fails, middle stages skipped, decision REJECT', async () => {
  const quote = { ...fixture('01_acme_happy.pdf'), is_invoice: false, document_type: 'quote' };
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 quote\n%%EOF'), filename: 'q.pdf', extractor: exOf(quote) });
  assert.equal(run.status, 'done');
  assert.equal(run.decision, 'REJECT');
  assert.deepEqual(codes(run), ['NOT_AN_INVOICE']);
  assert.equal(stage(run, 'extract').status, 'failed');
  assert.ok(['validate', 'vendor', 'duplicate', 'po_match'].every((k) => stage(run, k).status === 'skipped'));
  assert.equal(stage(run, 'decision').status, 'failed');
});

test('credit note: held for the AP clerk, names the invoice it credits, nothing to pay', async () => {
  const inv = fixture('01_acme_happy.pdf');
  // ACM-INV-10458 is in the ledger (approved) from the sample run above.
  const credit = {
    ...inv, is_invoice: false, document_type: 'credit_note', invoice_number: 'ACM-CN-0091', invoice_date: '2026-11-06', due_date: null,
    line_items: [{ description: 'Return of 1 × Ergonomic office chair EC-200', item_code: 'CHR-EC200', quantity: -1, unit_price: 289, amount: -289 }],
    subtotal: -289, tax_lines: [{ label: 'Sales tax 8.5%', rate_pct: 8.5, amount: -24.57 }], tax_total: -24.57, total: -313.57,
    notices: ['Credit against invoice ACM-INV-10458'],
  };
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 /Font credit-note\n%%EOF'), filename: 'cn.pdf', extractor: exOf(credit) });
  assert.equal(run.decision, 'REVIEW', `${run.headline} ${codes(run)}`);
  assert.ok(!codes(run).includes('NOT_AN_INVOICE'));
  assert.ok(!codes(run).includes('ARITHMETIC_MISMATCH'), 'negative amounts add up');
  assert.equal(run.result.primaryReason.code, 'CREDIT_NOTE');
  assert.equal(run.result.route, 'AP clerk');
  const msg = run.result.reasons.find((r) => r.code === 'CREDIT_NOTE').message;
  assert.match(msg, /^Credit note ACM-CN-0091 for −\$313\.57 from Acme Office Supplies LLC, against invoice ACM-INV-10458 \(run r_\w+\)\. Nothing to pay/);
  assert.equal(stage(run, 'po_match').data.lines.length, 0);
  assert.ok(!codes(run).some((c) => c.startsWith('QTY_') || c === 'PO_OVERRUN'));
  assert.equal(run.result.payment, null);
  assert.match(run.headline, /credit note ACM-CN-0091 for −\$313\.57, nothing to pay/);
  assert.ok(db.getLedger().find((l) => l.run_id === run.id).net < 0, 'credit notes are negative in the ledger');
  const ok = await review(run.id, { action: 'approve', note: 'Applied to next payment' });
  assert.equal(ok.final.payment, null);
});

test('junk bytes fail intake; an extractor bug never escapes', async () => {
  const junk = await runToEnd({ bytes: Buffer.from('hello'), filename: 'j.txt', extractor: fixtureExtractor('01_acme_happy.pdf') });
  assert.equal(junk.status, 'error');
  assert.equal(stage(junk, 'intake').status, 'failed');
  const bug = await runToEnd({ bytes: Buffer.from('%PDF-1.4 x\n%%EOF'), filename: 'b.pdf', extractor: async () => ({ extraction: null, model: 'x', cached: false, latencyMs: 0, attempts: [] }) });
  assert.equal(bug.status, 'error');
  assert.equal(bug.result.errorKind, 'internal');
  assert.equal(stage(bug, 'extract').status, 'failed');
  assert.match(bug.result.headline, /^Something went wrong in read the invoice/);
});

test('broken or encrypted PDFs fail intake without a Gemini read', async () => {
  let calls = 0;
  const extractor = async () => { calls++; return fixtureExtractor('01_acme_happy.pdf')(); };
  const cut = await runToEnd({ bytes: Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog'), filename: 'cut.pdf', extractor });
  assert.equal(cut.result.errorKind, 'unreadable_file');
  assert.equal(cut.result.headline, "Couldn't open this file — it may be corrupt or password-protected. Ask the vendor for a new copy.");
  assert.equal(stage(cut, 'intake').status, 'failed');
  const enc = await runToEnd({ bytes: Buffer.from('%PDF-1.7\n2 0 obj <</Type/Page>> endobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF'), filename: 'enc.pdf', extractor });
  assert.equal(enc.result.errorKind, 'unreadable_file');
  assert.match(enc.result.headline, /password-protected. Ask the vendor for a new copy.$/);
  assert.equal(calls, 0);
});

test('Net 30 terms with a day/month-swapped invoice date hold for a check (sample 05)', async () => {
  resetAll(); // earlier tests already booked 05
  const ex = fixture('05_northstar_split_2of2.pdf');
  Object.assign(ex, { invoice_date: '2026-05-11', due_date: '2026-05-12', payment_terms: 'Net 30' });
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 date-swap\n%%EOF'), filename: 'd.pdf', extractor: exOf(ex) });
  assert.equal(run.result.decision, 'REVIEW');
  const r = run.result.reasons.find((x) => x.code === 'LOW_CONFIDENCE');
  assert.equal(r.message, "Invoice date 11 May 2026 and due date 12 May 2026 don't fit the printed Net 30 terms — the date may have been misread (5/11 vs 11/5). Check the document.");
});

test('openDb migrates a database from the previous schema', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const old = path.join(tmp, 'old.db');
  const d = new DatabaseSync(old);
  d.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, created_at TEXT, filename TEXT, file_sha TEXT, mime TEXT, bytes BLOB, source TEXT, status TEXT, decision TEXT,
      headline TEXT, vendor_id TEXT, invoice_number TEXT, total REAL, currency TEXT, po_number TEXT, ms INTEGER, stages TEXT, extraction TEXT, result TEXT, review TEXT);
    CREATE TABLE extraction_cache (file_sha TEXT PRIMARY KEY, model TEXT, json TEXT, created_at TEXT);
    INSERT INTO runs (id, created_at, status, decision, result) VALUES ('a', '2026-11-01T00:00:00Z', 'done', 'APPROVE', '{"payment":{"amount":1,"currency":"USD","scheduledFor":"2026-12-01"}}');
    INSERT INTO runs (id, created_at, status, decision, review) VALUES ('b', '2026-11-01T00:00:00Z', 'done', 'REVIEW', '{"action":"reject","note":"x","at":"2026-11-02T00:00:00Z"}');
    INSERT INTO runs (id, created_at, status, decision) VALUES ('c', '2026-11-01T00:00:00Z', 'done', 'REVIEW');`);
  d.close();
  // Fresh process: openDb() caches its handle, so run the migration in a child with DB_PATH pointing at the old file.
  const code = `const db = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const out = ['a','b','c'].map((id) => db.getRun(id).final);
    db.putCachedExtraction('s', 'm', {x: 1}, 1234);
    console.log(JSON.stringify({ out, cache: db.getCachedExtraction('s').latency_ms }));`;
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DB_PATH: old }, stdio: ['ignore', 'pipe', 'inherit'] });
    let s = '';
    p.stdout.on('data', (c) => (s += c));
    p.on('close', () => resolve(JSON.parse(s)));
  });
  assert.deepEqual(res.out[0], { decision: 'APPROVE', by: 'system', at: '2026-11-01T00:00:00Z', payment: { amount: 1, currency: 'USD', scheduledFor: '2026-12-01' } });
  assert.deepEqual(res.out[1], { decision: 'REJECT', by: 'reviewer', at: '2026-11-02T00:00:00Z', payment: null });
  assert.equal(res.out[2], null);
  assert.equal(res.cache, 1234);
});

test('HTTP API: stats count invoices, samples show processed, retry and review routes', async () => {
  // Separate server process and DB; the extraction cache is pre-filled with the fixtures, so no Gemini key is needed.
  const apiDb = path.join(tmp, 'api.db');
  const port = 3900 + Math.floor(Math.random() * 500);
  const seed = `const db = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const { sha256 } = await import(${JSON.stringify(new URL('../src/extract.js', import.meta.url).href)});
    const fs = await import('node:fs');
    for (const [f, fx] of ${JSON.stringify(manifest.map((s) => [s.file, fixture(s.file)]))}) db.putCachedExtraction(sha256(fs.readFileSync(${JSON.stringify(path.join(root, 'samples'))} + '/' + f)), 'fixture', fx, 2000);`;
  await new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', seed], { env: { ...process.env, DB_PATH: apiDb }, stdio: 'inherit' }).on('close', resolve));
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, DB_PATH: apiDb, PORT: String(port), GEMINI_API_KEY: '', PIPELINE_DELAY: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => srv.stdout.on('data', (c) => { if (/listening/.test(c)) resolve(); }));
    const base = `http://localhost:${port}`;
    const api = async (p, opts) => { const r = await fetch(base + p, opts && { ...opts, headers: { 'X-Demo': '1', ...opts.headers } }); return { status: r.status, body: await r.json() }; };
    const done = async (id) => { for (;;) { const { body } = await api(`/api/runs/${id}`); if (body.status !== 'running') return body; await new Promise((r) => setTimeout(r, 50)); } };
    const sample = async (f) => done((await api(`/api/runs?sample=${encodeURIComponent(f)}`, { method: 'POST' })).body.id);

    assert.ok((await api('/api/samples')).body.every((s) => s.processed === null));
    const r4 = await sample('04_northstar_split_1of2.pdf');
    const r5 = await sample('05_northstar_split_2of2.pdf'); // QTY_EXCEEDS_RECEIPT on two lines: counts once
    const r7 = await sample('07_kestrel_bank_change.pdf');
    assert.equal(r4.decision, 'APPROVE');
    assert.equal(r5.result.reasons.filter((r) => r.code === 'QTY_EXCEEDS_RECEIPT').length, 2);
    assert.equal(r7.stages.find((s) => s.key === 'extract').data.originalLatencyMs, 2000);

    const samples = (await api('/api/samples')).body;
    assert.deepEqual(samples.find((s) => s.file === '05_northstar_split_2of2.pdf').processed, { runId: r5.id, decision: 'REVIEW', final_decision: null });
    assert.equal(samples.find((s) => s.file === '01_acme_happy.pdf').processed, null);

    let { status, body } = await api(`/api/runs/${r7.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'approve', reviewer: 'Sam', note: 'looks fine' }) });
    assert.equal(status, 400);
    assert.match(body.error, /call/i);
    ({ status } = await api(`/api/runs/${r5.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject', reviewer: 'Sam', note: 'Docks never arrived' }) }));
    assert.equal(status, 200);

    const stats = (await api('/api/stats')).body;
    assert.equal(stats.total, 3);
    assert.deepEqual(stats.byDecision, { APPROVE: 1, REVIEW: 2, REJECT: 0 });
    assert.deepEqual(stats.final, { approved: 1, rejected: 1, awaiting: 1 });
    assert.equal(stats.humanReviewed, 1);
    assert.deepEqual(stats.valueApproved, { USD: 10708.95, INR: 0 });
    assert.equal(stats.medianReadMs, 2000);
    assert.equal(typeof stats.medianMs, 'number');
    assert.deepEqual(stats.topReasons.find((r) => r.code === 'QTY_EXCEEDS_RECEIPT'), { code: 'QTY_EXCEEDS_RECEIPT', label: 'Billed more than received', severity: 'hold', count: 1 });
    assert.ok(stats.topReasons.every((r) => r.label));

    const list = (await api('/api/runs')).body;
    const row5 = list.find((r) => r.id === r5.id);
    assert.equal(row5.final_decision, 'REJECT');
    assert.equal(row5.reviewer, 'Sam');
    assert.equal(row5.main_reason.label, 'Billed more than received');

    const retried = await api(`/api/runs/${r7.id}/retry`, { method: 'POST' });
    assert.equal(retried.status, 202);
    const r7b = await done(retried.body.id);
    assert.equal(r7b.source, 'sample');
    assert.equal(r7b.decision, 'REVIEW'); // no key: fresh read fails over to the cached reading
    assert.ok(r7b.stages.find((s) => s.key === 'extract').data.fallbackReason);
    assert.equal((await api('/api/runs/r_nope/retry', { method: 'POST' })).status, 404);
  } finally { srv.kill(); }
});

test('extraction setup problems (bad key, bad model/schema) say so, not "unreadable file"', async () => {
  const bytes = fs.readFileSync(path.join(root, 'samples', '01_acme_happy.pdf'));
  const failWith = (props) => runToEnd({ bytes, filename: 'x.pdf', extractor: async () => { throw Object.assign(new Error(props.message), props); } });
  const key = await failWith({ kind: 'ai_unavailable', config: 'key', status: 400, message: 'Gemini rejected the API key (400): API key not valid. Please pass a valid API key.' });
  assert.equal(key.result.errorKind, 'ai_unavailable');
  assert.match(key.result.headline, /API key is missing or invalid/);
  const req = await failWith({ kind: 'ai_unavailable', config: 'request', status: 400, message: 'Gemini rejected the request (400) on m: bad schema' });
  assert.equal(req.result.errorKind, 'ai_unavailable');
  assert.match(req.result.headline, /model or configuration problem/);
});

// ---------- concurrency: the duplicate → PO match → ledger stretch is serialised ----------
const sampleBytes = (file) => fs.readFileSync(path.join(root, 'samples', file));
const startSample = (file, extra = {}) => startRun({ bytes: sampleBytes(file), filename: file, source: 'sample', extractor: fixtureExtractor(file), ...extra });
const both = (...ids) => Promise.all(ids.map(waitRun));

test('concurrent runs see each other: the same invoice twice at once is approved once', async () => {
  resetAll();
  const [a, b] = await both(...['01_acme_happy.pdf', '01_acme_happy.pdf'].map((f) => startSample(f, { source: 'upload' })));
  assert.deepEqual([a.decision, b.decision].sort(), ['APPROVE', 'REJECT']);
  assert.ok(codes([a, b].find((r) => r.decision === 'REJECT')).includes('DUPLICATE_INVOICE'));
  assert.equal(db.getLedger().filter((l) => l.status === 'approved').length, 1);
});

test('concurrent runs see each other: 01 and its resend 06 at once, 06 is rejected', async () => {
  resetAll();
  const [r1, r6] = await both(startSample('01_acme_happy.pdf'), startSample('06_acme_duplicate_resend.pdf'));
  assert.equal(r1.decision, 'APPROVE');
  assert.equal(r6.decision, 'REJECT');
  assert.ok(codes(r6).includes('DUPLICATE_INVOICE'));
});

test('concurrent runs see each other: split invoices 04 and 05 at once, exactly one is held', async () => {
  resetAll();
  const runs = await both(startSample('04_northstar_split_1of2.pdf'), startSample('05_northstar_split_2of2.pdf'));
  assert.equal(runs.filter((r) => r.decision === 'REVIEW').length, 1, runs.map((r) => `${r.filename}: ${r.decision} ${codes(r)}`).join('; '));
  assert.equal(runs.filter((r) => r.decision === 'APPROVE').length, 1);
});

test('a burst of 20 invoices against one PO never consumes more than ordered or received', async () => {
  resetAll();
  const f4 = fixture('04_northstar_split_1of2.pdf');
  const ids = Array.from({ length: 20 }, (_, i) => startRun({
    bytes: Buffer.from(`%PDF-1.4 /Font burst ${i}\n%%EOF`), filename: `burst-${i}.pdf`,
    extractor: exOf({ ...f4, invoice_number: `NSC-9${String(i).padStart(3, '0')}` }), // same speed: all 20 reach the checks together
  }));
  const runs = await both(...ids);
  assert.ok(runs.every((r) => r.status === 'done'));
  const approved = db.getLedger().filter((l) => l.status === 'approved' && l.po_number === 'PO-2026-0420');
  const qty = (line) => approved.flatMap((l) => l.lines).filter((l) => l.po_line_no === line).reduce((a, l) => a + l.qty, 0);
  assert.equal(approved.length, 1, 'only one 6+6 invoice fits the receipts');
  assert.ok(qty(1) <= 8 && qty(2) <= 6, `laptops ${qty(1)}/8 received, docks ${qty(2)}/6`);
});

test('review approve re-checks the current ledger: no paying twice, no going over the PO since the hold', async () => {
  resetAll();
  const f7 = fixture('07_kestrel_bank_change.pdf');
  const held = await sampleRun('07_kestrel_bank_change.pdf');
  assert.equal(held.decision, 'REVIEW');
  const ok = { action: 'approve', callbackVerified: true };

  // Approved elsewhere in the meantime: approving would pay it twice.
  db.insertLedger({ run_id: 'r_manual', vendor_id: 'V005', invoice_number: f7.invoice_number, invoice_number_norm: null,
    invoice_date: f7.invoice_date, net: 14530, total: f7.total, currency: 'USD', po_number: 'PO-2026-0405', lines: [], status: 'approved', created_at: new Date().toISOString() });
  await assert.rejects(review(held.id, ok), (e) => e.status === 409 && /already approved in run r_manual/.test(e.message));
  db.updateLedgerStatus('r_manual', 'rejected');

  // A second invoice for the whole PO is approved after the first was held: the first would now go over the PO.
  const other = await runToEnd({ bytes: Buffer.from('%PDF-1.4 /Font kestrel-2\n%%EOF'), filename: 'k2.pdf', extractor: exOf({ ...f7, invoice_number: 'KIS-24-0999' }) });
  assert.equal(other.decision, 'REVIEW');
  await review(other.id, ok);
  await assert.rejects(review(held.id, ok), (e) => e.status === 409 && /Since this invoice was put on hold.*PO-2026-0405/.test(e.message));
  assert.equal(db.getRun(held.id).review, null, 'nothing recorded');
  assert.equal(db.getLedger().find((l) => l.run_id === held.id).status, 'on_hold');
  assert.equal((await review(held.id, { action: 'reject' })).final.decision, 'REJECT', 'rejecting is always possible');
});

test('reset during a run: open streams get `reset`, the run writes nothing', async () => {
  resetAll();
  let release;
  const gate = new Promise((r) => (release = r));
  const id = startRun({ bytes: sampleBytes('01_acme_happy.pdf'), filename: 'x.pdf', extractor: async () => { await gate; return exOf(fixture('01_acme_happy.pdf'))(); } });
  const got = [];
  subscribe(id, (type) => got.push(type));
  await new Promise((r) => setTimeout(r, 10));
  resetAll();
  assert.ok(got.includes('reset'));
  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(db.getRun(id), null);
  assert.equal(db.getLedger().length, 0);
  assert.ok(!got.includes('done'));
});

test('restart mid-run: a run left `running` becomes a retryable error', async () => {
  resetAll();
  const stages = [{ key: 'intake', status: 'passed' }, { key: 'extract', status: 'running' }, { key: 'validate', status: 'pending' }];
  db.insertRun({ id: 'r_cut', created_at: new Date().toISOString(), filename: '01_acme_happy.pdf', file_sha: 'x', mime: 'application/pdf', bytes: sampleBytes('01_acme_happy.pdf'), source: 'sample', status: 'running', stages });
  recoverInterrupted();
  const run = db.getRun('r_cut');
  assert.equal(run.status, 'error');
  assert.equal(run.headline, 'Interrupted by a server restart — retry it');
  assert.equal(run.result.errorKind, 'internal');
  assert.deepEqual(run.stages.map((s) => s.status), ['passed', 'failed', 'skipped']);
  const again = await waitRun(retryRun('r_cut', { extractor: fixtureExtractor('01_acme_happy.pdf') }));
  assert.equal(again.decision, 'APPROVE');
});

test('only the newest runs are kept; runs the ledger points at lose their file instead', () => {
  resetAll();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  db.insertLedger({ run_id: 'r_old0', vendor_id: 'V001', invoice_number: 'A', status: 'approved', created_at: new Date(t0).toISOString(), lines: [] });
  for (let i = 0; i < 305; i++) db.insertRun({ id: `r_old${i}`, created_at: new Date(t0 + i * 1000).toISOString(), filename: 'f', bytes: Buffer.from('x'), status: 'done', stages: [] });
  const ids = db.listRuns().map((r) => r.id);
  assert.equal(ids.length, 301);
  assert.ok(ids.includes('r_old0') && !ids.includes('r_old1') && ids.includes('r_old5'));
  assert.equal(db.getRunFile('r_old0').bytes, null);
  assert.ok(db.getRunFile('r_old304').bytes);
});

test('replaying a sample supersedes its earlier run instead of rejecting it as a duplicate', async () => {
  resetAll();
  const first = await waitRun(startSample('01_acme_happy.pdf'));
  assert.equal(first.decision, 'APPROVE');
  const replay = await waitRun(startSample('01_acme_happy.pdf'));
  assert.equal(replay.decision, 'APPROVE', 'a replay decides fresh');
  assert.equal(db.getRun(first.id).superseded_by, replay.id);
  assert.deepEqual(db.getLedger().map((l) => [l.run_id, l.status]).sort(), [[first.id, 'superseded'], [replay.id, 'approved']].sort());
  const resend = await waitRun(startSample('06_acme_duplicate_resend.pdf'));
  assert.equal(resend.decision, 'REJECT', 'a different file (the vendor resend) is still caught as a duplicate');
  const upload = await waitRun(startSample('01_acme_happy.pdf', { source: 'upload' }));
  assert.equal(upload.decision, 'REJECT', 'uploads keep full duplicate detection');
  const again = await waitRun(startSample('01_acme_happy.pdf'));
  assert.equal(again.decision, 'APPROVE', 'a replay also sets aside a hand upload of the same bytes');
  assert.equal(db.getRun(upload.id).superseded_by, again.id);
});

test('two clicks on the same sample at once: only the later one books anything', async () => {
  resetAll();
  const [a, b] = await both(startSample('04_northstar_split_1of2.pdf'), startSample('04_northstar_split_1of2.pdf'));
  const live = [a, b].filter((r) => !db.getRun(r.id).superseded_by);
  assert.equal(live.length, 1);
  assert.equal(db.getLedger().filter((l) => l.status === 'approved').length, 1);
});
