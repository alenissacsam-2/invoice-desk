// Runs the 7 stages for one invoice, persists every stage change, emits events for SSE, writes the ledger.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { today } from './config.js';
import * as db from './db.js';
import { sniff, sha256, extractInvoice } from './extract.js';
import * as rules from './rules.js';
import * as decideJs from './decide.js';

const { validate, matchVendor, matchPO, checkDuplicates, checkCreditNote, normalizeInvoiceNumber, normalizePO, invoiceTotals, tokenSim } = rules;
const { decide, schedulePayment, LABELS } = decideJs;
const isCreditNote = (ex) => (rules.isCreditNote ? rules.isCreditNote(ex) : ex?.document_type === 'credit_note');
// Approving these needs a call-back to the vendor on the master-file phone number first.
const CALLBACK_CODES = decideJs.CALLBACK_CODES ?? ['BANK_DETAILS_CHANGED', 'SUSPICIOUS_INSTRUCTIONS', 'REMIT_DOMAIN_LOOKALIKE'];
// A credit note is stored as a negative amount, whatever sign the document printed.
const signed = (ex, n) => (typeof n === 'number' && isCreditNote(ex) ? -Math.abs(n) : n);

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

// ---------- ledger lock ----------
// Duplicate check → PO match → ledger write must see every earlier decision, so runs take turns through that stretch.
// Extraction (the slow part) stays concurrent.
let ledgerTail = Promise.resolve();
function lockLedger() {
  let release;
  const prev = ledgerTail;
  ledgerTail = new Promise((r) => (release = r));
  return prev.then(() => release);
}

// ---------- events ----------
const emitters = new Map(); // run id → EventEmitter, only while someone is subscribed
const emit = (id, type, data) => emitters.get(id)?.emit('event', type, data);

/** Listen to a run's events: fn(type, data) with type 'stage' | 'run' | 'done'. Returns unsubscribe. */
export function subscribe(id, fn) {
  let e = emitters.get(id);
  if (!e) { emitters.set(id, (e = new EventEmitter())); e.setMaxListeners(0); } // one listener per SSE client
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
  // Demo replay: running a sample again supersedes earlier runs of it, and of the exact same bytes uploaded by hand,
  // so the replay decides fresh instead of being caught as a duplicate of itself. Uploads keep full duplicate detection.
  if (source === 'sample' && !retryOf) {
    for (const r of db.listRuns()) {
      const same = r.file_sha === sha || (r.source === 'sample' && r.filename === filename);
      if (r.id === id || !same || r.superseded_by) continue;
      db.updateRun(r.id, { superseded_by: id });
      db.updateLedgerStatus(r.id, 'superseded');
      emit(r.id, 'run', summarize(db.getRun(r.id)));
    }
  }
  const lock = { release: null };
  execute({ id, buf, sn, sha, fresh, extractor, stages, retryOf, lock }).catch((e) => console.error(`run ${id}:`, e)).finally(() => lock.release?.());
  return id;
}

/** Clear runs and ledger; every open event stream gets `reset` and closes. In-flight runs find their row gone and write nothing. */
export function resetAll() {
  db.resetRuns();
  for (const e of emitters.values()) e.emit('event', 'reset', null);
  emitters.clear();
}

/** On boot: a run still `running` was cut off by a restart. Mark it as an error that can be retried. */
export function recoverInterrupted() {
  const headline = 'Interrupted by a server restart — retry it';
  for (const { id } of db.listRuns().filter((r) => r.status === 'running')) {
    const run = db.getRun(id);
    const stages = (run.stages ?? []).map((s) => (s.status === 'running' ? { ...s, status: 'failed', summary: 'Interrupted by a server restart' }
      : s.status === 'pending' ? { ...s, status: 'skipped', summary: 'Skipped — the run stopped earlier' } : s));
    db.updateRun(id, {
      status: 'error', headline, stages,
      result: { decision: 'REVIEW', error: true, errorKind: 'internal', headline, reasons: [], primaryReason: null,
        explanation: 'The server restarted while this invoice was being processed. Nothing was decided and nothing will be paid.',
        route: 'AP clerk', nextActions: ['Retry the run.'], payment: null, vendorEmail: null },
    });
  }
}

async function execute({ id, buf, sn, sha, fresh, extractor, stages, retryOf, lock }) {
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
  const priorDone = () => db.listRuns().filter((r) => r.id !== id && r.id !== retryOf && r.status === 'done' && !r.superseded_by);
  const priorDoneShas = () => priorDone().map((r) => r.file_sha);
  let out = await runStage('intake', () => {
    const prior = priorDone();
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
    if (sn.broken) {
      const enc = sn.broken === 'encrypted';
      return { status: 'failed', fatal: true, summary: `Couldn't open this PDF: ${enc ? 'password-protected' : 'damaged or incomplete'}`, data,
        error: `PDF is ${sn.broken}`, errorKind: 'unreadable_file',
        checks: [{ label: 'File opens', status: 'fail', detail: enc ? 'Encrypted (password-protected) PDF' : 'No pages and no end-of-file marker' }],
        headline: `Couldn't open this file — ${enc ? 'it is password-protected' : 'it may be corrupt or password-protected'}. Ask the vendor for a new copy.`,
        nextActions: ['Ask the vendor for a new copy of the invoice (not password-protected).', 'Upload the new copy, or process this invoice by hand.'] };
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
      const keyIssue = errorKind === 'ai_unavailable' && (e.config === 'key' || /API_KEY|API key/i.test(e.message));
      const configIssue = errorKind === 'ai_unavailable' && e.config === 'request';
      const [headline, nextActions] = errorKind === 'unreadable_file'
        ? ["Couldn't open this file — it may be corrupt or password-protected. Ask the vendor for a new copy.",
          ['Ask the vendor for a new copy of the invoice (not password-protected).', 'Upload the new copy, or process this invoice by hand.']]
        : keyIssue ? ["Couldn't read the document: the Gemini API key is missing or invalid — fix GEMINI_API_KEY and retry.", ['Set a valid GEMINI_API_KEY and retry.']]
          : configIssue ? ["Couldn't read the document: Gemini rejected the request (a model or configuration problem, not the file) — check GEMINI_MODEL and retry.", ['Check GEMINI_MODEL and GEMINI_FALLBACK_MODEL, then retry.']]
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

    // From here to the ledger write, one run at a time (released when the run ends).
    lock.release = await lockLedger();

    // 5. duplicate (before PO match, so a resend is not reported as an overrun against its own original)
    out = await runStage('duplicate', () => {
      priorShas = priorDoneShas();
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
        const data = { po_number: po?.po_number ?? null, inferred: mp.inferred, score: mp.score, matchType, previouslyInvoicedNet: mp.data?.previouslyInvoicedNet ?? null,
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
    const self = db.getRun(id);
    // A run replayed while still in flight must not book anything: its replacement decides instead.
    const status = self?.superseded_by ? 'superseded' : { APPROVE: 'approved', REVIEW: 'on_hold' }[result.decision];
    if (status && self) { // no row: reset while running
      db.insertLedger({
        run_id: id, vendor_id: mv?.vendor?.vendor_id ?? null, invoice_number: ex.invoice_number, invoice_number_norm: normalizeInvoiceNumber(ex.invoice_number),
        invoice_date: ex.invoice_date, net: signed(ex, mp?.net ?? invoiceTotals(ex).net), total: signed(ex, ex.total), currency: ex.currency,
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
    final: result.decision === 'REVIEW' ? null : { decision: result.decision, by: 'system', at: iso(), payment: isCreditNote(ex) ? null : result.payment },
  });
}

// ---------- human review ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });
const OVER_PO = ['QTY_EXCEEDS_PO', 'QTY_EXCEEDS_RECEIPT', 'PO_OVERRUN'];

/**
 * Approve or reject a held (REVIEW) invoice once: {action, reviewer, note, callbackVerified}.
 * Moves its ledger row, schedules payment on approval, records `review` and `final`; resolves to the updated run.
 * Runs under the ledger lock, so an approval and a run being decided never miss each other.
 */
export async function reviewRun(id, body = {}) {
  const release = await lockLedger();
  try { return reviewNow(id, body); } finally { release(); }
}

function reviewNow(id, { action, reviewer, note, callbackVerified }) {
  const run = db.getRun(id);
  if (!run) throw httpError(404, 'Run not found');
  if (action !== 'approve' && action !== 'reject') throw httpError(400, 'Choose approve or reject.');
  if (run.superseded_by) throw httpError(409, `Replaced by a later run, ${run.superseded_by}.`);
  if (run.status !== 'done' || run.decision !== 'REVIEW') throw httpError(409, 'Only invoices on hold (REVIEW) can be reviewed.');
  if (run.review) throw httpError(409, `This invoice was already ${run.review.action === 'approve' ? 'approved' : 'rejected'} by ${run.review.reviewer ?? 'a reviewer'}.`);
  const who = typeof reviewer === 'string' ? reviewer.trim() : '';
  const why = typeof note === 'string' ? note.trim() : '';
  if (who.length < 2) throw httpError(400, 'Add your name (at least 2 characters) so the decision can be traced.');
  if (why.length < 3) throw httpError(400, 'Add a short note (at least 3 characters) saying why.');
  const risky = (run.result?.reasons ?? []).find((r) => CALLBACK_CODES.includes(r.code));
  if (action === 'approve' && risky && callbackVerified !== true) {
    throw httpError(400, `Before approving, call the vendor on the phone number in our vendor master (never the one on the invoice) to confirm ${risky.code === 'BANK_DETAILS_CHANGED' ? 'the bank change' : 'the invoice is genuine'}, then tick the call-back confirmation.`);
  }

  const ex = run.extraction ?? {};
  const master = db.getMaster();
  const vendor = master.vendors.find((v) => v.vendor_id === run.vendor_id) ?? null;
  const credit = isCreditNote(ex);
  const mp = action === 'approve' && run.extraction && !credit ? recheckApproval(run, vendor, master) : null;

  const status = action === 'approve' ? 'approved' : 'rejected';
  if (db.getLedger().some((r) => r.run_id === id)) db.updateLedgerStatus(id, status);
  else {
    db.insertLedger({
      run_id: id, vendor_id: run.vendor_id, invoice_number: run.invoice_number, invoice_number_norm: normalizeInvoiceNumber(run.invoice_number),
      invoice_date: ex.invoice_date ?? null, net: signed(ex, mp?.net ?? invoiceTotals(ex).net), total: signed(ex, run.total), currency: run.currency, po_number: run.po_number,
      lines: mp?.ledgerLines ?? [], status, created_at: iso(),
    });
  }
  const at = iso();
  const payment = action === 'approve' && !credit ? schedulePayment(ex, vendor, today(), run.currency || ex.currency || vendor?.currency || 'USD') : null;
  db.updateRun(id, {
    review: { action, reviewer: who.slice(0, 200), note: why.slice(0, 2000), callbackVerified: callbackVerified === true, at },
    final: { decision: action === 'approve' ? 'APPROVE' : 'REJECT', by: 'reviewer', at, payment },
  });
  const updated = db.getRun(id);
  emit(id, 'run', summarize(updated));
  return updated;
}

/**
 * Before an approval: re-run the duplicate and PO checks against the ledger as it is now.
 * 409 if the invoice was approved elsewhere since, or if other approvals since the hold mean this one now goes over its PO.
 * Over-PO findings the reviewer already saw at hold time (same PO consumption as then) are theirs to override. Returns the PO match.
 */
function recheckApproval(run, vendor, master) {
  const ex = run.extraction;
  const approved = db.getLedger().filter((r) => r.run_id !== run.id && r.status === 'approved');
  const dup = vendor ? checkDuplicates(ex, vendor, approved) : null;
  if (dup?.reasons.some((r) => r.code === 'DUPLICATE_INVOICE')) {
    throw httpError(409, `Invoice ${ex.invoice_number} was already approved in run ${dup.original.run_id}; approving this one too would pay it twice. Reject it instead.`);
  }
  const mp = matchPO(ex, vendor, { ...master, ledger: approved });
  const over = mp.reasons.filter((r) => OVER_PO.includes(r.code));
  const was = run.stages?.find((s) => s.key === 'po_match')?.data;
  const sameAsHold = was && was.po_number === (mp.po?.po_number ?? null)
    && JSON.stringify((was.lines ?? []).map((l) => l.prevInvoiced ?? null)) === JSON.stringify(mp.lineMatches.map((l) => l.previouslyInvoicedQty ?? null))
    && (was.previouslyInvoicedNet == null || Math.abs(was.previouslyInvoicedNet - (mp.data?.previouslyInvoicedNet ?? 0)) < 0.01);
  if (over.length && !sameAsHold) {
    throw httpError(409, `Since this invoice was put on hold, other invoices were approved against ${mp.po?.po_number ?? 'its PO'}, so approving it now would go over the PO: ${over.map((r) => r.message).join(' ')} Reject it, or have Procurement amend the PO first.`);
  }
  return mp;
}

/**
 * Re-read a failed run, or an invoice still on hold, as a new run with a fresh extraction. Returns the new run id.
 * The original is marked `superseded_by` the new run: it can no longer be reviewed, and its ledger row stops counting.
 * `beforeStart` runs once the retry is known to be allowed (the server charges its quota there).
 */
export function retryRun(id, { extractor, beforeStart } = {}) {
  const run = db.getRun(id);
  if (!run) throw httpError(404, 'Run not found');
  if (run.superseded_by) throw httpError(409, `Already replaced by a later run, ${run.superseded_by}.`);
  if (run.status === 'running') throw httpError(409, 'This run is still in progress.');
  const onHold = run.status === 'done' && run.decision === 'REVIEW' && !run.review && !run.final;
  if (run.status !== 'error' && !onHold) throw httpError(409, 'Only failed runs and invoices still on hold (not yet reviewed) can be retried.');
  const f = db.getRunFile(id);
  if (!f?.bytes) throw httpError(409, 'The original file is no longer stored, so this run cannot be retried. Upload the invoice again.');
  beforeStart?.();
  const newId = startRun({ bytes: f.bytes, mime: f.mime, filename: f.filename, source: run.source || 'upload', fresh: true, retryOf: id, ...(extractor && { extractor }) });
  db.updateRun(id, { superseded_by: newId });
  db.updateLedgerStatus(id, 'superseded');
  emit(id, 'run', summarize(db.getRun(id)));
  return newId;
}
