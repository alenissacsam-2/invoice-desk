import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, PATHS, TOL, MAX_UPLOAD_BYTES } from './src/config.js';
import { openDb, getRun, getRunFile, listRuns, getMaster, getLedger, resetRuns } from './src/db.js';
import { sniff } from './src/extract.js';
import { normalizePO } from './src/rules.js';
import { startRun, subscribe, reviewRun, retryRun, summarize } from './src/pipeline.js';
import { LABELS } from './src/decide.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
const httpError = (status, message) => Object.assign(new Error(message), { status });

/** Serve `rel` from `dir`; refuses anything that resolves outside `dir`. */
function serveFile(res, dir, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return send(res, 400, 'bad path'); }
  const file = path.resolve(dir, '.' + path.sep + decoded);
  if (file !== dir && !file.startsWith(dir + path.sep)) return send(res, 404, 'not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

/** Read the request body, refusing more than `max` bytes with a 413 (the rest is drained, not buffered). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) { req.resume(); return reject(httpError(413, `The file is larger than ${max / 1024 / 1024} MB`)); }
    const chunks = [];
    let n = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > max) { over = true; reject(httpError(413, `The file is larger than ${max / 1024 / 1024} MB`)); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const manifest = () => JSON.parse(fs.readFileSync(path.join(PATHS.samples, 'manifest.json'), 'utf8'));
const runOr404 = (id) => getRun(id) ?? (() => { throw httpError(404, 'Run not found'); })();
// shortcut: full runs are loaded one by one for lists and stats; fine for demo volumes, move to SQL aggregates past a few thousand runs.
const allRuns = () => listRuns().map((r) => getRun(r.id));

async function createRun(req, res, m, url) {
  const fresh = url.searchParams.get('fresh') === '1';
  const sample = url.searchParams.get('sample');
  if (sample) {
    if (!manifest().some((s) => s.file === sample)) throw httpError(404, `Unknown sample: ${sample}`);
    const bytes = fs.readFileSync(path.join(PATHS.samples, sample));
    req.resume();
    return json(res, 202, { id: startRun({ bytes, mime: 'application/pdf', filename: sample, source: 'sample', fresh }) });
  }
  const bytes = await readBody(req, MAX_UPLOAD_BYTES);
  if (!bytes.length) throw httpError(400, 'Send the file as the request body, or use ?sample=<file>');
  const { mime } = sniff(bytes);
  if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime)) throw httpError(415, "This file isn't a PDF or image");
  let filename = String(req.headers['x-filename'] || 'upload');
  try { filename = decodeURIComponent(filename); } catch {}
  json(res, 202, { id: startRun({ bytes, mime, filename: path.basename(filename).slice(0, 200), source: 'upload', fresh }) });
}

function events(req, res, m) {
  const run = runOr404(m[1]);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('snapshot', run);
  if (run.status !== 'running') { ev('done', run); return res.end(); }
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  const unsub = subscribe(run.id, (type, data) => { ev(type, data); if (type === 'done') { cleanup(); res.end(); } });
  function cleanup() { clearInterval(hb); unsub(); }
  req.on('close', cleanup);
}

function sendRunFile(req, res, m) {
  const f = getRunFile(m[1]);
  if (!f) throw httpError(404, 'Run not found');
  const name = String(f.filename || 'invoice').replace(/["\\\r\n]/g, '_');
  res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${name}"`, 'Content-Length': f.bytes.length });
  res.end(Buffer.from(f.bytes));
}

async function review(req, res, m) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); } catch (e) {
    throw e.status ? e : httpError(400, 'Body must be JSON: {"action":"approve"|"reject","reviewer":"...","note":"...","callbackVerified":true|false}');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Body must be a JSON object.');
  json(res, 200, reviewRun(m[1], body));
}

function retry(req, res, m) {
  req.resume();
  json(res, 202, { id: retryRun(m[1]) });
}

/** Manifest plus, per sample, the latest run of that file still in the DB. */
function samples(req, res) {
  const runs = listRuns(); // newest first
  json(res, 200, manifest().map((s) => {
    const r = runs.find((x) => x.filename === s.file);
    return { ...s, processed: r ? { runId: r.id, decision: r.decision ?? null, final_decision: getRun(r.id)?.final?.decision ?? null } : null };
  }));
}

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

function stats(req, res) {
  const runs = allRuns();
  const done = runs.filter((r) => r.status === 'done');
  const byDecision = { APPROVE: 0, REVIEW: 0, REJECT: 0 }; // what the system decided
  for (const r of done) if (r.decision in byDecision) byDecision[r.decision]++;
  const final = {
    approved: done.filter((r) => r.final?.decision === 'APPROVE').length,
    rejected: done.filter((r) => r.final?.decision === 'REJECT').length,
    awaiting: done.filter((r) => r.decision === 'REVIEW' && !r.final).length,
  };
  const valueApproved = { USD: 0, INR: 0 };
  for (const r of done) {
    if (r.final?.decision !== 'APPROVE') continue;
    const cur = r.currency || 'USD';
    valueApproved[cur] = Math.round(((valueApproved[cur] ?? 0) + (r.total ?? 0)) * 100) / 100;
  }
  // Read time: the fresh Gemini latency, or for a cached run the latency of the reading it reused.
  const readMs = done.map((r) => {
    const d = r.stages?.find((s) => s.key === 'extract')?.data;
    return d ? (d.cached ? d.originalLatencyMs : d.latencyMs) : null;
  });
  // Count invoices, not reasons: two QTY lines on one invoice count once.
  const counts = new Map();
  for (const r of done) {
    const seen = new Set();
    for (const x of r.result?.reasons ?? []) {
      if ((x.severity !== 'hold' && x.severity !== 'block') || seen.has(x.code)) continue;
      seen.add(x.code);
      const c = counts.get(x.code) ?? { code: x.code, label: x.label ?? LABELS[x.code] ?? x.code, severity: x.severity, count: 0 };
      c.count++;
      counts.set(x.code, c);
    }
  }
  json(res, 200, {
    total: runs.length, byDecision, final, humanReviewed: done.filter((r) => r.review).length,
    errors: runs.filter((r) => r.status === 'error').length, awaitingReview: final.awaiting,
    autoApprovalRate: done.length ? byDecision.APPROVE / done.length : 0,
    valueApproved, medianMs: median(done.map((r) => r.ms)), medianReadMs: median(readMs),
    topReasons: [...counts.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  });
}

function data(req, res) {
  const { vendors, pos, poLines, receipts } = getMaster();
  const ledger = getLedger();
  const vname = (id) => vendors.find((v) => v.vendor_id === id)?.name ?? null;
  const r2 = (x) => Math.round(x * 100) / 100;
  json(res, 200, {
    vendors,
    pos: pos.map((po) => {
      const key = normalizePO(po.po_number);
      const approved = ledger.filter((l) => l.status === 'approved' && normalizePO(l.po_number) === key);
      const invoiced = r2(approved.reduce((a, l) => a + (l.net ?? 0), 0));
      return {
        ...po, vendor_name: vname(po.vendor_id), invoiced, remaining: r2(po.net_total - invoiced),
        lines: poLines.filter((l) => normalizePO(l.po_number) === key).sort((a, b) => a.line_no - b.line_no).map((l) => ({
          ...l,
          received: receipts.filter((g) => normalizePO(g.po_number) === key && g.line_no === l.line_no).reduce((a, g) => a + g.qty_received, 0),
          invoiced_qty: approved.flatMap((x) => x.lines).filter((x) => Number(x.po_line_no) === l.line_no).reduce((a, x) => a + (x.qty ?? 0), 0),
        })),
      };
    }),
    receipts,
    ledger: ledger.map((l) => ({ ...l, vendor_name: vname(l.vendor_id) })),
    policy: TOL,
  });
}

// Route table: [method, regex, handler(req, res, match, url)]. First match wins.
const routes = [
  ['GET', /^\/healthz$/, (req, res) => send(res, 200, 'ok')],
  ['GET', /^\/api\/samples$/, samples],
  ['POST', /^\/api\/runs$/, createRun],
  ['GET', /^\/api\/runs$/, (req, res, m, url) => {
    const d = url.searchParams.get('decision');
    if (d && !['APPROVE', 'REVIEW', 'REJECT'].includes(d)) throw httpError(400, 'decision must be APPROVE, REVIEW or REJECT');
    json(res, 200, listRuns(d ? { decision: d } : {}).map((r) => summarize(getRun(r.id))));
  }],
  ['GET', /^\/api\/runs\/([^/]+)$/, (req, res, m) => json(res, 200, runOr404(m[1]))],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, events],
  ['GET', /^\/api\/runs\/([^/]+)\/file$/, sendRunFile],
  ['POST', /^\/api\/runs\/([^/]+)\/review$/, review],
  ['POST', /^\/api\/runs\/([^/]+)\/retry$/, retry],
  ['GET', /^\/api\/stats$/, stats],
  ['GET', /^\/api\/data$/, data],
  ['POST', /^\/api\/reset$/, (req, res) => { resetRuns(); json(res, 200, { ok: true }); }],
  ['*', /^\/api(\/|$)/, (req, res) => json(res, 404, { error: 'Not found' })],
  ['GET', /^\/samples\/(.+)$/, (req, res, m) => serveFile(res, PATHS.samples, m[1])],
  ['GET', /^\/(.*)$/, (req, res, m) => serveFile(res, PATHS.public, m[1] || 'index.html')],
];

openDb();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (m && (req.method === method || method === '*')) {
      return Promise.resolve().then(() => handler(req, res, m, url)).catch((e) => {
        if (!e.status || e.status >= 500) console.error(e);
        if (res.headersSent) return res.end();
        const status = e.status ?? 500;
        if (url.pathname.startsWith('/api/')) json(res, status, { error: e.status ? e.message : 'Internal error' });
        else send(res, status, 'internal error');
      });
    }
  }
  send(res, 404, 'not found');
}).listen(PORT, () => console.log(`listening on :${PORT}`));
