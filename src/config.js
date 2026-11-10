import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env for local dev (Render injects real env vars).
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

export const PORT = Number(process.env.PORT) || 3000;

export const PATHS = {
  root,
  db: process.env.DB_PATH || path.join(root, 'var', 'app.db'),
  seedDb: path.join(root, 'data', 'seed.db'),
  data: path.join(root, 'data'),
  samples: path.join(root, 'samples'),
  public: path.join(root, 'public'),
};

export const TOL = {
  unitPricePct: 2,      // per-line unit price variance vs PO
  headerPct: 2,         // invoice net vs PO expected, percent...
  headerAbs: { USD: 100, INR: 8000, default: 100 }, // ...and absolute cap per PO currency; both must hold
  arithAbs: 0.02,       // rounding slack for arithmetic checks
  poInferMin: 0.85,     // min score to accept an inferred PO
  poAmbiguityMargin: 0.1,
  lowConfidence: 0.7,
  maxAgeDays: 365,
  dupWindowDays: 7,     // same vendor + same total + different number within this many days → possible duplicate (monthly retainers are ~30 apart)
};

export const GEMINI = {
  key: process.env.GEMINI_API_KEY || '',
  primary: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  fallback: process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite',
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 'YYYY-MM-DD'. APP_TODAY pins the date so demos and tests are reproducible. */
export function today() {
  return process.env.APP_TODAY || new Date().toISOString().slice(0, 10);
}
