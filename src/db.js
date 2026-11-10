import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

let db;

const NUMERIC = new Set(['qty', 'unit_price', 'net_total', 'qty_received', 'line_no', 'payment_terms_days']);
const JSON_COLS = ['stages', 'extraction', 'result', 'review'];

const MASTER = {
  vendors: ['vendors.csv', `vendor_id TEXT PRIMARY KEY, name TEXT, aliases TEXT, tax_id TEXT, country TEXT, currency TEXT,
    bank_name TEXT, bank_account TEXT, bank_routing TEXT, remit_email TEXT, phone TEXT, status TEXT, payment_terms_days REAL`],
  purchase_orders: ['purchase_orders.csv', `po_number TEXT PRIMARY KEY, vendor_id TEXT, buyer_entity TEXT, issue_date TEXT,
    currency TEXT, net_total REAL, category TEXT, requester TEXT, status TEXT, description TEXT`],
  po_lines: ['po_lines.csv', `po_number TEXT, line_no INTEGER, item_code TEXT, description TEXT, qty REAL, unit_price REAL, uom TEXT`],
  goods_receipts: ['goods_receipts.csv', `grn_number TEXT, po_number TEXT, line_no INTEGER, qty_received REAL, received_date TEXT`],
};

/** Minimal RFC4180-ish parser: quoted fields, commas/newlines inside quotes, "" escapes. First row = header. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, j) => {
    const k = h.trim(), v = r[j] ?? '';
    return [k, NUMERIC.has(k) && v !== '' ? Number(v) : v];
  })));
}

export function openDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  if (!fs.existsSync(PATHS.db) && fs.existsSync(PATHS.seedDb)) fs.copyFileSync(PATHS.seedDb, PATHS.db);
  db = new DatabaseSync(PATHS.db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT, filename TEXT, file_sha TEXT, mime TEXT, bytes BLOB,
      source TEXT, status TEXT, decision TEXT, headline TEXT, vendor_id TEXT, invoice_number TEXT, total REAL, currency TEXT,
      po_number TEXT, ms INTEGER, stages TEXT, extraction TEXT, result TEXT, review TEXT);
    CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, vendor_id TEXT, invoice_number TEXT,
      invoice_number_norm TEXT, invoice_date TEXT, net REAL, total REAL, currency TEXT, po_number TEXT, lines TEXT, status TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS extraction_cache (file_sha TEXT PRIMARY KEY, model TEXT, json TEXT, created_at TEXT);
  `);
  for (const [table, [, cols]] of Object.entries(MASTER)) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${cols})`);
  loadMaster();
  return db;
}

function loadMaster() {
  db.exec('BEGIN');
  try {
    for (const [table, [file]] of Object.entries(MASTER)) {
      const p = path.join(PATHS.data, file);
      if (!fs.existsSync(p)) continue;
      const rows = parseCsv(fs.readFileSync(p, 'utf8'));
      db.exec(`DELETE FROM ${table}`);
      if (!rows.length) continue;
      const keys = Object.keys(rows[0]);
      const stmt = db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
      for (const r of rows) stmt.run(...keys.map((k) => r[k]));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const plain = (r) => (r ? { ...r } : r);
const parseRun = (r) => {
  if (!r) return null;
  r = plain(r);
  for (const c of JSON_COLS) if (c in r) r[c] = r[c] == null ? null : JSON.parse(r[c]);
  return r;
};
const encode = (k, v) => (JSON_COLS.includes(k) && v != null ? JSON.stringify(v) : v ?? null);

function insert(table, row) {
  const keys = Object.keys(row);
  return openDb().prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => encode(k, row[k])));
}

export function getMaster() {
  const d = openDb();
  const all = (t) => d.prepare(`SELECT * FROM ${t}`).all().map(plain);
  return {
    vendors: all('vendors').map((v) => ({ ...v, aliases: String(v.aliases ?? '').split(';').map((s) => s.trim()).filter(Boolean) })),
    pos: all('purchase_orders'),
    poLines: all('po_lines'),
    receipts: all('goods_receipts'),
  };
}

export function getLedger() {
  return openDb().prepare('SELECT * FROM ledger ORDER BY id').all().map((r) => ({ ...r, lines: r.lines ? JSON.parse(r.lines) : [] }));
}

export function insertRun(run) { insert('runs', run); }

export function updateRun(id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  openDb().prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => encode(k, patch[k])), id);
}

const RUN_COLS = 'id, created_at, filename, file_sha, mime, source, status, decision, headline, vendor_id, invoice_number, total, currency, po_number, ms';

export function getRun(id) {
  return parseRun(openDb().prepare(`SELECT ${RUN_COLS}, stages, extraction, result, review FROM runs WHERE id = ?`).get(id));
}

export function getRunFile(id) {
  const r = openDb().prepare('SELECT bytes, mime, filename FROM runs WHERE id = ?').get(id);
  return r ? { bytes: r.bytes, mime: r.mime, filename: r.filename } : null;
}

export function listRuns({ decision } = {}) {
  const d = openDb();
  const sql = `SELECT ${RUN_COLS} FROM runs ${decision ? 'WHERE decision = ?' : ''} ORDER BY created_at DESC, rowid DESC`;
  return d.prepare(sql).all(...(decision ? [decision] : [])).map(plain);
}

const cents = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
export function insertLedger(row) {
  row = { ...row, net: cents(row.net), total: cents(row.total) };
  insert('ledger', row.lines && typeof row.lines !== 'string' ? { ...row, lines: JSON.stringify(row.lines) } : row);
}

export function updateLedgerStatus(runId, status) {
  openDb().prepare('UPDATE ledger SET status = ? WHERE run_id = ?').run(status, runId);
}

export function getCachedExtraction(sha) {
  const r = openDb().prepare('SELECT * FROM extraction_cache WHERE file_sha = ?').get(sha);
  return r ? { ...r, json: JSON.parse(r.json) } : null;
}

export function putCachedExtraction(sha, model, json) {
  openDb().prepare('INSERT OR REPLACE INTO extraction_cache (file_sha, model, json, created_at) VALUES (?, ?, ?, ?)')
    .run(sha, model, typeof json === 'string' ? json : JSON.stringify(json), new Date().toISOString());
}

export function resetRuns() {
  openDb().exec('DELETE FROM runs; DELETE FROM ledger;');
}
