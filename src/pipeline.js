// Runs the 7 stages for one invoice, persists every stage change, emits events for SSE, writes the ledger.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { today } from './config.js';
import * as db from './db.js';
import { sniff, sha256, extractInvoice } from './extract.js';
import { validate, matchVendor, matchPO, checkDuplicates, checkCreditNote, isCreditNote, normalizeInvoiceNumber, normalizePO, invoiceTotals, tokenSim } from './rules.js';
import { decide, schedulePayment, LABELS } from './decide.js';

export const STAGES = [
  ['intake', 'Intake'], ['extract', 'Read the invoice'], ['validate', 'Validate'], ['vendor', 'Vendor check'],
  ['duplicate', 'Duplicate check'], ['po_match', 'PO match'], ['decision', 'Decision'],
];
const TYPE_NAME = { 'application/pdf': 'PDF', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image' };

const iso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const minStageMs = () => (process.env.NODE_ENV === 'test' ? 0 : Number(process.env.PIPELINE_DELAY ?? 250) || 0);
const newId = () => 'r_' + Array.from(crypto.randomBytes(8), (b) => (b % 36).toString(36)).join('');

// ---------- events ----------
const emitters = new Map(); // run id → EventEmitter, only while someone is subscribed
const emit = (id, type, data) => emitters.get(id)?.emit('event', type, data);

/** Listen to a run's events: fn(type, data) with type 'stage' | 'run' | 'done'. Returns unsubscribe. */
export function subscribe(id, fn) {
  let e = emitters.get(id);
  if (!e) emitters.set(id, (e = new EventEmitter()));
  const h = (type, data) => fn(type, data);
  e.on('event', h);
  let on = true;
  return () => {
    if (!on) return;
    on = false;
    e.off('event', h);
    if (!e.listenerCount('event') && emitters.get(id) === e) emitters.delete(id);
  };
}

/** List-row shape shared by GET /api/runs and the SSE `run` event. */
export function summarize(run) {
  const { stages, extraction, result, review, final, ...row } = run;
  // primaryReason is what drove the decision; older runs predate it, so fall back to the first block, else the first hold.
  const main = result?.primaryReason ?? result?.reasons?.find((r) => r.severity === 'block') ?? result?.reasons?.find((r) => r.severity === 'hold');
  const vendorStage = stages?.find((s) => s.key === 'vendor');
  const poStage = stages?.find((s) => s.key === 'po_match');
  return {
    ...row, route: result?.route ?? null, mainReason: main?.message ?? null, review: review?.action ?? null,
    main_reason: main ? { code: main.code, severity: main.severity, label: main.label ?? LABELS[main.code] ?? main.code, message: main.message } : null,
    final_decision: final?.decision ?? null, reviewer: review?.reviewer ?? null,
    vendor_name: vendorStage?.data?.vendor?.name ?? extraction?.vendor?.name ?? null,
    po_inferred: Boolean(poStage?.data?.inferred),
  };
}

// ---------- run ----------
/** Insert a run and process it in the background. `extractor` replaces Gemini (tests). Returns the run id. */
export function startRun({ bytes, mime, filename, source = 'upload', fresh = false, extractor = extractInvoice, retryOf = null }) {
  const id = newId();
  const buf = Buffer.from(bytes ?? []);
  const sn = sniff(buf);
  const sha = sha256(buf);
  const stages = STAGES.map(([key, label]) => ({ key, label, status: 'pending', startedAt: null, endedAt: null, ms: null, summary: null, checks: [], data: null }));
  db.insertRun({
    id, created_at: iso(), filename: filename || 'upload', file_sha: sha, mime: sn.mime || mime || 'application/octet-stream',
    bytes: buf, source, status: 'running', stages, retry_of: retryOf,
  });
  execute({ id, buf, sn, sha, fresh, extractor, stages, retryOf }).catch((e) => console.error(`run ${id}:`, e));
  return id;
}

async function execute({ id, buf, sn, sha, fresh, extractor, stages, retryOf }) {
  const TODAY = today();
  // A retry replaces its original: never compare the file or the invoice with the run being retried.
  const ledgerNow = () => db.getLedger().filter((r) => !retryOf || r.run_id !== retryOf);
  const st = (key) => stages.find((s) => s.key === key);
  const save = (s) => { db.updateRun(id, { stages }); emit(id, 'stage', s); };
  let ex = null, v = null, mv = null, dup = null, mp = null, cn = null;
  const reasons = [];

  // Every stage: running → work → status. A throw marks the stage failed and ends the run as error.
  const runStage = async (key, fn) => {
    const s = st(key);
    Object.assign(s, { status: 'running', startedAt: iso() });
    save(s);
    const t = performance.now();
    let out;
    try { out = await fn(); } catch (e) {
      out = { status: 'failed', fatal: true, summary: `Error: ${e.message}`, checks: [{ label: 'Unexpected error', status: 'fail', detail: e.message }],
        headline: `Something went wrong in ${s.label.toLowerCase()}: ${e.message.replace(/\.$/, '')} — retry, or process this invoice by hand.`, error: e.message, errorKind: 'internal' };
    }
    s.ms = Math.round(performance.now() - t);
    const status = out.status ?? ((out.reasons ?? []).some((r) => r.severity !== 'info') ? 'warning' : 'passed');
    Object.assign(s, { status, endedAt: iso(), summary: out.summary ?? null, checks: out.checks ?? [], data: out.data ?? null });
    save(s);
    // Pause so a human can follow the live view; `ms` above is still the true work time.
    if (key !== 'decision' && !out.fatal) { const wait = minStageMs() - s.ms; if (wait > 0) await sleep(wait); }
    return out;
  };
  const skipRest = (summary) => {
    for (const s of stages) if (s.status === 'pending') { Object.assign(s, { status: 'skipped', summary }); save(s); }
  };
  const workMs = () => stages.reduce((a, s) => a + (s.ms ?? 0), 0); // true work time, without the readability pauses
  const finish = (patch) => {
    if (!db.getRun(id)) return; // reset while running
    db.updateRun(id, { ms: workMs(), extraction: ex, ...patch });
    emit(id, 'done', db.getRun(id));
  };
  const fail = (out) => {
    skipRest('Skipped — the run stopped earlier');
    finish({
      status: 'error', headline: out.headline,
      result: {
        decision: 'REVIEW', error: true, errorKind: out.errorKind ?? 'internal', headline: out.headline, reasons: [], primaryReason: null,
        explanation: `${String(out.error).replace(/\.$/, '')}. Nothing was decided and nothing will be paid.`,
        route: 'AP clerk', nextActions: out.nextActions ?? ['Retry the run in a minute.', 'If it keeps failing, process this invoice by hand.'],
        payment: null, vendorEmail: null,
      },
    });
  };

  // 1. intake
  let priorShas = [];
  let out = await runStage('intake', () => {
    const prior = db.listRuns().filter((r) => r.id !== id && r.id !== retryOf && r.status === 'done');
    priorShas = prior.map((r) => r.file_sha);
    const seenBefore = prior.find((r) => r.file_sha === sha)?.id ?? null;
    const kb = buf.length < 1024 * 1024 ? `${Math.max(1, Math.round(buf.length / 1024))} KB` : `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
    const data = { bytes: buf.length, mime: sn.mime, pages: sn.pages, kind: sn.kind, sha256: sha, seenBefore };
    if (!sn.mime) {
      return { status: 'failed', fatal: true, summary: "This file isn't a PDF or image", data, error: "This file isn't a PDF or image", errorKind: 'unreadable_file',
        checks: [{ label: 'File type', status: 'fail', detail: 'Not a PDF, PNG or JPEG' }],
        headline: "Couldn't read the document: this file isn't a PDF or image — upload a PDF, PNG or JPEG.",
        nextActions: ['Upload the invoice as a PDF, PNG or JPEG.'] };
    }
    const isPdf = sn.mime === 'application/pdf';
    // "PDF, 1 page, scanned" / "JPEG image (photo)"; size and hash are in the checks.
    const what = isPdf ? `PDF, ${plural(sn.pages, 'page')}, ${sn.kind === 'digital_text' ? 'digital' : 'scanned'}`
      : sn.mime === 'image/jpeg' ? 'JPEG image (photo)' : 'PNG image (scan or screenshot)';
    return {
      status: seenBefore ? 'warning' : 'passed', data,
      summary: `${what}${seenBefore ? ' — seen before' : ''}`,
      checks: [
        { label: 'File type', status: 'pass', detail: TYPE_NAME[sn.mime] },
        { label: 'Size', status: 'pass', detail: kb },
        ...(isPdf ? [{ label: 'Pages', status: 'info', detail: String(sn.pages) },
          { label: 'Text layer', status: 'info', detail: sn.hasTextLayer ? 'Digital text' : 'None: scanned image, read visually' }] : []),
        { label: 'SHA-256', status: 'info', detail: sha },
        { label: 'Same file seen before', status: seenBefore ? 'warn' : 'pass', detail: seenBefore ? `Processed before in run ${seenBefore}` : 'New file' },
      ],
    };
  });
  if (out.fatal) return fail(out);

  // 2. extract
  out = await runStage('extract', async () => {
    let x;
    try { x = await extractor(buf, sn.mime, { fresh, sha }); } catch (e) {
      const errorKind = ['unreadable_file', 'ai_unavailable'].includes(e.kind) ? e.kind : 'internal';
      const keyIssue = errorKind === 'ai_unavailable' && /API_KEY|API key/i.test(e.message);
      const [headline, nextActions] = errorKind === 'unreadable_file'
        ? ["Couldn't open this file — it may be corrupt or password-protected. Ask the vendor for a new copy.",
          ['Ask the vendor for a new copy of the invoice (not password-protected).', 'Upload the new copy, or process this invoice by hand.']]
        : keyIssue ? ["Couldn't read the document: the Gemini API key is missing or invalid — fix GEMINI_API_KEY and retry.", ['Set a valid GEMINI_API_KEY and retry.']]
          : errorKind === 'ai_unavailable' ? ["Couldn't read the document: Gemini unavailable — retry in a minute.", ['Retry the run in a minute.', 'If it keeps failing, process this invoice by hand.']]
            : [`Something went wrong while reading the invoice: ${e.message.replace(/\.$/, '')} — retry, or process this invoice by hand.`, ['Retry the run.', 'If it keeps failing, process this invoice by hand.']];
      return {
        status: 'failed', fatal: true, summary: `Couldn't read the document: ${e.message}`, error: e.message, errorKind, headline, nextActions,
        checks: [{ label: 'Gemini extraction', status: 'fail', detail: e.message }],
      };
    }
    ex = x.extraction;
    v = validate(ex, { today: TODAY });
    const tax = ex.tax_total ?? (ex.tax_lines.length ? ex.tax_lines.reduce((a, t) => a + (t.amount ?? 0), 0) : null);
    const c = ex.confidence ?? {};
    const f = (key, label, value, conf = null) => ({ key, label, value: value ?? null, confidence: conf });
    const fields = [
      f('vendor_name', 'Vendor name', ex.vendor?.name, c.vendor_name), f('tax_id', 'Tax ID', ex.vendor?.tax_id),
      f('invoice_number', 'Invoice number', ex.invoice_number, c.invoice_number), f('invoice_date', 'Invoice date', ex.invoice_date, c.invoice_date),
      f('due_date', 'Due date', ex.due_date), f('po_number', 'PO number', ex.po_number, c.po_number), f('currency', 'Currency', ex.currency),
      f('subtotal', 'Subtotal', ex.subtotal), f('tax', 'Tax', tax), f('total', 'Total', ex.total, c.total),
      f('payment_terms', 'Payment terms', ex.payment_terms), f('bank_account', 'Bank account', ex.bank_details?.account_number ?? ex.bank_details?.iban),
    ];
    const data = { model: x.model, cached: x.cached, latencyMs: x.latencyMs, ...(x.cached && { originalLatencyMs: x.originalLatencyMs ?? null }),
      attempts: x.attempts ?? [], ...(x.fallbackReason && { fallbackReason: x.fallbackReason }),
      fields, lineItems: [...ex.line_items], notices: [...ex.notices] };
    const checks = [
      { label: 'Model', status: 'info', detail: `${x.model}${x.cached ? ' (cached reading of this file)' : ''}` },
      ...(x.attempts ?? []).flatMap((a, i) => (a.error ? [{ label: `Attempt ${i + 1} failed (${a.model})`, status: 'warn', detail: `${a.status || 'network'}: ${a.error}` }] : [])),
      ...(x.fallbackReason ? [{ label: 'Gemini unavailable', status: 'warn', detail: `${x.fallbackReason}; using the earlier reading of this file` }] : []),
      { label: 'Source quality', status: 'info', detail: `${ex.source_quality.kind === 'scanned_image' ? 'Scanned image' : 'Digital text'}, legibility ${ex.source_quality.legibility}` },
      { label: 'Line items', status: 'info', detail: String(ex.line_items.length) },
    ];
    if (v.reasons.some((r) => r.code === 'NOT_AN_INVOICE')) {
      reasons.push(...v.reasons);
      return { status: 'failed', notInvoice: true, data, checks: [...checks, ...v.checks], summary: `Not an invoice — ${v.checks[0].detail.toLowerCase()}` };
    }
    const secs = (x.latencyMs / 1000).toFixed(1);
    return {
      status: x.fallbackReason ? 'warning' : 'passed', data, checks,
      summary: x.fallbackReason ? `Gemini unavailable; used the earlier reading (${x.model})`
        : x.cached ? `Loaded the earlier reading of this file (${x.model})`
          : `Read ${plural(fields.filter((q) => q.value !== null).length, 'field')} and ${plural(ex.line_items.length, 'line item')} with ${x.model} in ${secs} s`,
    };
  });
  if (out.fatal) return fail(out);

  if (!out.notInvoice) {
    // 3. validate
    out = await runStage('validate', () => {
      reasons.push(...v.reasons);
      const n = (s) => v.checks.filter((c) => c.status === s).length;
      const [p, w, f] = [n('pass'), n('warn'), n('fail')];
      return { reasons: v.reasons, checks: v.checks, data: v.data,
        summary: `${plural(p, 'check')} passed${f ? `, ${f} failed` : ''}${w ? `, ${plural(w, 'warning')}` : ''}` };
    });
    if (out.fatal) return fail(out);

    // 4. vendor
    const master = db.getMaster();
    out = await runStage('vendor', () => {
      mv = matchVendor(ex, master.vendors);
      reasons.push(...mv.reasons);
      const vd = mv.vendor;
      const bd = ex.bank_details;
      const differs = !!(mv.data.bankDiffs?.length || mv.data.bankNotice);
      const how = mv.method === 'tax_id' ? 'tax ID' : `name (${pct(mv.score)})`;
      return {
        reasons: mv.reasons, checks: mv.checks,
        summary: vd ? `Matched ${vd.name} by ${how}${vd.status === 'blocked' ? ' — vendor is blocked' : ''}${differs ? ' — bank details differ' : ''}`
          : `Unknown vendor${ex.vendor?.name ? `: "${ex.vendor.name}"` : ''}`,
        data: {
          vendor: vd && { vendor_id: vd.vendor_id, name: vd.name, status: vd.status, tax_id: vd.tax_id, remit_email: vd.remit_email },
          method: mv.method, score: mv.score,
          bank: {
            onFile: vd ? { bank_name: vd.bank_name, account: vd.bank_account, routing: vd.bank_routing } : null,
            onInvoice: bd && (bd.bank_name || bd.account_number || bd.routing_code || bd.iban)
              ? { bank_name: bd.bank_name, account: bd.account_number ?? bd.iban, routing: bd.routing_code } : null,
            differs,
          },
        },
      };
    });
    if (out.fatal) return fail(out);

    // 5. duplicate (before PO match, so a resend is not reported as an overrun against its own original)
    out = await runStage('duplicate', () => {
      let ledger = ledgerNow();
      let vendor = mv.vendor;
      if (!vendor && ex.vendor?.name) {
        // Unknown vendor: compare with earlier unknown-vendor invoices from a similar name.
        vendor = { vendor_id: null, name: ex.vendor.name };
        ledger = ledger.filter((r) => r.vendor_id == null && tokenSim(db.getRun(r.run_id)?.extraction?.vendor?.name ?? '', ex.vendor.name) >= 0.6);
      }
      dup = checkDuplicates(ex, vendor, ledger, { fileSha: sha, priorFileShas: priorShas });
      reasons.push(...dup.reasons);
      const has = (code) => dup.reasons.some((r) => r.code === code);
      const o = dup.original;
      const summary = has('DUPLICATE_INVOICE') ? `Already processed as ${o.invoice_number} (run ${o.run_id})`
        : has('POSSIBLE_DUPLICATE') ? `Possible duplicate of ${o.invoice_number ? `invoice ${o.invoice_number}` : 'an unnumbered invoice'} (run ${o.run_id})`
          : has('DUPLICATE_FILE') ? 'Same file processed before'
            : !vendor ? 'Skipped: vendor unknown'
              : !ex.invoice_number ? 'No invoice number, so only amount and date were compared' : 'No earlier invoice matches';
      return {
        status: dup.reasons.length || !ex.invoice_number ? 'warning' : 'passed',
        reasons: dup.reasons, checks: dup.checks, summary, data: { originalRunId: o?.run_id ?? null, original: o ?? null },
      };
    });
    if (out.fatal) return fail(out);

    // 6. PO match
    if (dup.reasons.some((r) => r.code === 'DUPLICATE_INVOICE')) {
      Object.assign(st('po_match'), { status: 'skipped', summary: 'Skipped — duplicate of an earlier invoice' });
      save(st('po_match'));
    } else if (isCreditNote(ex)) {
      // A credit note bills nothing, so no PO quantity or price checks; find the invoice it credits instead.
      out = await runStage('po_match', () => {
        cn = checkCreditNote(ex, mv.vendor, ledgerNow());
        reasons.push(...cn.reasons);
        return { reasons: cn.reasons, checks: cn.checks,
          summary: `Credit note${cn.original ? ` against ${cn.original.invoice_number}` : ''} — no PO quantity checks`,
          data: { po_number: ex.po_number ?? null, inferred: false, score: null, matchType: null, candidates: [], lines: [], creditNote: cn.data } };
      });
      if (out.fatal) return fail(out);
    } else {
      out = await runStage('po_match', () => {
        mp = matchPO(ex, mv.vendor, { ...master, ledger: ledgerNow() });
        reasons.push(...mp.reasons);
        const po = mp.po;
        const matchType = po ? (po.category === 'services' ? '2-way' : '3-way') : null;
        const poLines = po ? master.poLines.filter((l) => normalizePO(l.po_number) === normalizePO(po.po_number)) : [];
        const worst = (labels) => {
          const ss = mp.checks.filter((c) => labels.includes(c.label)).map((c) => c.status);
          return ss.includes('fail') ? 'fail' : ss.includes('warn') ? 'warn' : 'pass';
        };
        const lines = mp.lineMatches.map((l) => {
          const d = poLines.find((p) => Number(p.line_no) === Number(l.poLineNo))?.description;
          return {
            description: l.description, billedQty: l.qty, ordered: l.ordered, received: l.received, prevInvoiced: l.previouslyInvoicedQty,
            unitPrice: l.unitPrice, poUnitPrice: l.poUnitPrice, variancePct: l.variancePct,
            status: d ? worst([`Price: ${d}`, `Qty vs PO: ${d}`, `Qty vs receipt: ${d}`]) : 'warn',
          };
        });
        const issues = mp.reasons.filter((r) => r.severity !== 'info').length;
        const data = { po_number: po?.po_number ?? null, inferred: mp.inferred, score: mp.score, matchType,
          candidates: mp.candidates.map((c) => ({ po_number: c.po_number, score: c.score })), lines };
        if (!po && !mp.reasons.length) return { status: 'skipped', checks: mp.checks, data, summary: mp.checks[0]?.detail ?? 'Skipped' };
        const summary = po
          ? `${po.po_number} ${mp.inferred ? `inferred (score ${pct(mp.score)})` : `matched (${matchType})`}${issues ? `, ${plural(issues, 'issue')}` : ''}`
          : mp.reasons.some((r) => r.code === 'PO_AMBIGUOUS') ? `More than one PO fits (${mp.candidates.slice(0, 2).map((c) => c.po_number).join(' or ')})`
            : ex.po_number ? `${ex.po_number} not found` : 'No PO found';
        return { reasons: mp.reasons, checks: mp.checks, data, summary };
      });
      if (out.fatal) return fail(out);
    }
  } else skipRest('Skipped — not an invoice');

  // 7. decision + ledger
  let result;
  out = await runStage('decision', () => {
    result = decide({ ex, vendor: mv?.vendor ?? null, po: mp?.po ?? null, reasons, today: TODAY, inferred: mp?.inferred ?? false,
      original: dup?.original ?? cn?.original ?? null, sameFile: dup?.sameFile ?? false });
    const status = { APPROVE: 'approved', REVIEW: 'on_hold' }[result.decision];
    if (retryOf && db.getRun(id)) db.updateLedgerStatus(retryOf, 'superseded'); // the retry's own row (if any) replaces the original's
    if (status && db.getRun(id)) {
      db.insertLedger({
        run_id: id, vendor_id: mv?.vendor?.vendor_id ?? null, invoice_number: ex.invoice_number, invoice_number_norm: normalizeInvoiceNumber(ex.invoice_number),
        invoice_date: ex.invoice_date, net: mp?.net ?? invoiceTotals(ex).net, total: ex.total, currency: ex.currency,
        po_number: mp?.po?.po_number ?? ex.po_number ?? null, lines: mp?.ledgerLines ?? [], status, created_at: iso(),
      });
    }
    return {
      status: { APPROVE: 'passed', REVIEW: 'warning', REJECT: 'failed' }[result.decision], summary: result.headline, data: result,
      checks: result.reasons.map((r) => ({ label: r.label, status: r.severity === 'block' ? 'fail' : r.severity === 'hold' ? 'warn' : 'info', detail: r.message })),
    };
  });
  if (out.fatal) return fail(out);

  finish({
    status: 'done', decision: result.decision, headline: result.headline, vendor_id: mv?.vendor?.vendor_id ?? null,
    invoice_number: ex.invoice_number, total: ex.total, currency: ex.currency, po_number: mp?.po?.po_number ?? ex.po_number ?? null, result,
    // REVIEW stays open (final null) until a person decides.
    final: result.decision === 'REVIEW' ? null : { decision: result.decision, by: 'system', at: iso(), payment: result.payment },
  });
}

// ---------- human review ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });
// Approving these needs a call-back to the vendor on the master-file phone number first.
const CALLBACK_CODES = ['BANK_DETAILS_CHANGED', 'SUSPICIOUS_INSTRUCTIONS'];

/**
 * Approve or reject a held (REVIEW) invoice once: {action, reviewer, note, callbackVerified}.
 * Moves its ledger row, schedules payment on approval, records `review` and `final`; returns the updated run.
 */
export function reviewRun(id, { action, reviewer, note, callbackVerified } = {}) {
  const run = db.getRun(id);
  if (!run) throw httpError(404, 'Run not found');
  if (action !== 'approve' && action !== 'reject') throw httpError(400, 'Choose approve or reject.');
  if (run.status !== 'done' || run.decision !== 'REVIEW') throw httpError(409, 'Only invoices on hold (REVIEW) can be reviewed.');
  if (run.review) throw httpError(409, `This invoice was already ${run.review.action === 'approve' ? 'approved' : 'rejected'} by ${run.review.reviewer ?? 'a reviewer'}.`);
  const who = typeof reviewer === 'string' ? reviewer.trim() : '';
  const why = typeof note === 'string' ? note.trim() : '';
  if (who.length < 2) throw httpError(400, 'Add your name (at least 2 characters) so the decision can be traced.');
  if (why.length < 3) throw httpError(400, 'Add a short note (at least 3 characters) saying why.');
  const risky = (run.result?.reasons ?? []).find((r) => CALLBACK_CODES.includes(r.code));
  if (action === 'approve' && risky && callbackVerified !== true) {
    throw httpError(400, `Before approving, call the vendor on the phone number in our vendor master (never the one on the invoice) to confirm ${risky.code === 'BANK_DETAILS_CHANGED' ? 'the bank change' : 'the invoice is genuine'}, then tick "Call-back verified".`);
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  const ex = run.extraction ?? {};
  if (db.getLedger().some((r) => r.run_id === id)) db.updateLedgerStatus(id, status);
  else {
    db.insertLedger({
      run_id: id, vendor_id: run.vendor_id, invoice_number: run.invoice_number, invoice_number_norm: normalizeInvoiceNumber(run.invoice_number),
      invoice_date: ex.invoice_date ?? null, net: invoiceTotals(ex).net, total: run.total, currency: run.currency, po_number: run.po_number,
      lines: [], status, created_at: iso(),
    });
  }
  const at = iso();
  const vendor = db.getMaster().vendors.find((v) => v.vendor_id === run.vendor_id) ?? null;
  const payment = action === 'approve' ? schedulePayment(ex, vendor, today(), run.currency || ex.currency || vendor?.currency || 'USD') : null;
  db.updateRun(id, {
    review: { action, reviewer: who.slice(0, 200), note: why.slice(0, 2000), callbackVerified: callbackVerified === true, at },
    final: { decision: action === 'approve' ? 'APPROVE' : 'REJECT', by: 'reviewer', at, payment },
  });
  const updated = db.getRun(id);
  emit(id, 'run', summarize(updated));
  return updated;
}

/** Re-run a finished or failed run's file with a fresh extraction. Returns the new run id. */
export function retryRun(id, { extractor } = {}) {
  const run = db.getRun(id);
  if (!run) throw httpError(404, 'Run not found');
  if (run.status === 'running') throw httpError(409, 'This run is still in progress.');
  const f = db.getRunFile(id);
  return startRun({ bytes: f.bytes, mime: f.mime, filename: f.filename, source: run.source || 'upload', fresh: true, retryOf: id, ...(extractor && { extractor }) });
}
