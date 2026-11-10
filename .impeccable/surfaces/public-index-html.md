---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["public/js/process.js","public/js/runs.js","public/js/data.js","public/styles.css"]
---

Scope: the whole Invoice Desk app shell (Process / run view, Runs dashboard, Procurement data). Mode: Operate. Audience: AP clerk / manager; Zamp interviewers watching a 5-minute screen recording at 1440px. Task: drop or pick an invoice, watch it get processed, understand the decision and why, act on holds. Constraints: vanilla JS, no build, no CDN JS (Google Fonts ok), light AND dark mode, legible in video.

## Direction contract

THESIS: AP's own paper ritual made live. Every invoice gets a multipart processing slip. The seven stages fill in its numbered rows, and the decision lands as an inked rubber stamp. The carbon-copy colour says whose desk it goes to: white is the AP file, canary is the reviewer, pink goes back to the vendor. It refuses the fintech-SaaS default of white cards, indigo accent, hero KPI tiles and pill badges.

OWN-WORLD: A cool blue-grey desk blotter ground with forms on top. White sheets carry pre-printed rules and labels in NCR form-blue; held and rejected sheets turn canary or pink. Rubber-stamp inks are ledger green (APPROVED), pad violet (ON HOLD) and vermilion (VOID). Boxed form fields have tiny labels at their top-left. Typed values use a typewriter face, and form text uses Public Sans. The stamps are condensed caps in a double-ruled frame with ink texture. Perforated tear lines separate sections, a routing slip carries a ticked destination, and each sheet ends in a copy-distribution footer. Icons come from one authored line set.

STORY: The visitor picks a slip from the in-tray and watches each row tick and type itself in. The stamp lands with the reason beneath it under "Remarks", and the routing slip shows whose desk it's on. A held invoice is signed off in the review block with a name and a note. The visitor leaves believing nothing gets paid that a careful clerk would stop.

FIRST VIEWPORT: Three columns. The in-tray of paper slips is 272px. The processing slip is the centre sheet: a header with the serial No. 0007, a row of boxed typed fields (Vendor, Invoice no., Date, PO, Amount) and seven numbered stage rows. The stamp sits large over the top-right of the slip at about −6°. Remarks, the routing slip and the signature block follow. The original document is clipped to the right at 36%. The primary action is "Drop an invoice" at the top of the tray.

FORM: Carbon copy & rubber stamp, my top-ranked grounded candidate (#1 of 7), chosen by the user as IMPECCABLE'S PICK. Seed 35b16989, re-roll 1. Signature interaction: the stamp lands (scale 1.25→1, ink blot, a 2px sheet jolt, 260ms) and the stage summaries type in. Motion grammar: paper moves, ink lands, and nothing glows.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
