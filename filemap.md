# filemap

- `server.js` — HTTP server, routes, SSE
- `src/config.js` — tolerances, model ids, paths, today()
- `src/db.js` — SQLite schema, CSV master-data load, runs/ledger/cache queries
- `src/extract.js` — file sniffing + Gemini extraction + cache
- `src/rules.js` — pure checks: validate, vendor, PO match, duplicates
- `src/decide.js` — pure: reasons → decision, explanation, email draft
- `src/pipeline.js` — runs the 7 stages, persists, emits events
- `public/` — frontend (index.html, app.js, styles.css)
- `data/*.csv` — vendor master, POs, PO lines, goods receipts
- `data/seed.db` — snapshot of demo runs loaded on first boot
- `samples/` — demo invoice PDFs + manifest.json
- `scripts/make_samples.py` — generates samples/
- `scripts/eval.js` — runs all samples, checks expected decisions
- `tests/` — node:test suites; `tests/fixtures/` ground-truth extractions
- `docs/` — SPEC, PLAN, DEMO
