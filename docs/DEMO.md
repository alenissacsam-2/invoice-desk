# Demo video script (5 minutes, your own voice)

Record the browser at 1440×900 or larger. Before recording, click **Reset demo** so the dashboard starts empty and the duplicate and split-invoice cases behave as planned. Run each sample once beforehand if you want the extraction cache warm. That way a Gemini hiccup can't stall the recording. The Process screen shows a "Cached extraction" chip when this happens; mention it honestly if asked.

Speak like you're explaining it to an AP manager, not an engineer. These are talking points, not lines to read.

---

**0:00–0:30 · The problem**
"This is Invoice Desk. An AP clerk opens every vendor invoice, finds the PO in a spreadsheet, checks the numbers and decides what to do. It's slow, and it's where a tired person approves a duplicate or a fraudulent bank change. This takes an invoice in and gives a decision out: approve, hold for review with a named owner, or reject, with every step visible."

Point at the empty Process screen. "These are the seven stages. One idea runs through it: the AI **reads** the invoice, and plain rules **decide**. So every decision is explainable and gives the same answer every time."

**0:30–1:20 · Happy path: 01 Acme**
Click *Acme Office Supplies* in the sample inbox.
- While stages run: "Intake fingerprints the file and checks whether it's a scan. Gemini reads it into fields, each with a confidence score, here on the right. Validation checks the arithmetic and the tax: 8.5% of the subtotal really is $322.07."
- "Vendor check matches the tax ID against our vendor master and compares bank details. PO match is a three-way match: the PO, what the warehouse received, and what's billed."
- Decision card: "Approved and scheduled for payment on the due date. No human touched it."

**1:20–2:00 · Edge case: 03 the scanned invoice with no PO**
Click *Peak Valley Janitorial*. Show the crooked scan in the document panel.
"Small vendors send scans and almost never quote a PO. A strict 'no PO, no pay' rule would block every one of them. Instead it looks at this vendor's open POs. There are two, and it picks the one whose description and amount fit. It only does this when one candidate clearly wins. Otherwise it holds and tells you why." Open the PO match stage and show the inferred PO and its score.

**2:00–2:50 · Edge case: 04 → 05 split invoice ahead of delivery**
Run *Northstar 1 of 2* (approved), then *Northstar 2 of 2*.
"Same laptop order, second invoice. There's still money left on the PO, so a two-way match would pay it. But we've only received 2 more laptops and no more docks, and they're billing 4 of each." Open the line table: billed vs received vs already invoiced. "So it's on hold, routed to Receiving, not to AP. The money is fine; the goods aren't here yet." Optionally open *Procurement data* and show the PO's invoiced and remaining balance.

**2:50–3:30 · Edge case: 06 the duplicate resend**
Run *Acme payment reminder*.
"The vendor's system re-sent the same invoice as a reminder. Different layout, the number printed with an extra zero. We normalise invoice numbers and check vendor, number and amount together, the way SAP's duplicate check works. Rejected, with a link to the original." Click "See original run". "If the number matched but the amount didn't, it would hold instead, because that might be a corrected invoice."

**3:30–4:20 · Edge case: 07 the bank-detail change**
Run *Kestrel Industrial Supply*.
"This one is perfect: right PO, right prices, goods received. Except it says 'our bank details have changed'. That's the classic payment-fraud move. Three quarters of companies saw attempts like this last year." Show the bank comparison and the lookalike email domain. "Payment is blocked and it goes to Treasury. The email draft goes to the contact we already have on file, never to the address on the invoice, and the next step is a call-back to the phone number in our vendor master."
Show human review: type a note, click Reject (or leave it held). "A person always makes the final call on holds."

**4:20–5:00 · Dashboard and close**
Open *Runs*. "Every run is here: what was decided, who it went to, why, and how long it took. Here's the straight-through rate, and here's why invoices were held." Open *Procurement data* for one sentence on the matching policy: "the tolerances are business rules a controller can change, not something buried in a model."
Close: "It handles real PDFs and scans end to end. The edge cases are the ones that cost AP teams real money. Next I'd add email intake, ERP posting and an approval matrix by amount."

---

## Backup, if something goes wrong live
- Gemini slow or 503: the app retries and then falls back to a second model. If both fail, the run says so plainly. Re-run with the cache on.
- Upload any PDF that isn't an invoice (the case-study guide works) to show the "not an invoice" rejection.
- Free hosting sleeps after 15 minutes idle, so open the live URL a minute before the call.
