# Invoice Desk (Zamp ASA case study, PS-1)

Stack: Node 24 ESM, zero npm runtime deps (node:http, node:sqlite, fetch, node:test); vanilla JS frontend in `public/`; Gemini REST for extraction.

Commands:
- run: `npm start` (port from `PORT`, default 3000; needs `GEMINI_API_KEY` in env or `.env`)
- test: `npm test`
- end-to-end eval: `npm run eval` (needs key)
- samples: `py -3 scripts/make_samples.py` (venv at `scripts/.venv`)

Conventions:
- The LLM reads, the rules decide: `src/rules.js` and `src/decide.js` are pure (no I/O, no LLM). Keep them that way.
- Money: compare with tolerances from `src/config.js`, round to 2 dp only for display; never hardcode thresholds elsewhere.
- `data/*.csv` is the procurement source of truth, reloaded into SQLite on every boot. Sample PDFs, CSVs and `tests/fixtures/` must stay numerically consistent with `docs/SPEC.md` "Scenario numbers".
- "Today" comes from `config.today()` (env `APP_TODAY` overrides), never `new Date()` directly in rules.
- Don't add npm dependencies without a strong reason.
- Update `filemap.md` when adding or moving files.

Docs: `docs/SPEC.md` (behaviour, API, data), `docs/PLAN.md` (tasks), `filemap.md` (where things live).
