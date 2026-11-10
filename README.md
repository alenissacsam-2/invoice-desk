# Invoice Desk

An invoice comes in as a PDF or image. Out comes a decision an AP manager can act on: **approve**, **hold for review** (routed to the right team) or **reject**, with the reason in plain English and every step visible.

Built for the Zamp AI Solutions Analyst case study (PS-1, Finance / AP).

**Live:** _add Render URL here_ · **Demo video:** _add link here_

## How it works

```
 invoice.pdf ─▶ 1 Intake ─▶ 2 Read ─▶ 3 Validate ─▶ 4 Vendor ─▶ 5 Duplicate ─▶ 6 PO match ─▶ 7 Decision
                 type, hash   Gemini     totals, tax,  master file,  same vendor,   2-/3-way match,  approve / hold /
                 scan vs      structured dates,        bank details  number and     tolerances,      reject + route +
                 digital      extraction required fields             amount         receipts         email draft
```

**The model reads; the rules decide.** Gemini 3.5 Flash-Lite turns the document, scanned or digital, into structured fields with a confidence score per field. Everything after that is deterministic code in [`src/rules.js`](src/rules.js) and [`src/decide.js`](src/decide.js). The same invoice and the same ledger always give the same decision, and every decision can be traced to a rule and a number. That matters in finance: you can audit a rule, but you can't audit a model's mood.

The matching policy (2% unit price, 2% and $100 on the header, zero quantity over receipt, PO inference ≥ 0.85) lives in [`src/config.js`](src/config.js) and is shown in the app under *Procurement data → Matching policy*.

## The demo set

Nine invoices from seven vendors, each with its own layout, live in [`samples/`](samples/). The procurement "spreadsheet" (vendors, POs, PO lines, goods receipts) is in [`data/`](data/).

| # | Invoice | What makes it interesting | Decision |
|---|---|---|---|
| 01 | Acme office supplies | Clean happy path, 3-way match | Approve |
| 02 | Brightline freight | Services (2-way match), an unplanned 1.5% fuel surcharge that sits within tolerance | Approve, variance noted |
| 03 | Peak Valley Janitorial | **Scanned image, no PO number.** The PO is inferred from the vendor's open POs by description and amount | Approve, PO inferred |
| 04 | Northstar laptops, 1 of 2 | Partial invoice against a 10-laptop PO | Approve |
| 05 | Northstar laptops, 2 of 2 | **Bills 4 laptops and 4 docks when only 2 more laptops and no docks have arrived** | Hold → Receiving |
| 06 | Acme resend | **Same invoice re-sent as a "payment reminder"**: new layout, number printed `ACM-INV-010458` | Reject as duplicate |
| 07 | Kestrel industrial | **Matches the PO perfectly, but "our bank details have changed"**, with a lookalike email domain | Hold → Treasury & Security |
| 08 | Lumen print | No invoice number, no date | Hold, vendor email drafted |
| 09 | Sharma Electricals (India) | INR, CGST + SGST, Indian digit grouping | Approve |

Run 01 before 06, and 04 before 05: the later ones need the earlier ones in the ledger.

### Why these edge cases
- **Scanned, no PO (03):** small vendors scan paper invoices and rarely quote a PO. A "no PO, no pay" rule would block them all. Instead the process infers the PO, but only when one candidate clearly wins on both description and amount. Otherwise it holds and says why.
- **Split invoice ahead of receipt (05):** the PO still has value left, so a 2-way match would pass it. The 3-way check compares billed quantity with what has been *received and not yet invoiced*, which is how SAP checks open quantity. The money is fine; the goods aren't there yet.
- **Duplicate resend (06):** vendors' AR systems re-send invoices with new formatting. Invoice numbers are normalised (case, punctuation, leading zeros), and vendor, number and amount must all match before an invoice is auto-rejected. Same number with a *different* amount goes to review, since it could be a corrected invoice or a credit memo.
- **Bank-detail change (07):** this is the most expensive AP fraud there is. 74% of organisations saw business-email-compromise attempts in 2025 (AFP). The invoice is correct in every other way, which is the point. Payment is blocked, the case goes to Treasury, and the email draft goes to the contact **on file** with a call-back instruction, never to the address on the invoice.

## The app
- **Process:** drop a file or pick from the sample inbox, then watch each stage run live. You see the checks, the extracted fields with confidence, the bank comparison, the line-by-line PO match and the original document beside it. Held invoices can be approved or rejected by a person, with a note.
- **Runs:** history of every run with KPIs (auto-approval rate, value approved, processing time, why invoices were held) and filters.
- **Procurement data:** vendors, POs with invoiced and remaining balances, goods receipts, the ledger, and the matching policy.

## Run it locally
Requires Node 24+. There are no npm dependencies.
```bash
echo GEMINI_API_KEY=your_key > .env
npm start            # http://localhost:3000
npm test             # 52 tests: rules, extraction, pipeline
npm run eval         # runs all 9 samples against the live server and checks each decision
```

## Deploy (Render, free)
1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` defines the service.
3. Paste `GEMINI_API_KEY` when prompted, then deploy.

The free tier sleeps after 15 minutes idle (about a minute to wake up) and its disk is temporary. On boot the app loads master data from `data/*.csv` and restores a snapshot of demo runs from `data/seed.db`, so the dashboard is never empty. *Reset demo* clears it.

## Assumptions and limits
- One buyer (Halden Robotics, with a US and an India entity). Master data is read-only CSV.
- Invoices are single-currency. There is no FX.
- PO tolerance is checked on net amounts; tax is checked arithmetically (rate × base) rather than against the PO.
- Nothing is sent or paid. Emails are drafts and "payment" is a scheduled date.
- Scanned vs digital is detected by a heuristic (does the PDF embed fonts?). Gemini also reports it.
- The free Gemini tier can return 503 under load. The app retries, falls back to a second model, and caches extractions by file hash.

## Next steps for a real deployment
Email ingestion, ERP posting with read-back, an approval matrix by amount, vendor-master change workflow, a persistent database, and a reviewer feedback loop that tunes tolerances.

## Layout
See [`filemap.md`](filemap.md). The spec is in [`docs/SPEC.md`](docs/SPEC.md) and the background research in [`docs/RESEARCH.md`](docs/RESEARCH.md).
