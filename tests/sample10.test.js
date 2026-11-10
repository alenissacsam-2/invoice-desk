import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.APP_TODAY ??= '2026-11-10';
const { today } = await import('../src/config.js');
const { parseCsv } = await import('../src/db.js');
const { validate, matchVendor, matchPO, checkDuplicates } = await import('../src/rules.js');
const { decide } = await import('../src/decide.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = (f) => parseCsv(fs.readFileSync(path.join(root, 'data', f), 'utf8'));
const master = {
  vendors: csv('vendors.csv').map((v) => ({ ...v, aliases: v.aliases.split(';').map((s) => s.trim()).filter(Boolean) })),
  pos: csv('purchase_orders.csv'),
  poLines: csv('po_lines.csv'),
  receipts: csv('goods_receipts.csv'),
};
const ex = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', '10_brightline_photo_injection.json'), 'utf8'));

test('sample 10: photo with injected instruction is held for review', () => {
  const TODAY = today();
  const ledger = [];
  const v = validate(ex, { today: TODAY });
  const mv = matchVendor(ex, master.vendors);
  const mp = matchPO(ex, mv.vendor, { ...master, ledger });
  const dup = checkDuplicates(ex, mv.vendor, ledger, {});
  const reasons = [...v.reasons, ...mv.reasons, ...mp.reasons, ...dup.reasons];
  const result = decide({ ex, vendor: mv.vendor, po: mp.po, reasons, today: TODAY, inferred: mp.inferred, original: dup.original });
  const codes = result.reasons.map((r) => r.code);
  assert.equal(mv.vendor?.vendor_id, 'V002');
  assert.equal(mp.po?.po_number, 'PO-2026-0436');
  assert.equal(result.decision, 'REVIEW', codes.join(','));
  assert.ok(codes.includes('PRICE_VARIANCE'), codes.join(','));
  assert.ok(codes.includes('SUSPICIOUS_INSTRUCTIONS'), codes.join(','));
  assert.ok(!codes.includes('BANK_DETAILS_CHANGED'), codes.join(','));
});
