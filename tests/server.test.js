import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

// In-process server on an ephemeral port: temp DB, no Gemini key, a stub extractor that serves the fixtures.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.APP_TODAY ??= '2026-11-10';
process.env.PIPELINE_DELAY = '0';
process.env.GEMINI_API_KEY = '';
const { createServer } = await import('../server.js');
const db = await import('../src/db.js');
const { sha256 } = await import('../src/extract.js');
const { LIMITS } = await import('../src/config.js');

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'manifest.json'), 'utf8'));
const sampleBytes = (f) => fs.readFileSync(path.join(root, 'samples', f));
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', f.replace(/\.\w+$/, '.json')), 'utf8'));

const bySha = new Map(manifest.map((s) => [sha256(sampleBytes(s.file)), fixture(s.file)]));
const gates = new Map(); // sha → promise the extractor waits on
const noLatency = new Set(); // shas answered as a cached reading whose original read time is unknown
const extractor = async (bytes, mime, { sha }) => {
  await gates.get(sha);
  const fx = bySha.get(sha);
  if (!fx) throw Object.assign(new Error('Gemini is unavailable (503)'), { kind: 'ai_unavailable' });
  if (noLatency.has(sha)) return { extraction: fx, model: 'fixture', cached: true, latencyMs: 0, originalLatencyMs: null, attempts: [] };
  return { extraction: fx, model: 'fixture', cached: false, latencyMs: 5, attempts: [] };
};

let server, base, port;
before(async () => {
  db.openDb();
  for (const s of manifest) db.putCachedExtraction(sha256(sampleBytes(s.file)), 'fixture', fixture(s.file), 2000); // samples count as cached
  server = createServer({ extractor });
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  base = `http://localhost:${port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

let ipN = 0;
const freshIp = () => `10.0.${Math.floor(++ipN / 250)}.${ipN % 250}`; // each test its own client, so rate limits don't leak between tests
const req = (p, { method = 'GET', headers = {}, body, ip } = {}) => fetch(base + p, {
  method, body, headers: { ...(method === 'POST' && { 'X-Demo': '1' }), ...(ip && { 'X-Forwarded-For': ip }), ...headers },
});
const api = async (p, opts) => { const r = await req(p, opts); return { status: r.status, body: await r.json(), headers: r.headers }; };
const done = async (id) => { for (;;) { const { body } = await api(`/api/runs/${id}`); if (body.status !== 'running') return body; await new Promise((r) => setTimeout(r, 20)); } };
const sample = async (f, ip = freshIp()) => done((await api(`/api/runs?sample=${encodeURIComponent(f)}`, { method: 'POST', ip })).body.id);
const resetDemo = () => api('/api/reset', { method: 'POST', ip: freshIp() });

/** Raw HTTP: send `text`, resolve with the status line (or what happened). */
const raw = (text) => new Promise((resolve) => {
  const s = net.connect(port, 'localhost', () => s.write(text));
  let d = '';
  s.on('data', (c) => (d += c));
  s.on('close', () => resolve(d.split('\r\n')[0] || 'closed without a response'));
  s.on('error', (e) => resolve(`error ${e.code}`));
});

test('malformed request targets and bad paths get 400, and the server keeps serving', async () => {
  assert.equal(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  assert.equal((await req('/healthz')).status, 200);
  for (const p of ['/samples/%00', '/%00', '/%E0%A4%A', '/samples/%']) {
    const r = await req(p);
    const text = await r.text();
    assert.equal(r.status, 400, p);
    assert.doesNotMatch(text, /\bat \w|Error/, `${p}: no stack trace`);
  }
  assert.equal(await raw('GET /\0 HTTP/1.1\r\nHost: x\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
});

test('oversized headers get 431, not a reset connection', async () => {
  assert.equal(await raw(`GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20 * 1024)}\r\n\r\n`), 'HTTP/1.1 431 Request Header Fields Too Large');
  assert.equal(server.requestTimeout, 30_000);
  assert.equal(server.headersTimeout, 15_000);
  assert.equal(server.maxConnections, 200);
});

test('security headers on every response', async () => {
  for (const p of ['/', '/api/stats', '/nope', '/samples/01_acme_happy.pdf']) {
    const r = await req(p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', p);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'; script-src 'self';.*frame-ancestors 'self'/, p);
  }
});

test('POST without X-Demo is refused (CSRF guard)', async () => {
  for (const p of ['/api/runs?sample=01_acme_happy.pdf', '/api/reset', '/api/runs/x/retry', '/api/runs/x/review']) {
    const r = await fetch(base + p, { method: 'POST' });
    assert.equal(r.status, 403, p);
    assert.deepEqual(await r.json(), { error: 'Missing X-Demo header' });
  }
});

test('HEAD and OPTIONS; samples served with the right type', async () => {
  const run = await sample('09_sharma_gst_inr.pdf');
  for (const [p, type] of [['/', /text\/html/], ['/samples/01_acme_happy.pdf', /application\/pdf/], [`/api/runs/${run.id}/file`, /application\/pdf/], ['/samples/10_brightline_photo_injection.jpg', /image\/jpeg/]]) {
    const r = await req(p, { method: 'HEAD' });
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
    assert.equal((await r.arrayBuffer()).byteLength, 0, `${p}: HEAD has no body`);
  }
  assert.match((await req('/samples/10_brightline_photo_injection.jpg')).headers.get('content-type'), /^image\/jpeg/);
  const o = await req('/api/runs', { method: 'OPTIONS' });
  assert.equal(o.status, 204);
  assert.equal(o.headers.get('allow'), 'POST, GET, HEAD, OPTIONS');
  assert.equal((await req(`/api/runs/${run.id}/review`, { method: 'OPTIONS' })).headers.get('allow'), 'POST, OPTIONS');
});

test('non-Latin-1 file names download with an ASCII filename and an exact filename*', async () => {
  const name = 'Ünïcødé 請求書 "x".pdf';
  const { body } = await api('/api/runs', { method: 'POST', ip: freshIp(), body: sampleBytes('09_sharma_gst_inr.pdf'), headers: { 'X-Filename': encodeURIComponent(name) } });
  await done(body.id);
  const r = await req(`/api/runs/${body.id}/file`);
  assert.equal(r.status, 200);
  const cd = r.headers.get('content-disposition');
  assert.match(cd, /^inline; filename="Unic_de ___ _x_\.pdf"; filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(cd.split("UTF-8''")[1]), name);
});

test('retry over HTTP: the original is superseded, cannot be reviewed, and drops out of stats', async () => {
  await resetDemo();
  const r7 = await sample('07_kestrel_bank_change.pdf');
  assert.equal(r7.decision, 'REVIEW');
  const r1 = await sample('01_acme_happy.pdf');
  assert.equal((await api(`/api/runs/${r1.id}/retry`, { method: 'POST', ip: freshIp() })).status, 409, 'an approved run cannot be retried');
  const { status, body } = await api(`/api/runs/${r7.id}/retry`, { method: 'POST', ip: freshIp() });
  assert.equal(status, 202);
  const again = await done(body.id);
  assert.equal(again.retry_of, r7.id);
  assert.equal((await api(`/api/runs/${r7.id}`)).body.superseded_by, body.id);
  assert.equal((await api('/api/runs')).body.find((x) => x.id === r7.id).superseded_by, body.id);
  const rev = await api(`/api/runs/${r7.id}/review`, { method: 'POST', body: JSON.stringify({ action: 'reject', reviewer: 'Sam', note: 'dup check' }) });
  assert.equal(rev.status, 409);
  assert.equal(rev.body.error, `Superseded by retry ${body.id}`);
  const stats = (await api('/api/stats')).body;
  assert.equal(stats.total, 2, 'the superseded run is not counted');
  assert.deepEqual(stats.byDecision, { APPROVE: 1, REVIEW: 1, REJECT: 0 });
});

test('a cached reading with no recorded read time reports null, and the median ignores it', async () => {
  await resetDemo();
  noLatency.add(sha256(sampleBytes('03_peakvalley_scanned_no_po.pdf')));
  const run = await sample('03_peakvalley_scanned_no_po.pdf');
  const ext = run.stages.find((s) => s.key === 'extract').data;
  assert.equal(ext.cached, true);
  assert.equal(ext.originalLatencyMs, null);
  assert.equal((await api('/api/stats')).body.medianReadMs, null);
});

test('per-IP rate limit: 30 Gemini-costing runs an hour; cached samples stay free', async () => {
  const ip = freshIp();
  const unique = (i) => Buffer.from(`%PDF-1.4 /Font rate-limit-${ip}-${i}`); // never cached, so each needs a read
  for (let i = 0; i < LIMITS.runsPerIpPerHour; i++) assert.equal((await api('/api/runs', { method: 'POST', ip, body: unique(i) })).status, 202);
  const r = await api('/api/runs', { method: 'POST', ip, body: unique('over') });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /30 an hour/);
  assert.equal((await api('/api/runs/x/retry', { method: 'POST', ip })).status, 429);
  await sample('03_peakvalley_scanned_no_po.pdf'); // warm the cache
  assert.equal((await api('/api/runs?sample=03_peakvalley_scanned_no_po.pdf', { method: 'POST', ip })).status, 202, 'cached samples are not limited');
  assert.equal((await api('/api/runs', { method: 'POST', ip: freshIp(), body: unique('other') })).status, 202, 'other clients are not affected');
});

test('reset: at most once every 30 s per client', async () => {
  const ip = freshIp();
  assert.equal((await api('/api/reset', { method: 'POST', ip })).status, 200);
  const r = await api('/api/reset', { method: 'POST', ip });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /once every 30 seconds/);
});

test('daily Gemini cap: new files and fresh reads get 429, cached samples still work', async () => {
  const cap = LIMITS.geminiDailyCap;
  LIMITS.geminiDailyCap = 0;
  try {
    const up = await api('/api/runs', { method: 'POST', ip: freshIp(), body: Buffer.from('%PDF-1.4 /Font never seen') });
    assert.equal(up.status, 429);
    assert.equal(up.body.error, 'Daily AI reading limit reached for this demo — samples still work from cache');
    assert.equal((await api('/api/runs?sample=02_brightline_fuel_surcharge.pdf&fresh=1', { method: 'POST', ip: freshIp() })).status, 429);
    const ok = await api('/api/runs?sample=02_brightline_fuel_surcharge.pdf', { method: 'POST', ip: freshIp() });
    assert.equal(ok.status, 202);
    await done(ok.body.id);
  } finally { LIMITS.geminiDailyCap = cap; }
});

test('many live viewers of one run; a reset sends `reset` and closes every stream', async () => {
  const warnings = [];
  const onWarn = (w) => warnings.push(w);
  process.on('warning', onWarn);
  const bytes = Buffer.from('%PDF-1.4 /Font held for sse');
  let release;
  gates.set(sha256(bytes), new Promise((r) => (release = r)));
  try {
    const { body } = await api('/api/runs', { method: 'POST', ip: freshIp(), body: bytes });
    const streams = await Promise.all(Array.from({ length: 12 }, () => req(`/api/runs/${body.id}/events`)));
    const texts = streams.map((r) => r.text());
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await resetDemo()).status, 200);
    for (const t of await Promise.all(texts)) {
      assert.match(t, /^event: snapshot\n/);
      assert.match(t, /event: reset\n/);
    }
    assert.deepEqual(warnings.filter((w) => w.name === 'MaxListenersExceededWarning'), []);
  } finally { release(); process.off('warning', onWarn); }
});
