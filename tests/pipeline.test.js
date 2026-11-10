import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Isolate the DB, pin the date and skip the readability pauses before any module reads the env.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.APP_TODAY ??= '2026-11-10';
process.env.PIPELINE_DELAY = '0';
const { startRun, subscribe, reviewRun, retryRun, summarize } = await import('../src/pipeline.js');
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

  await t.test('review: validation, then approving the held split invoice schedules payment, once', () => {
    const id = runs['05_northstar_split_2of2.pdf'].id;
    assert.throws(() => reviewRun(id, { action: 'approve', note: 'Docks arrived' }), (e) => e.status === 400 && /name/.test(e.message));
    assert.throws(() => reviewRun(id, { action: 'approve', reviewer: 'S', note: 'Docks arrived' }), (e) => e.status === 400);
    assert.throws(() => reviewRun(id, { action: 'approve', reviewer: 'Sam', note: ' ok ' }), (e) => e.status === 400 && /note/.test(e.message));
    assert.throws(() => reviewRun(id, { action: 'maybe', reviewer: 'Sam', note: 'Docks arrived' }), (e) => e.status === 400);
    const updated = review(id, { action: 'approve', note: '  Receiving confirmed the docks arrived ' });
    assert.deepEqual({ ...updated.review, at: null }, { action: 'approve', reviewer: 'Sam Lee', note: 'Receiving confirmed the docks arrived', callbackVerified: false, at: null });
    assert.equal(updated.final.decision, 'APPROVE');
    assert.equal(updated.final.by, 'reviewer');
    assert.deepEqual(updated.final.payment, { amount: 7139.3, currency: 'USD', scheduledFor: '2026-12-05' }); // due date printed on NSC-7802
    assert.equal(updated.decision, 'REVIEW', 'the system decision is kept');
    assert.equal(db.getLedger().find((l) => l.run_id === id).status, 'approved');
    assert.equal(summarize(updated).reviewer, 'Sam Lee');
    assert.equal(summarize(updated).final_decision, 'APPROVE');
    assert.throws(() => review(id, { action: 'reject' }), (e) => e.status === 409);
    assert.throws(() => review(runs['01_acme_happy.pdf'].id, { action: 'approve' }), (e) => e.status === 409);
    assert.throws(() => review('r_nope', { action: 'approve' }), (e) => e.status === 404);
  });

  await t.test('review: a bank change needs a verified call-back before approval; reject does not', () => {
    const id = runs['07_kestrel_bank_change.pdf'].id;
    assert.throws(() => review(id, { action: 'approve' }), (e) => e.status === 400 && /call/i.test(e.message));
    assert.throws(() => review(id, { action: 'approve', callbackVerified: 'yes' }), (e) => e.status === 400);
    const ok = review(id, { action: 'approve', callbackVerified: true, note: 'Called (510) 555-0199, change confirmed' });
    assert.equal(ok.review.callbackVerified, true);
    assert.equal(ok.final.payment.scheduledFor, '2026-12-02');

    const r10 = runs['10_brightline_photo_injection.jpg'];
    if (r10) {
      assert.throws(() => review(r10.id, { action: 'approve' }), (e) => e.status === 400);
      const rej = review(r10.id, { action: 'reject', note: 'Injected instructions, vendor denies sending it' });
      assert.deepEqual(rej.final, { decision: 'REJECT', by: 'reviewer', at: rej.final.at, payment: null });
      assert.equal(db.getLedger().find((l) => l.run_id === r10.id).status, 'rejected');
    }
  });

  await t.test('same file again: one DUPLICATE_INVOICE reason, worded without repeating the number, and no email', async () => {
    const run = await sampleRun('01_acme_happy.pdf');
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

  await t.test('retry: re-reads the stored file fresh as a new run that replaces the original', async () => {
    const orig = runs['09_sharma_gst_inr.pdf'];
    const seen = [];
    const id = retryRun(orig.id, { extractor: fixtureExtractor('09_sharma_gst_inr.pdf', seen) });
    assert.notEqual(id, orig.id);
    const run = await waitRun(id);
    assert.deepEqual(seen.map((o) => o.fresh), [true]);
    assert.equal(run.source, 'sample');
    assert.equal(run.retry_of, orig.id);
    assert.equal(run.file_sha, orig.file_sha);
    assert.equal(run.decision, 'APPROVE', `${run.headline} ${codes(run)}`); // not a duplicate of the run it retries
    assert.equal(stage(run, 'intake').data.seenBefore, null);
    const rows = db.getLedger().filter((l) => [orig.id, id].includes(l.run_id));
    assert.deepEqual(rows.map((r) => [r.run_id, r.status]), [[orig.id, 'superseded'], [id, 'approved']]);
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
  assert.throws(() => review(down.id, { action: 'approve' }), (e) => e.status === 409);

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
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 quote'), filename: 'q.pdf', extractor: exOf(quote) });
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
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 /Font credit-note'), filename: 'cn.pdf', extractor: exOf(credit) });
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
  const ok = review(run.id, { action: 'approve', note: 'Applied to next payment' });
  assert.equal(ok.final.payment, null);
});

test('junk bytes fail intake; an extractor bug never escapes', async () => {
  const junk = await runToEnd({ bytes: Buffer.from('hello'), filename: 'j.txt', extractor: fixtureExtractor('01_acme_happy.pdf') });
  assert.equal(junk.status, 'error');
  assert.equal(stage(junk, 'intake').status, 'failed');
  const bug = await runToEnd({ bytes: Buffer.from('%PDF-1.4 x'), filename: 'b.pdf', extractor: async () => ({ extraction: null, model: 'x', cached: false, latencyMs: 0, attempts: [] }) });
  assert.equal(bug.status, 'error');
  assert.equal(bug.result.errorKind, 'internal');
  assert.equal(stage(bug, 'extract').status, 'failed');
  assert.match(bug.result.headline, /^Something went wrong in read the invoice/);
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
    const api = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };
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
