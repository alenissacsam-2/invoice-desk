# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- An accounts-payable clerk or AP manager at a mid-size company, working through a queue of vendor invoices at a desk, deciding what to pay, hold or reject. (Inferred; the user delegated these facts.)
- The evaluation audience: Zamp interviewers watching a recorded 5-minute demo and then a live run at roughly 1440px. They judge whether it actually works, the judgment behind the edge cases, and how clearly it explains itself to a non-technical buyer.

## Product Purpose
An invoice (PDF, scan or photo) comes in and a decision comes out (approve, hold for a named team, or reject), with every stage visible as it runs and a history of past runs. Success: the decision is right, the reason is obvious in one read, and nothing is paid that a careful clerk would have stopped.

## Positioning
"The AI reads; the rules decide." The model only extracts fields with confidence scores. Matching, tolerances and the decision are deterministic, auditable rules, so every outcome traces to a rule and a number. Fraud-shaped cases (bank-detail changes, lookalike domains, instructions aimed at AI) are held for a human, never auto-paid.

## Operating Context
Vendor master, purchase orders, goods receipts (CSV "spreadsheet"), a ledger of processed invoices, and a sample inbox of 10 invoices with designed edge cases. The demo is a screen recording plus a live interview run.

## Capabilities and Constraints
- 7-stage pipeline streamed live over SSE.
- Human review requires a name and a note; bank changes also require a call-back confirmation.
- Retry, error kinds, credit notes.
- Stack: Node 24 with no dependencies; vanilla JS frontend with no build step and no CDN JS (Google Fonts allowed).
- Must support **dark and light mode** (user requirement) and stay readable in a screen recording.

## Evidence on Hand
Real sample PDFs and a photo in `samples/`, real master data in `data/`, research notes in `docs/RESEARCH.md`. No customers, metrics or testimonials exist; don't invent any.

## Product Principles
1. The reason comes before the ritual: every screen answers "what was decided and why" first.
2. Show the evidence: the document, the extracted values and the rule that fired sit side by side.
3. Fraud is a first-class outcome, not an error state.
4. Deterministic and honest: label cached reads and drafts; nothing is ever sent or paid.
