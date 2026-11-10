# PLAN

Each task references `docs/SPEC.md`. Status: [ ] todo, [x] accepted.

1. [ ] **Scaffold** (light). `package.json` (type module, scripts `start`=`node server.js`, `test`=`node --test tests/`, `eval`=`node scripts/eval.js`; engines node>=24), `src/config.js`, `src/db.js` (schema, CSV loader, seed.db copy, CRUD helpers), `server.js` serving `public/` and `/healthz`, placeholder `public/index.html`. Verify: `npm start` serves /healthz and `node -e` loads db with CSVs once task 2 lands.
2. [ ] **Data + samples** (careful). `data/*.csv` exactly per SPEC "Scenario numbers"; `scripts/make_samples.py` producing the 9 PDFs in `samples/` with visibly different vendor layouts (#3 scanned image, rotated, noisy, no text layer); `samples/manifest.json` [{file,title,scenario,expected,tags}]; `tests/fixtures/<sample>.json` = ground-truth extraction in SPEC schema. Verify: PDFs open, #3 has no text layer, numbers reconcile.
3. [ ] **Rules + decision** (careful). `src/rules.js`, `src/decide.js` pure functions + `tests/rules.test.js` covering all 9 scenarios via fixtures/inline data and tolerance boundaries. Verify: `npm test` green.
4. [ ] **Extraction** (medium). `src/extract.js`: sniff, text-layer detect, Gemini REST call with JSON schema, retries + fallback model, cache by sha. Verify against samples with real key.
5. [ ] **Pipeline + API** (careful). `src/pipeline.js`, full `server.js` routes + SSE, ledger effects, human review, stats, data view, reset. Verify: curl each route; run samples in order and get the expected decisions.
6. [ ] **Frontend** (careful). Run view, dashboard, data view, per the design spec in the brief. Verify in the browser.
7. [ ] **Eval + seed + deploy** (light). `scripts/eval.js` runs all samples in demo order and asserts expected decisions; build `data/seed.db`; Dockerfile, render.yaml, README.
8. [ ] **Demo script** (orchestrator). `docs/DEMO.md`: 5-minute narration outline the user records in their own voice.
