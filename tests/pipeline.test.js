import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the DB, pin the date and skip the readability pauses before any module reads the env.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.APP_TODAY ??= '2026-11-10';
process.env.PIPELINE_DELAY = '0';
const { startRun, subscribe, reviewRun } = await import('../src/pipeline.js');
const db = await import('../src/db.js');

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'manifest.json'), 'utf8'));
const fixture = (file) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', file.replace(/\.pdf$/, '.json')), 'utf8'));

// Stand-in for Gemini: the ground-truth fixture for whichever sample is being read.
const fixtureExtractor = (file) => async () => ({ extraction: fixture(file), model: 'fixture', cached: false, latencyMs: 1, attempts: [] });

/** Start a run and resolve with the finished run (subscribing before the first await, so `done` cannot be missed). */
function runToEnd(opts) {
  return new Promise((resolve) => {
    let id;
    const unsub = subscribe((id = startRun(opts)), (type) => { if (type === 'done') { unsub(); resolve(db.getRun(id)); } });
  });
}
const sampleRun = (file, extra = {}) => runToEnd({ bytes: fs.readFileSync(path.join(root, 'samples', file)), mime: 'application/pdf', filename: file, source: 'sample', extractor: fixtureExtractor(file), ...extra });
const codes = (run) => run.result.reasons.map((r) => r.code);
const stage = (run, key) => run.stages.find((s) => s.key === key);

test('the 9 samples in manifest order', async (t) => {
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
    });
  }

  await t.test('stage details', () => {
    const r1 = runs['01_acme_happy.pdf'];
    assert.ok(r1.stages.every((x) => x.status === 'passed'), r1.stages.map((x) => `${x.key}:${x.status}`).join(' '));
    const intake = stage(r1, 'intake').data;
    assert.equal(intake.mime, 'application/pdf');
    assert.equal(intake.seenBefore, null);
    assert.match(intake.sha256, /^[0-9a-f]{64}$/);
    const ext = stage(r1, 'extract').data;
    assert.equal(ext.fields.length, 12);
    assert.deepEqual(ext.fields.find((f) => f.key === 'total'), { key: 'total', label: 'Total', value: 4111.07, confidence: fixture('01_acme_happy.pdf').confidence.total });
    assert.equal(stage(r1, 'vendor').data.method, 'tax_id');
    assert.equal(stage(r1, 'vendor').data.bank.differs, false);
    const po1 = stage(r1, 'po_match').data;
    assert.equal(po1.matchType, '3-way');
    assert.ok(po1.lines.length === 3 && po1.lines.every((l) => l.status === 'pass'));

    const r3 = stage(runs['03_peakvalley_scanned_no_po.pdf'], 'po_match');
    assert.equal(r3.data.po_number, 'PO-2026-0377');
    assert.equal(r3.data.inferred, true);
    assert.match(r3.summary, /^PO-2026-0377 inferred \(score \d+%\)$/);

    const r5 = runs['05_northstar_split_2of2.pdf'];
    assert.equal(stage(r5, 'po_match').status, 'warning');
    const dock = stage(r5, 'po_match').data.lines.find((l) => /dock/i.test(l.description));
    assert.equal(dock.status, 'fail');
    assert.equal(r5.result.route, 'Receiving');

    const r6 = runs['06_acme_duplicate_resend.pdf'];
    assert.equal(stage(r6, 'po_match').status, 'skipped');
    assert.equal(stage(r6, 'po_match').summary, 'Skipped — duplicate of an earlier invoice');
    assert.equal(stage(r6, 'duplicate').data.originalRunId, r1.id);

    const r7 = stage(runs['07_kestrel_bank_change.pdf'], 'vendor');
    assert.equal(r7.status, 'warning');
    assert.equal(r7.data.bank.differs, true);
    assert.equal(r7.data.bank.onInvoice.routing, '063100277');
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

  await t.test('review: approving the held split invoice moves its ledger row to approved, once', () => {
    const id = runs['05_northstar_split_2of2.pdf'].id;
    const updated = reviewRun(id, { action: 'approve', note: 'Receiving confirmed the docks arrived' });
    assert.equal(updated.review.action, 'approve');
    assert.equal(db.getLedger().find((l) => l.run_id === id).status, 'approved');
    assert.throws(() => reviewRun(id, { action: 'reject' }), (e) => e.status === 409);
    assert.throws(() => reviewRun(runs['01_acme_happy.pdf'].id, { action: 'approve' }), (e) => e.status === 409);
    assert.throws(() => reviewRun('r_nope', { action: 'approve' }), (e) => e.status === 404);
    assert.throws(() => reviewRun(runs['07_kestrel_bank_change.pdf'].id, { action: 'maybe' }), (e) => e.status === 400);
  });

  await t.test('same file again: intake flags it, duplicate check rejects it', async () => {
    const run = await sampleRun('01_acme_happy.pdf');
    assert.equal(stage(run, 'intake').data.seenBefore, runs['01_acme_happy.pdf'].id);
    assert.ok(codes(run).includes('DUPLICATE_FILE'));
    assert.equal(run.decision, 'REJECT');
  });
});

test('extraction failure ends the run as error with a retry headline', async () => {
  const run = await runToEnd({ bytes: fs.readFileSync(path.join(root, 'samples', '01_acme_happy.pdf')), filename: 'x.pdf',
    extractor: async () => { throw new Error('Gemini is unavailable (503) after retries on m: overloaded'); } });
  assert.equal(run.status, 'error');
  assert.equal(run.decision, null);
  assert.equal(stage(run, 'extract').status, 'failed');
  assert.ok(run.stages.slice(2).every((x) => x.status === 'skipped'));
  assert.equal(run.result.decision, 'REVIEW');
  assert.equal(run.result.headline, "Couldn't read the document: Gemini unavailable — retry in a minute.");
  assert.equal(db.getLedger().filter((l) => l.run_id === run.id).length, 0);
  assert.throws(() => reviewRun(run.id, { action: 'approve' }), (e) => e.status === 409);
});

test('not an invoice: extract fails, middle stages skipped, decision REJECT', async () => {
  const quote = { ...fixture('01_acme_happy.pdf'), is_invoice: false, document_type: 'quote' };
  const run = await runToEnd({ bytes: Buffer.from('%PDF-1.4 quote'), filename: 'q.pdf', extractor: async () => ({ extraction: quote, model: 'fixture', cached: false, latencyMs: 1, attempts: [] }) });
  assert.equal(run.status, 'done');
  assert.equal(run.decision, 'REJECT');
  assert.deepEqual(codes(run), ['NOT_AN_INVOICE']);
  assert.equal(stage(run, 'extract').status, 'failed');
  assert.ok(['validate', 'vendor', 'duplicate', 'po_match'].every((k) => stage(run, k).status === 'skipped'));
  assert.equal(stage(run, 'decision').status, 'failed');
});

test('junk bytes fail intake; an extractor bug never escapes', async () => {
  const junk = await runToEnd({ bytes: Buffer.from('hello'), filename: 'j.txt', extractor: fixtureExtractor('01_acme_happy.pdf') });
  assert.equal(junk.status, 'error');
  assert.equal(stage(junk, 'intake').status, 'failed');
  const bug = await runToEnd({ bytes: Buffer.from('%PDF-1.4 x'), filename: 'b.pdf', extractor: async () => ({ extraction: null, model: 'x', cached: false, latencyMs: 0, attempts: [] }) });
  assert.equal(bug.status, 'error');
  assert.equal(stage(bug, 'extract').status, 'failed');
  assert.match(bug.result.headline, /^Something went wrong in read the invoice/);
});
