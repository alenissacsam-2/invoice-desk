// Dev tool: node scripts/try-extract.js <file> [--model id] [--fresh]
import fs from 'node:fs';
import { sniff, extractInvoice } from '../src/extract.js';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--model');
const mi = args.indexOf('--model');
if (!file) { console.error('usage: node scripts/try-extract.js <file> [--model id] [--fresh]'); process.exit(2); }

const bytes = fs.readFileSync(file);
const info = sniff(bytes);
if (!info.mime) { console.error('unsupported file type'); process.exit(1); }
try {
  const r = await extractInvoice(bytes, info.mime, { fresh: args.includes('--fresh'), models: mi >= 0 ? [args[mi + 1]] : undefined });
  console.log(JSON.stringify(r.extraction, null, 2));
  console.error(JSON.stringify({ sniff: info, model: r.model, cached: r.cached, latencyMs: r.latencyMs, attempts: r.attempts, fallbackReason: r.fallbackReason }));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
