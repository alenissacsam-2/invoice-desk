// End-to-end eval against a running server: reset, run every sample in manifest order, compare decisions.
// Usage: node scripts/eval.js [--fresh]   (BASE_URL defaults to http://localhost:3000)
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const fresh = process.argv.includes('--fresh');
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'samples', 'manifest.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, opts) {
  // POSTs carry X-Demo: the server refuses writes without it (CSRF guard).
  const res = await fetch(BASE + p, opts?.method === 'POST' ? { ...opts, headers: { ...opts.headers, 'X-Demo': '1' } } : opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${opts?.method ?? 'GET'} ${p} → ${res.status} ${body?.error ?? ''}`);
  return body;
}

async function waitDone(id, timeoutMs = 300_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(400)) {
    const run = await api(`/api/runs/${id}`);
    if (run.status !== 'running') return run;
  }
  throw new Error(`run ${id} did not finish in ${timeoutMs / 1000}s`);
}

await api('/api/reset', { method: 'POST' });
const rows = [];
let bad = 0;
for (const s of manifest) {
  const { id } = await api(`/api/runs?sample=${encodeURIComponent(s.file)}${fresh ? '&fresh=1' : ''}`, { method: 'POST' });
  const run = await waitDone(id);
  const ext = run.stages.find((x) => x.key === 'extract')?.data ?? {};
  const codes = (run.result?.reasons ?? []).map((r) => r.code);
  const got = run.status === 'error' ? 'ERROR' : run.decision;
  const missing = s.expectedCodes.filter((c) => !codes.includes(c));
  const ok = got === s.expected && !missing.length;
  if (!ok) bad++;
  rows.push({ ok: ok ? 'ok' : 'FAIL', file: s.file, expected: s.expected, got, codes: codes.join(',') || '-', ms: run.ms ?? '-', model: ext.model ?? '-', cached: ext.cached ?? '-' });
  if (!ok) rows.at(-1).note = run.status === 'error' ? run.headline : missing.length ? `missing ${missing.join(',')}` : run.headline;
}

const cols = ['ok', 'file', 'expected', 'got', 'codes', 'ms', 'model', 'cached'];
const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join('  ');
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
for (const r of rows) { console.log(line(r)); if (r.note) console.log(`    ↳ ${r.note}`); }
console.log(`\n${rows.length - bad}/${rows.length} as expected${fresh ? ' (fresh extraction)' : ''}`);
process.exit(bad ? 1 : 0);
