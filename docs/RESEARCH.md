# Research notes (for the demo narration and the interview)

These are the reasons behind the design choices. The sources are linked so you can quote them.

## How Zamp talks about AP
- Zamp describes a "digital workforce" that owns a function end to end and brings humans in only when needed. AP vocabulary: case, touchless / straight-through rate, exception rate, human-in-the-loop review queue, approval matrix, "read back". (https://www.zamp.ai/, https://www.zamp.ai/blogs/invoice-processing-automation-how-it-actually-works)
- Their pipeline: register → extract (traceable to source) → validate supplier → check totals/tax/dates/currency → 2- or 3-way match → investigate exceptions → route → post and read back → archive the evidence. Invoice Desk follows the same shape.
- "Touchless processing should be earned." Bank-detail changes go to a separate verification path. An escalation arrives with the source documents, findings and a specific question.
- Tolerance and escalation rules live in an editable procedure, not in code buried inside a model. Here that is `src/config.js`, shown in the UI as "Matching policy".

## Matching
- 2-way (invoice vs PO) for services, 3-way (plus goods receipt) for goods. SAP checks quantity against the open quantity, meaning delivered minus already invoiced. That is exactly the split-invoice edge case. (https://learning.sap.com/courses/invoice-verification-in-sap-s-4hana/entering-invoices-with-variances-1)
- Tolerances are configured per company, and no vendor publishes a universal default. Common practice is a percentage plus an absolute cap where the tighter one wins; ours is 2% and $100. Quantity is stricter than price, so we allow 0 over receipt. (Oracle: https://docs.oracle.com/en/cloud/saas/financials/25d/faipp/invoice-tolerances.html, NetSuite difference limit)
- APQC median: 85% of invoices are matched to a PO.

## Duplicates
- SAP's standard duplicate check compares vendor, currency, reference number, invoice date and gross amount. Practitioners normalise numbers by stripping dashes, slashes and leading zeros. (https://userapps.support.sap.com/sap/support/knowledge/en/3774533)
- Same number with a different amount may be a corrected invoice or a credit memo, so it goes to review rather than auto-reject.
- Duplicate or erroneous payments are about 0.8% (top performers) to 2% (bottom) of annual disbursements, per APQC. (https://www.cfo.com/news/metric-of-the-month-detect-and-prevent-duplicate-or-erroneous-payments/)

## Bank-detail fraud (BEC)
- AFP 2026 survey: 76% of organisations hit by payments fraud in 2025, 74% by BEC, and 80% say AP is highly vulnerable. (https://www.financialprofessionals.org/about/learn-more/press-releases/Details/over-75-percent-of-us-firms-experienced-payments-fraud-in-2025-while-ai-adoption-for-fraud-mitigation-lags)
- FBI IC3 2025: BEC losses of about $3.05B.
- Control: never trust bank details printed on an invoice. Verify by call-back to the number already in the vendor master, and have a second person approve.

## Exceptions and routing
- Price issues go to the buyer, a missing receipt to the requester or receiving, a missing PO to procurement, and vendor or bank issues to vendor master or treasury.
- Exception rate benchmark: about 20% on average, about 12% best-in-class (Ardent Partners 2026, via Medius).

## Tax
- Check that lines sum to the subtotal, that the subtotal × rate matches the tax within rounding, and that the subtotal plus tax equals the total. Tax-inclusive totals back out tax as total × rate/(100+rate). (HMRC VAT Notice 700)
