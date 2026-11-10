import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, PATHS, TOL, MAX_UPLOAD_BYTES, LIMITS } from './src/config.js';
import { openDb, getRun, getRunFile, listRuns, getMaster, getLedger, getCachedExtraction } from './src/db.js';
import { sniff, sha256, readQueue } from './src/extract.js';
import * as rules from './src/rules.js';
import { startRun, subscribe, reviewRun, retryRun, summarize, resetAll, recoverInterrupted } from './src/pipeline.js';
import { LABELS } from './src/decide.js';

const { normalizePO } = rules;
const isCreditNote = (ex) => (rules.isCreditNote ? rules.isCreditNote(ex) : ex?.document_type === 'credit_note');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

// On every response. The PDF preview is an <iframe> of /api/runs/:id/file, hence frame-src/frame-ancestors 'self'.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
    + "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self'; object-src 'none'; base-uri 'none'; "
    + "frame-ancestors 'self'; connect-src 'self'",
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
  if (decoded.includes('\0')) return send(res, 400, 'bad path');
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

// ---------- public-demo protection ----------
// shortcut: X-Forwarded-For's first hop is client-supplied, so a determined caller can rotate it; the daily Gemini cap is the hard limit.
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?';

/** Sliding-window limiter: allow(key) is false once `max()` hits happened within `windowMs`. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    const ok = recent.length < max();
    if (ok) recent.push(now);
    hits.set(key, recent);
    if (hits.size > 10_000) for (const [k, ts] of hits) if (!ts.length || now - ts.at(-1) >= windowMs) hits.delete(k);
    return ok;
  };
}
const runLimit = limiter(() => LIMITS.runsPerIpPerHour, 3600_000);
const resetLimit = limiter(() => 1, LIMITS.resetEverySec * 1000);
const rateLimit = (req) => {
  if (!runLimit(clientIp(req))) throw httpError(429, `Too many invoices from your address: the demo allows ${LIMITS.runsPerIpPerHour} an hour. Try again later.`);
};

// Runs that need a fresh Gemini read (new file, ?fresh=1, retry), per UTC day. In memory: a restart resets it.
const gemini = { day: null, used: 0 };
const GEMINI_CAP_MSG = 'Daily AI reading limit reached for this demo — samples still work from cache';
function checkGemini() {
  const day = new Date().toISOString().slice(0, 10);
  if (gemini.day !== day) Object.assign(gemini, { day, used: 0 });
  if (gemini.used >= LIMITS.geminiDailyCap) throw httpError(429, GEMINI_CAP_MSG);
  if (readQueue().waiting >= LIMITS.maxQueuedReads) throw httpError(503, 'The demo is busy reading other invoices. Try again in a minute.');
}

// ---------- handlers ----------
const manifest = () => JSON.parse(fs.readFileSync(path.join(PATHS.samples, 'manifest.json'), 'utf8'));
const runOr404 = (id) => getRun(id) ?? (() => { throw httpError(404, 'Run not found'); })();
// shortcut: full runs are loaded one by one for lists and stats; fine for demo volumes (runs are capped at LIMITS.maxRuns).
const allRuns = () => listRuns().map((r) => getRun(r.id));

async function createRun(req, res, m, url, opts) {
  rateLimit(req);
  const fresh = url.searchParams.get('fresh') === '1';
  const sample = url.searchParams.get('sample');
  let run;
  if (sample) {
    if (!manifest().some((s) => s.file === sample)) throw httpError(404, `Unknown sample: ${sample}`);
    req.resume();
    const bytes = fs.readFileSync(path.join(PATHS.samples, sample));
    run = { bytes, mime: sniff(bytes).mime, filename: sample, source: 'sample' };
  } else {
    const bytes = await readBody(req, MAX_UPLOAD_BYTES);
    if (!bytes.length) throw httpError(400, 'Send the file as the request body, or use ?sample=<file>');
    const { mime } = sniff(bytes);
    if (!['application/pdf', 'image/png', 'image/jpeg'].includes(mime)) throw httpError(415, "This file isn't a PDF or image");
    let filename = String(req.headers['x-filename'] || 'upload');
    try { filename = decodeURIComponent(filename); } catch {}
    run = { bytes, mime, filename: path.basename(filename).slice(0, 200) || 'upload', source: 'upload' };
  }
  const needsGemini = fresh || !getCachedExtraction(sha256(run.bytes));
  if (needsGemini) checkGemini();
  const id = startRun({ ...run, fresh, ...(opts.extractor && { extractor: opts.extractor }) });
  if (needsGemini) gemini.used++;
  json(res, 202, { id });
}

function events(req, res, m) {
  const run = runOr404(m[1]);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  if (req.method === 'HEAD') return res.end();
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev('snapshot', run);
  if (run.status !== 'running') { ev('done', run); return res.end(); }
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  // `reset`: the run was deleted by POST /api/reset; the stream closes after it.
  const unsub = subscribe(run.id, (type, data) => { ev(type, data); if (type === 'done' || type === 'reset') { cleanup(); res.end(); } });
  function cleanup() { clearInterval(hb); unsub(); }
  req.on('close', cleanup);
}

/** RFC 6266: an ASCII `filename` for old clients plus the exact UTF-8 name in `filename*`. */
function contentDisposition(name) {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function sendRunFile(req, res, m) {
  const f = getRunFile(m[1]);
  if (!f) throw httpError(404, 'Run not found');
  if (!f.bytes) throw httpError(410, 'This file is no longer stored (only the newest runs keep their files).');
  const name = String(f.filename || 'invoice').replace(/[\r\n]/g, '_');
  res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': contentDisposition(name), 'Content-Length': f.bytes.length });
  res.end(Buffer.from(f.bytes));
}

async function review(req, res, m) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); } catch (e) {
    throw e.status ? e : httpError(400, 'Body must be JSON: {"action":"approve"|"reject","reviewer":"...","note":"...","callbackVerified":true|false}');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Body must be a JSON object.');
  json(res, 200, await reviewRun(m[1], body));
}

function retry(req, res, m, url, opts) {
  req.resume();
  rateLimit(req);
  // A retry always reads fresh, so it counts against the daily Gemini cap once it is known to be allowed.
  const id = retryRun(m[1], { ...(opts.extractor && { extractor: opts.extractor }), beforeStart: checkGemini });
  gemini.used++;
  json(res, 202, { id });
}

function reset(req, res) {
  req.resume();
  if (!resetLimit(clientIp(req))) throw httpError(429, `The demo can be reset once every ${LIMITS.resetEverySec} seconds. Try again shortly.`);
  resetAll();
  json(res, 200, { ok: true });
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
  const runs = allRuns().filter((r) => !r.superseded_by); // a retried run is replaced by its retry
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
    const amt = isCreditNote(r.extraction) ? -Math.abs(r.total ?? 0) : (r.total ?? 0);
    valueApproved[cur] = Math.round(((valueApproved[cur] ?? 0) + amt) * 100) / 100;
  }
  // Read time: the fresh Gemini latency, or for a cached run the latency of the reading it reused (null if unknown, then ignored).
  const readMs = done.map((r) => {
    const d = r.stages?.find((s) => s.key === 'extract')?.data;
    return d ? (d.cached ? d.originalLatencyMs ?? null : d.latencyMs) : null;
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

// Route table: [method, regex, handler(req, res, match, url, opts)]. First match wins. GET routes also answer HEAD.
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
  ['POST', /^\/api\/reset$/, reset],
  ['*', /^\/api(\/|$)/, (req, res) => json(res, 404, { error: 'Not found' })],
  ['GET', /^\/samples\/(.+)$/, (req, res, m) => serveFile(res, PATHS.samples, m[1])],
  ['GET', /^\/(.*)$/, (req, res, m) => serveFile(res, PATHS.public, m[1] || 'index.html')],
];

/** Methods the first matching routes accept, for OPTIONS. */
function allowed(pathname) {
  const methods = new Set();
  for (const [method, re] of routes) {
    if (!re.test(pathname)) continue;
    if (method === '*') break;
    methods.add(method);
  }
  if (methods.has('GET')) methods.add('HEAD');
  return [...methods, 'OPTIONS'].join(', ');
}

function handle(req, res, opts) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { req.resume(); return send(res, 400, 'bad request'); }
  const isApi = url.pathname.startsWith('/api/');
  const fail = (e) => {
    if (!e.status || e.status >= 500) console.error(e);
    if (res.headersSent) return res.end();
    const status = e.status ?? 500;
    if (isApi) json(res, status, { error: e.status ? e.message : 'Internal error' });
    else send(res, status, e.status ? e.message : 'internal error');
  };
  if (req.method === 'OPTIONS') { req.resume(); res.writeHead(204, { Allow: allowed(url.pathname) }); return res.end(); }
  // CSRF guard for the public demo: a cross-site form or no-cors fetch cannot set a custom header.
  if (req.method === 'POST' && req.headers['x-demo'] !== '1') { req.resume(); return json(res, 403, { error: 'Missing X-Demo header' }); }
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (m && (req.method === method || method === '*' || (req.method === 'HEAD' && method === 'GET'))) {
      return Promise.resolve().then(() => handler(req, res, m, url, opts)).catch(fail);
    }
  }
  req.resume();
  send(res, 404, 'not found');
}

/**
 * The app server, not yet listening. Opens the DB and marks runs cut off by a restart as errors.
 * `extractor` replaces Gemini (tests).
 */
export function createServer(opts = {}) {
  openDb();
  recoverInterrupted();
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => handle(req, res, opts));
  Object.assign(server, { requestTimeout: 30_000, headersTimeout: 15_000, maxConnections: 200 });
  // Malformed requests, oversized headers, timeouts: answer with a status instead of resetting the connection.
  server.on('clientError', (err, socket) => {
    if (err.code === 'ECONNRESET' || !socket.writable) return socket.destroy();
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
      : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Last resort: log and keep serving. Request errors are already answered by the route handler's catch.
  process.on('uncaughtException', (e) => console.error('uncaught exception:', e));
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
  createServer().listen(PORT, () => console.log(`listening on :${PORT}`));
}
