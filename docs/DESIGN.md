# Invoice Desk — UI design

The product is an AP operations console. It should feel like a calm, exact instrument, the kind of thing a finance lead trusts: a ledger on paper, not a SaaS landing page. The viewer is an interviewer watching a 5-minute demo, so each run has to be readable at a glance at 1440×900 and in a screen recording.

## Tokens (CSS custom properties on `:root`; dark mode via `prefers-color-scheme: dark`)
| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F6F5F1` (warm paper) | `#111214` |
| `--surface` | `#FFFFFF` | `#1A1B1E` |
| `--surface-2` | `#FBFAF7` | `#202226` |
| `--ink` | `#17181A` | `#ECECEA` |
| `--ink-2` | `#55575C` | `#A6A8AD` |
| `--ink-3` | `#8A8C91` | `#75777C` |
| `--rule` | `#E3E1DA` | `#2C2E33` |
| `--accent` | `#2F4BDB` | `#7D90FF` |
| `--approve` / `--approve-bg` | `#1E7A4C` / `#E8F3EC` | `#5CC48E` / `#15281E` |
| `--review` / `--review-bg` | `#A15C00` / `#FBF1E0` | `#E8A64A` / `#2C2112` |
| `--reject` / `--reject-bg` | `#B3261E` / `#FBEAE8` | `#F2827A` / `#2E1715` |

- Type: **IBM Plex Sans** (UI, 400/500/600) and **IBM Plex Mono** (all money, IDs, invoice/PO numbers, durations, codes), from Google Fonts. Base 14px/1.5; small 12.5px; section titles 13px uppercase, 0.06em tracking, `--ink-3`; page title 22px/600; decision word 28px/600.
- Numbers: `font-variant-numeric: tabular-nums`, right-aligned in tables, formatted with currency (USD `$4,111.07`; INR `₹1,16,820.00` via `Intl.NumberFormat('en-IN')`).
- Radius 8px on cards, 6px on controls, 999px on chips. Borders 1px `--rule`. Shadows: none, except a 0 1px 2px rgba(0,0,0,.04) on cards. Spacing scale 4/8/12/16/24/32.
- Icons: inline SVG only (no icon fonts, no emoji): pending ○, running spinner, passed ✓ in a circle, warning triangle, failed ×, skipped dash. Status is always icon + colour + text, never colour alone.
- Motion: stage rows enter with a 160ms fade + 4px rise; the spinner is CSS only. All of it is off under `prefers-reduced-motion`.

## Shell
Top bar, 56px, `--surface`, bottom rule: wordmark "Invoice Desk" (a small accent mark plus 600 weight text) and a muted "Halden Robotics · Accounts Payable". Nav: **Process** (`#/`), **Runs** (`#/runs`), **Procurement data** (`#/data`); the active tab gets an accent underline. Right side: a ghost "Reset demo" button (confirm() first, then POST /api/reset).

## Process screen (`#/` and `#/run/:id`)
Three columns at ≥1280px: **Inbox rail 300px** | **Run 1fr** | **Document 44%** (the document column appears only when a run is selected). Below 1280px the document becomes a tab inside the run column. Below 800px everything stacks.

**Inbox rail**
- Drop zone at the top: dashed `--rule` border, "Drop an invoice (PDF, PNG, JPG)", "or browse" link, max 10 MB. Drag-over turns it accent. Upload with `fetch('/api/runs', {method:'POST', body:file, headers:{'Content-Type':file.type,'X-Filename':file.name}})`, then navigate to `#/run/:id`.
- Checkbox "Re-extract (skip cache)", which sends `fresh=1`.
- Title "Sample inbox", then one row per `/api/samples` item, styled like an email inbox: vendor (500), scenario (12.5px, `--ink-2`, 2 lines max), chips for tags ("Happy path" accent-tinted, "Edge case" review-tinted, "Scanned" neutral), and on the right a muted mono "expects REVIEW". If `runAfter` is set, show a muted hint "run after 01". Clicking a row POSTs `?sample=file` and navigates. The current run's sample is highlighted.

**Run column**
- Empty state (no run selected): title "How a run works" and the 7 stages as a numbered list, each with a one-line plain-English description (Intake, Read the invoice, Validate, Vendor check, PO match, Duplicate check, Decision). This doubles as the process map for the demo. Then a prompt: "Pick a sample or drop a file to start."
- Run header: filename (mono), "Run r_xxxx · started 14:02:11", a live elapsed timer that stops at done, source chip (Sample / Upload), and a "cached extraction" chip when relevant.
- **Decision card** (appears at the top once the decision stage completes; `aria-live="polite"`): left 4px bar plus tinted background in the decision colour; the decision word (APPROVE / REVIEW / REJECT, with "Approved", "On hold for review" or "Rejected" as a subtitle); headline (16px/500); explanation paragraph; route line ("Routed to **Treasury & Security**"); reason list (each row has a severity icon, a mono code chip and the message; info reasons sit in a muted "Notes" group); next actions as a checklist; payment line for APPROVE ("Scheduled: $4,111.07 on 27 Nov 2026"); vendor email draft as a collapsible block labelled "Draft email · not sent", showing to/subject/body in a mono-ish pre-wrap box with a "Copy" button. For REVIEW runs not yet reviewed, a **Human review** box: note textarea, then "Approve anyway" (approve-coloured outline) and "Reject" (reject outline). It POSTs `/api/runs/:id/review` and then shows "Approved by reviewer · note" instead.
- **Stage timeline**: a vertical list of 7 rows joined by a thin vertical connector line. Each row: status icon, stage name (500), summary (`--ink-2`), right-aligned mono duration ("412 ms" or "3.8 s"). Rows auto-expand while running and when their status is warning or failed; others expand on click (a proper `<button aria-expanded>`). The expanded body holds the checks list (icon, label, detail). Stage-specific bodies:
  - extract: model + latency + cached chip; a **fields table** (Field | Value | Confidence), where confidence is a 48px bar with the number and below 0.7 turns review-coloured; then a **line items** table; then a "Notices on document" callout if notices exist (review-tinted).
  - vendor: matched vendor, method (tax ID / name), and a two-row **bank comparison** (On file vs On invoice) with the differing digits highlighted in reject colour.
  - po_match: PO number with "inferred" chip and score if inferred, candidate list when ambiguous, and a **line match table** (Item | Billed qty | Ordered | Received | Prev. invoiced | Unit price | PO price | Var %), with failing cells in reject colour, warning cells in review colour, and a 2-way/3-way chip.
  - duplicate: when there's a match, a link "See original run →".
- Live behaviour: open `EventSource('/api/runs/:id/events')`. Queue incoming stage updates and reveal them with at least 280ms between visible transitions, so the eye can follow stages that finish in 2ms (the real durations are still displayed). The `done` event closes the stream and refreshes the inbox highlight and the nav "Runs" count.

**Document column**: a sticky card with tabs "Document" | "Extracted JSON". Document shows `/api/runs/:id/file` in an `<iframe>` for PDF or an `<img>` for images, at full column height. JSON is a pretty-printed `<pre>` with a copy button.

## Runs dashboard (`#/runs`)
- KPI strip, 6 tiles: Invoices processed; Auto-approved (count + rate %); On hold; Rejected; Value approved (per currency, mono); Median processing time. Tile = label (12px uppercase `--ink-3`) + value (24px mono/600) + a small sub-line.
- "Why invoices were held or rejected": a horizontal bar list of reason codes (hold/block only) with counts. Bars use the severity colour, label left, count right, with no axes. Hide it when there are none.
- Filter chips: All · Approved · Review · Rejected · Awaiting human.
- Runs table: Time (mono, relative + absolute in title attribute) | Vendor (+ filename muted below) | Invoice # (mono) | Amount (mono right) | PO (mono, "inferred" marker) | Decision chip | Routed to | Main reason | Duration. The whole row is clickable to `#/run/:id`, keyboard accessible. Running rows show a spinner. Reviewed runs show "→ Approved by reviewer" under the chip.
- Empty state: "No runs yet." plus a button "Run the demo set" that POSTs each sample in manifest order, waiting for each to finish (poll /api/runs/:id until status done) before starting the next.

## Procurement data (`#/data`)
Section titles followed by tables:
- **Purchase orders**: PO (mono), vendor, category chip (goods 3-way / services 2-way), requester, net total, invoiced, remaining, and a thin progress bar of invoiced/total. Rows expand to show lines: item code, description, ordered, received, invoiced, unit price.
- **Vendors**: id, name, tax ID, country, bank (masked `•••• 3344` + routing), remit email, status chip (blocked in reject colour).
- **Goods receipts** and **Ledger** (invoice #, vendor, PO, net, total, status chip, link to run).
- Above the tables, a muted note: "Loaded from data/*.csv on boot — the procurement spreadsheet. Ledger updates as runs are approved."

## Copy rules
Plain English and sentence case. Say "On hold for review", not "REVIEW_STATE". Error states say what happened and what to do ("Gemini is rate-limited right now. Retrying with the fallback model…" / "This file isn't a PDF or image").
