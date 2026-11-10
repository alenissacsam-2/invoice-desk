// End-to-end eval against a running server: reset, run every sample in manifest order, compare decisions.
// Also compares key extracted fields with tests/fixtures/<sample>.json; a field mismatch fails only with --strict.
// Usage: node scripts/eval.js [--fresh] [--strict]   (BASE_URL defaults to http://localhost:3000)
import fs from 'node:fs';
import path from 'node:path';
import { normalizeInvoiceNumber, normalizePO } from '../src/rules.js';

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const fresh = process.argv.includes('--fresh');
const strict = process.argv.includes('--strict');
const root = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'samples', 'manifest.json'), 'utf8'));
const fixture = (file) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', file.replace(/\.\w+$/, '.json')), 'utf8'));

// [name, value from an extraction, equal?]
const FIELDS = [
  ['invoice_number', (e) => normalizeInvoiceNumber(e.invoice_number)],
  ['invoice_date', (e) => e.invoice_date ?? null],
  ['total', (e) => (e.total == null ? null : Number(e.total)), (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 0.01)],
  ['po_number', (e) => normalizePO(e.po_number)],
  ['vendor tax_id', (e) => normalizePO(e.vendor?.tax_id)], // same alnum/upper normalisation
];
function compareFields(got, want) {
  if (!got) return { score: '-', diffs: ['no extraction'] };
  const diffs = [];
  for (const [name, get, eq = (a, b) => a === b] of FIELDS) {
    const g = get(got), w = get(want);
    if (!eq(g, w)) diffs.push(`${name}: got ${JSON.stringify(g)}, expected ${JSON.stringify(w)}`);
  }
  return { score: `${FIELDS.length - diffs.length}/${FIELDS.length}`, diffs };
}
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
let bad = 0, fieldBad = 0;
const mismatches = [];
for (const s of manifest) {
  const { id } = await api(`/api/runs?sample=${encodeURIComponent(s.file)}${fresh ? '&fresh=1' : ''}`, { method: 'POST' });
  const run = await waitDone(id);
  const ext = run.stages.find((x) => x.key === 'extract')?.data ?? {};
  const codes = (run.result?.reasons ?? []).map((r) => r.code);
  const got = run.status === 'error' ? 'ERROR' : run.decision;
  const missing = s.expectedCodes.filter((c) => !codes.includes(c));
  const ok = got === s.expected && !missing.length;
  if (!ok) bad++;
  const f = compareFields(run.extraction, fixture(s.file));
  if (f.diffs.length) { fieldBad++; mismatches.push(...f.diffs.map((d) => `${s.file}  ${d}`)); }
  rows.push({ ok: ok ? 'ok' : 'FAIL', file: s.file, expected: s.expected, got, fields: f.score, codes: codes.join(',') || '-', ms: run.ms ?? '-', model: ext.model ?? '-', cached: ext.cached ?? '-' });
  if (!ok) rows.at(-1).note = run.status === 'error' ? run.headline : missing.length ? `missing ${missing.join(',')}` : run.headline;
}

const cols = ['ok', 'file', 'expected', 'got', 'fields', 'codes', 'ms', 'model', 'cached'];
const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join('  ');
console.log(line(Object.fromEntries(cols.map((c) => [c, c]))));
for (const r of rows) { console.log(line(r)); if (r.note) console.log(`    ↳ ${r.note}`); }
console.log(`\n${rows.length - bad}/${rows.length} as expected${fresh ? ' (fresh extraction)' : ''}; fields match the fixture on ${rows.length - fieldBad}/${rows.length}`);
if (mismatches.length) console.log(`\nField mismatches${strict ? '' : ' (not failing; use --strict)'}:\n${mismatches.map((m) => `  ${m}`).join('\n')}`);
process.exit(bad || (strict && fieldBad) ? 1 : 0);
