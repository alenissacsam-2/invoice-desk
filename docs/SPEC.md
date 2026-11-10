# Invoice Desk — SPEC

Zamp ASA case study, PS-1: an invoice PDF goes in and a reasoned AP decision comes out, with every stage visible.

## Goals
- Accept a real invoice file (PDF digital or scanned, PNG, JPEG) by upload, or pick one of the prepared samples.
- Run a visible 7-stage pipeline and end with a decision: **APPROVE**, **REVIEW** (hold, routed to a named queue) or **REJECT**. Every decision has reason codes and a plain-English explanation.
- Live run view (stages stream in as they execute), a dashboard of past runs (history, status, outputs, KPIs), and a procurement-data view (vendors, POs with invoiced/remaining balances, goods receipts, ledger).
- Human-in-the-loop: a held invoice can be approved or rejected by a person, with a note. That action changes the ledger.

## Non-goals
Email ingestion, auth, multi-tenant, ERP posting, actual payments, editing master data in the UI.

## Core principle
**The LLM reads; the rules decide.** Gemini only turns the document into structured fields, with a confidence score per field. Matching, validation and the decision are deterministic code, so every outcome can be explained and tested.

## Stack
- Node.js 24, ESM, **no npm runtime dependencies**: `node:http`, `node:sqlite` (DatabaseSync), global `fetch`, `node:test`.
- Gemini REST API (`GEMINI_API_KEY`), model per `src/config.js`.
- Frontend: static `public/index.html` + `app.js` + `styles.css`, vanilla JS, hash routing, Server-Sent Events. No build step.
- Deploy: Docker on Render free web service (`render.yaml`).
- Sample generation: Python 3 (`py -3`) script, `scripts/make_samples.py`, venv in `scripts/.venv` (gitignored). Generated PDFs are committed.

## Architecture
| Module | Responsibility |
|---|---|
| `server.js` | HTTP routes (below), static files, SSE fan-out. |
| `src/config.js` | Tolerances, model ids, paths, `TODAY` override (env `APP_TODAY`, default real date). |
| `src/db.js` | SQLite schema, loads master data from `data/*.csv` on every boot (CSV = the "procurement spreadsheet", source of truth), and runs/ledger/cache CRUD. On boot, if `DB_PATH` does not exist and `data/seed.db` exists, copy it first (a snapshot of real demo runs, so the dashboard isn't empty after a Render cold start). |
| `src/extract.js` | File sniffing (PDF/PNG/JPEG magic, text-layer detection), Gemini call with JSON schema, retry/fallback model, extraction cache by SHA-256. |
| `src/rules.js` | Pure functions: validation, vendor match, PO match/inference, line matching, receipts, duplicates. No I/O. |
| `src/decide.js` | Pure: reason codes → decision, route, explanation text, next actions, vendor email draft. |
| `src/pipeline.js` | Runs stages in order, persists each stage, emits events, writes ledger. |

## Pipeline stages (in order: intake, extract, validate, vendor, duplicate, po_match, decision)
The duplicate check runs before PO matching. A confirmed DUPLICATE_INVOICE skips po_match (status skipped), so a resend is not reported as a quantity overrun against its own original.
Each stage record: `{key, label, status: pending|running|passed|warning|failed|skipped, startedAt, endedAt, ms, summary, checks:[{label, status: pass|warn|fail|info, detail}], data}`.

1. **intake** — size, type, SHA-256, page count, text layer (digital vs scanned), and whether exactly this file was processed before (`DUPLICATE_FILE`, a hold, not a reject, because a resend is not proof of double billing).
2. **extract** — Gemini structured extraction (schema below). Records model, latency, and `cached: true|false`. Fails if `is_invoice` is false (`NOT_AN_INVOICE`).
3. **validate** — required fields (invoice_number, invoice_date, vendor name, total); arithmetic (qty×unit≈amount, Σlines≈subtotal, subtotal+tax(+shipping)≈total, taxable base × tax rate ≈ tax line; all within 0.02, or 1 unit for INR, to allow rounding); date sanity (not after TODAY+1, not older than 365 days); tax-inclusive handling; low confidence (<0.7) on key fields; tax-ID format (US EIN `NN-NNNNNNN`, India GSTIN 15-char regex).
4. **vendor** — match the vendor master by tax ID (exact, normalised), else fuzzy name/aliases (token Jaccard ≥ 0.6, or one name contains the other). Check status (active/blocked). **Bank details on invoice vs master**: if the invoice shows bank account/routing digits that differ from the master → `BANK_DETAILS_CHANGED` (hold, Treasury & Security, payment blocked, verify by call-back to the phone on file, never the contact on the invoice). Also flag a remit email domain that differs from the master.
5. **po_match** — explicit PO: normalise (uppercase, strip non-alphanumerics) and look up; check PO vendor == matched vendor and the currency. No PO on the invoice → **infer**: score the vendor's open POs by line-description similarity plus amount fit against the remaining uninvoiced value; a unique candidate with score ≥ 0.85 → `PO_INFERRED` (info) and continue; several close candidates → `PO_AMBIGUOUS` (hold); none → `PO_NOT_FOUND` (hold). Then line matching (item_code exact, else description token similarity): unit-price variance per line (tolerance below); **3-way for goods** (billed qty ≤ received − previously invoiced, else `QTY_EXCEEDS_RECEIPT`); billed qty ≤ ordered − previously invoiced (`QTY_EXCEEDS_PO`); **2-way for services** (`category=services`, no receipt check); invoice lines not on the PO (e.g. fuel surcharge) count toward header variance; header: previously invoiced net + this net vs PO total (`PO_OVERRUN` beyond tolerance). Within tolerance → `VARIANCE_WITHIN_TOLERANCE` (info).
6. **duplicate** — prior ledger rows (approved or on_hold) for the same vendor: normalised invoice number equal (uppercase, strip non-alphanumerics, strip leading zeros of each digit run) **and** total equal ± 0.01 → `DUPLICATE_INVOICE` (reject, links to the original run). Same number, different total → `POSSIBLE_DUPLICATE` (hold: could be a corrected invoice or a credit memo). Same vendor + same total ± 0.01 + invoice date within 30 days but a different number → `POSSIBLE_DUPLICATE` (hold). (This follows SAP's duplicate check on vendor/reference/amount and Zamp's own guidance.) Skipped, with a warning, when invoice_number is missing.
7. **decision** — `decide.js`: any `block` severity → REJECT; else any `hold` → REVIEW; else APPROVE. Output below.

### Tolerances (`src/config.js`)
- Unit-price variance: ≤ 2% per line.
- Header (net) variance vs PO expected: ≤ 2% **and** ≤ 100 in PO currency (both must hold).
- Quantity: 0 tolerance over receipt/PO.
- PO inference threshold 0.85, ambiguity margin 0.1.

### Reason codes (code → severity → route)
| Code | Severity | Route |
|---|---|---|
| NOT_AN_INVOICE | block | AP clerk |
| DUPLICATE_INVOICE | block | AP clerk |
| VENDOR_BLOCKED | block | Procurement |
| BANK_DETAILS_CHANGED | hold | Treasury & Security |
| VENDOR_UNKNOWN | hold | Procurement |
| PO_NOT_FOUND / PO_AMBIGUOUS / PO_VENDOR_MISMATCH / CURRENCY_MISMATCH | hold | Procurement |
| PRICE_VARIANCE / PO_OVERRUN / QTY_EXCEEDS_PO | hold | Procurement (PO requester) |
| QTY_EXCEEDS_RECEIPT | hold | Receiving / PO requester |
| MISSING_FIELD | hold | AP clerk (+ vendor email) |
| ARITHMETIC_MISMATCH / LOW_CONFIDENCE / DATE_OUT_OF_RANGE / TAX_ID_INVALID | hold | AP clerk |
| POSSIBLE_DUPLICATE / DUPLICATE_FILE | hold | AP clerk |
| PO_INFERRED / VARIANCE_WITHIN_TOLERANCE / TAX_INCLUSIVE | info | — |

When several holds route differently, the route is the highest priority: Treasury & Security > Procurement > Receiving > AP clerk.

### Decision output
```json
{ "decision": "APPROVE|REVIEW|REJECT",
  "headline": "one sentence",
  "reasons": [{"code","severity","message"}],
  "explanation": "2-4 short plain-English sentences a non-technical AP manager understands",
  "route": "Treasury & Security|Procurement|Receiving|AP clerk|null",
  "nextActions": ["..."],
  "payment": {"amount","currency","scheduledFor":"YYYY-MM-DD"} | null,
  "vendorEmail": {"to","subject","body"} | null }
```
`vendorEmail` is drafted for MISSING_FIELD, QTY_EXCEEDS_RECEIPT (credit note / re-bill), DUPLICATE_INVOICE (courtesy note) and PO_INFERRED (please quote the PO next time). For BANK_DETAILS_CHANGED it is addressed to the **master-file** contact, never the invoice's. Nothing is ever sent; drafts only.

Ledger effect: APPROVE → ledger row `approved` (consumes PO quantities and value); REVIEW → `on_hold` (counts for duplicate detection, not for PO consumption); REJECT → no ledger row. Human review: on_hold → approved | rejected.

## Extraction schema (Gemini output)
```
is_invoice bool; document_type enum[invoice, credit_note, quote, statement, receipt, other]
vendor {name, tax_id|null, address|null, email|null, phone|null}
bill_to_name|null; invoice_number|null; invoice_date YYYY-MM-DD|null; due_date|null; po_number|null
currency ISO-4217; payment_terms|null
line_items [{description, item_code|null, quantity|null, unit_price|null, amount}]
subtotal|null; tax_lines [{label, rate_pct|null, amount}]; tax_total|null; tax_inclusive bool; shipping|null; total|null
bank_details {bank_name|null, account_number|null, routing_code|null, iban|null, swift|null} | null
notices [string]   // e.g. "bank details have changed", "copy/reminder"
source_quality {kind enum[digital_text, scanned_image], legibility enum[high, medium, low]}
confidence {vendor_name, invoice_number, invoice_date, po_number, total: 0..1}
```
Numbers are plain JSON numbers (so "1,16,820.00" becomes 116820). If a field is absent, it's null; never guess.

## Data model
CSV (`data/`): see the headers in `data/*.csv`.
- `vendors.csv`: vendor_id,name,aliases(;-sep),tax_id,country,currency,bank_name,bank_account,bank_routing,remit_email,phone,status(active|blocked),payment_terms_days
- `purchase_orders.csv`: po_number,vendor_id,buyer_entity,issue_date,currency,net_total,category(goods|services),requester,status(open|closed),description
- `po_lines.csv`: po_number,line_no,item_code,description,qty,unit_price,uom
- `goods_receipts.csv`: grn_number,po_number,line_no,qty_received,received_date

SQLite tables: the 4 master tables (reloaded from CSV on boot); `runs(id TEXT PK, created_at, filename, file_sha, mime, bytes BLOB, source, status running|done|error, decision, headline, vendor_id, invoice_number, total, currency, po_number, ms, stages JSON, extraction JSON, result JSON, review JSON)`; `ledger(id, run_id, vendor_id, invoice_number, invoice_number_norm, invoice_date, net, total, currency, po_number, lines JSON [{po_line_no, qty, net}], status approved|on_hold|rejected, created_at)`; `extraction_cache(file_sha PK, model, json, created_at)`.

## HTTP API
| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `ok` |
| GET | `/api/samples` | `samples/manifest.json` |
| GET | `/samples/:file` | sample PDF |
| POST | `/api/runs` | body = raw file bytes, headers `Content-Type`, `X-Filename`; or `?sample=<file>`; `?fresh=1` bypasses the extraction cache. Max 10 MB. → `{id}` 202 |
| GET | `/api/runs` | list newest first, summary fields; `?decision=APPROVE|REVIEW|REJECT` |
| GET | `/api/runs/:id` | full run |
| GET | `/api/runs/:id/events` | SSE: `snapshot` event (full run) immediately, then `stage` events, then `done` |
| GET | `/api/runs/:id/file` | original bytes |
| POST | `/api/runs/:id/review` | `{action:"approve"|"reject", note}` → only for REVIEW runs |
| GET | `/api/stats` | KPIs: counts by decision, auto-approval rate, value processed by currency, avg ms, top reason codes |
| GET | `/api/data` | vendors, POs with ordered/received/invoiced/remaining per line and header, receipts, ledger |
| POST | `/api/reset` | clear runs + ledger (keep extraction cache) |

## Sample scenarios (buyer: Halden Robotics, Inc.; India entity: Halden Robotics India Pvt Ltd). TODAY = 2026-11-10
| # | File | Vendor | Scenario | Expected |
|---|---|---|---|---|
| 1 | `01_acme_happy.pdf` | V001 Acme Office Supplies LLC | Clean digital, PO-2026-0412 explicit, exact match, 3-way OK | APPROVE |
| 2 | `02_brightline_fuel_surcharge.pdf` | V002 Brightline Logistics Inc | Services, PO-2026-0398 $1,250.00 + unplanned fuel surcharge $18.75 (1.5%) | APPROVE (variance within tolerance) |
| 3 | `03_peakvalley_scanned_no_po.pdf` | V003 Peak Valley Janitorial | **Scanned image**, slightly rotated, **no PO number**; two open POs for the vendor; amount and description fit PO-2026-0377 | APPROVE (PO inferred) |
| 4 | `04_northstar_split_1of2.pdf` | V004 Northstar Computers Inc | Partial invoice 1 of PO-2026-0420: 6 laptops + 6 docks, all received | APPROVE |
| 5 | `05_northstar_split_2of2.pdf` | V004 | Invoice 2: 4 laptops + 4 docks; only 2 more laptops and 0 more docks received | REVIEW (QTY_EXCEEDS_RECEIPT, route Receiving) |
| 6 | `06_acme_duplicate_resend.pdf` | V001 | Same invoice as #1, re-sent by the vendor's AR system as "COPY – PAYMENT REMINDER", different layout, number written `ACM-INV-010458`, reprint date | REJECT (DUPLICATE_INVOICE) |
| 7 | `07_kestrel_bank_change.pdf` | V005 Kestrel Industrial Supply | Matches PO-2026-0405 perfectly, but "our bank details have changed" with a new account and a lookalike remit email domain | REVIEW (BANK_DETAILS_CHANGED → Treasury & Security) |
| 8 | `08_lumen_missing_fields.pdf` | V007 Lumen Print & Signage | No invoice number, no date; PO-2026-0415 referenced | REVIEW (MISSING_FIELD, vendor email draft) |
| 9 | `09_sharma_gst_inr.pdf` | V006 Sharma Electricals Pvt Ltd | India tax invoice, INR, CGST 9% + SGST 9% split, Indian digit grouping, HSN codes | APPROVE |

Run order for the demo: 1 → 6 (duplicate needs #1 in the ledger), 4 → 5 (split needs #4).

### Scenario numbers (master data and invoices must agree exactly)
- **PO-2026-0412** (V001, goods, requester "Priya Nair", net 3,789.00 USD): L1 `PAP-A4-80` A4 copy paper 80gsm, case of 10 reams ×40 @42.50; L2 `CHR-EC200` Ergonomic office chair EC-200 ×6 @289.00; L3 `MRK-12AST` Whiteboard markers assorted 12-pk ×25 @14.20. GRN-5521 received all, 2026-10-24. Invoice **ACM-INV-10458**, 2026-10-28, Net 30, subtotal 3,789.00, sales tax 8.5% 322.07, total **4,111.07**. Bank: master routing 121000248 / account 4411223344, which matches the invoice.
- **PO-2026-0398** (V002, services, "Daniel Ortiz", net 1,250.00 USD): L1 `FRT-LTL-3P` LTL freight San Jose CA → Austin TX, 3 pallets ×1 @1,250.00. Invoice **BL-2026-3317**, 2026-10-30: line 1 1,250.00 + "Fuel surcharge (1.5%)" 18.75; no tax; total 1,268.75.
- **PO-2026-0377** (V003, services, "Priya Nair", net 2,400.00 USD): L1 Office cleaning services — October 2026 (monthly), ×1 @2,400.00. **PO-2026-0378** (V003, services, net 1,850.00): L1 Window & carpet deep clean — Q4 2026 ×1 @1,850.00. Invoice **PV-1093**, 2026-10-31, "Office cleaning services for the month of October 2026" 2,400.00, no tax, total 2,400.00, **no PO reference**. Rendered as a scanned image.
- **PO-2026-0420** (V004, goods, "Marcus Chen", net 16,450.00 USD): L1 `NB-14PRO-32` Laptop 14" Pro 32GB/1TB ×10 @1,480.00; L2 `DOCK-USBC-G2` USB-C docking station G2 ×10 @165.00. GRN-5530 (2026-10-20): L1 6, L2 6. GRN-5547 (2026-11-03): L1 2. Invoice **NSC-7781** (2026-10-22): 6×L1 8,880.00 + 6×L2 990.00 = 9,870.00 + tax 8.5% 838.95 = **10,708.95**. Invoice **NSC-7802** (2026-11-05): 4×L1 5,920.00 + 4×L2 660.00 = 6,580.00 + tax 559.30 = **7,139.30**.
- Duplicate: **ACM-INV-010458**, reprint date 2026-11-08, same lines and total 4,111.07, header "COPY — PAYMENT REMINDER".
- **PO-2026-0405** (V005, goods, "Marcus Chen", net 14,530.00 USD): L1 `SPN-22KW` CNC spindle motor 2.2kW ×4 @3,150.00; L2 `LGR-1000` Linear guide rail 1m ×20 @96.50. GRN-5539 received all, 2026-10-29. Invoice **KIS-24-0871**, 2026-11-02, total 14,530.00 + tax 8.5% 1,235.05 = 15,765.05. Master bank: "Pacific Western Bank" routing 122238420 / acct 7700112233, remit ap@kestrelsupply.com. Invoice notice: "IMPORTANT: our bank details have changed. Please remit to First Coastal Bank, routing 063100277, account 9988776655", contact accounts@kestrel-supply.co.
- **PO-2026-0415** (V007, goods, "Daniel Ortiz", net 2,140.00 USD): L1 `BRO-A5-500` Trade-show brochures A5, 500 pcs ×1 @1,240.00; L2 `BNR-RU-85` Roll-up banner 85×200cm ×3 @300.00. GRN-5544 received all. Invoice has no number and no date, references PO-2026-0415, total 2,140.00 + tax 8.5% 181.90 = 2,321.90.
- **PO-2026-IN-0031** (V006, buyer Halden Robotics India Pvt Ltd, goods, "Ananya Rao", INR net 99,000.00): L1 `LED-PNL-40W` LED panel light 2x2 40W ×60 @1,450.00 (87,000.00); L2 `SVC-INSTALL` Installation labour ×1 @12,000.00. GRN-IN-0210 received all. Invoice **SE/2026-27/0457**, 2026-11-04, taxable 99,000.00, CGST 9% 8,910.00, SGST 9% 8,910.00, total **₹1,16,820.00**. GSTIN 29AABCS1234F1Z5. Treat L2 as goods-line for receipt (receipted as qty 1).
- V001–V007 are all active. Add **V008 Globex Trading Co** (status **blocked**) with no POs, for uploaded test files.

## v2 changes (after the first independent review)
The backend and the frontend both build against this.

**Reasons and labels**
- Every reason in `result.reasons` gains `label`: a short plain-English name, e.g. "Billed more than received". The UI shows labels; the raw code appears only as a tooltip or in muted mono.
- `result.primaryReason` = `{code, severity, label, message}` is the one reason that drove the decision. Rejects use the block reason (e.g. DUPLICATE_INVOICE, never DUPLICATE_FILE). The run list's `main_reason` uses it.

**Human review**
- `POST /api/runs/:id/review` takes `{action:'approve'|'reject', reviewer (required, ≥2 chars), note (required, ≥3 chars), callbackVerified (boolean)}`. Approving a run whose reasons include BANK_DETAILS_CHANGED or SUSPICIOUS_INSTRUCTIONS also requires `callbackVerified: true`. Failures return 400 with a human message.
- The run stores `review = {action, reviewer, note, callbackVerified, at}` and `final = {decision:'APPROVE'|'REJECT', by:'reviewer', at, payment|null}`. Approval schedules payment the same way the system does.
- Runs the system decided get `final = {decision, by:'system', payment}` at decision time, except REVIEW, which has `final = null` until a person decides.
- List rows gain `final_decision`, `reviewer`.

**Retry**
- `POST /api/runs/:id/retry` re-runs the same file fresh and returns `{id}` of a new run. It's allowed for any finished or error run.

**Errors**
- `result.errorKind` ∈ `unreadable_file` (Gemini 400 on the document, a corrupt or password-protected PDF; no fallback-model retry) | `ai_unavailable` (429/5xx after retries and fallback) | `internal`.
- `headline` and `nextActions` match the kind. unreadable_file says: "Couldn't open this file — it may be corrupt or password-protected. Ask the vendor for a new copy."

**Credit notes**
- `document_type: credit_note` (or a negative total) is no longer NOT_AN_INVOICE. It raises `CREDIT_NOTE` (hold, route AP clerk): "Credit note for −$313.57 from Acme. Nothing to pay; apply it against the vendor's next payment." If it references an invoice in the ledger, the message names it. No PO quantity checks.

**Suspicious instructions (AI-era control)**
- `SUSPICIOUS_INSTRUCTIONS` (hold, Treasury & Security) fires when a notice or printed text tries to steer processing: "pre-approved", "approve immediately", "AI"/"automated system" instructions, "do not verify", urgency plus payment pressure. The extraction prompt asks Gemini to copy any such text into `notices` verbatim and never to obey it.
- A remit/contact email domain that is a lookalike of the master domain (edit distance ≤ 2 on the core label, or same letters plus a hyphen or digit swap) becomes `REMIT_DOMAIN_LOOKALIKE` (hold, Treasury & Security), even without bank details. A merely different domain stays a warning.

**Timing**
- The extraction cache stores the original `latencyMs` and `model`. The extract stage `data` gains `originalLatencyMs` when cached.
- `/api/stats` gains `medianReadMs`: the median of fresh read times, falling back to each cached run's original read time.

**Stats**
- `/api/stats` returns `{total, byDecision (system decision), final:{approved, rejected, awaiting}, humanReviewed, autoApprovalRate, valueApproved (final approved, per currency), medianMs, medianReadMs, topReasons:[{code,label,severity,count}]}`.
- topReasons counts **invoices**, not reasons: one invoice with two QTY lines counts once.

**Samples**
- `/api/samples` items gain `processed: {runId, decision, final_decision}|null`, taken from the latest run of that file still in the DB.

**Copy fixes**
- No doubled parentheses around phone numbers. Intake summary like "JPEG image (photo)" or "PDF, 1 page, scanned".
- Duplicate messages never say "X is the same invoice as X" when the numbers are identical; they say "was already processed on <date> (run r_…)".
- Don't say "will not be paid again" if the original is only on hold.
- No courtesy email when the duplicate is the same file (our own re-upload). Draft one only when the vendor re-sent a different file.
- DUPLICATE_FILE is folded into DUPLICATE_INVOICE when both fire.
