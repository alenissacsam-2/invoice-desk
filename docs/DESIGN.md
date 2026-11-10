---
name: Invoice Desk
description: Carbon copy and rubber stamp. Every invoice is a multipart processing slip on a cool blue-grey desk, and the decision lands as an inked stamp.
colors:
  desk: "#D4DCE6"
  desk-tray: "#C9D3DF"
  desk-edge: "#A9B7C8"
  sheet: "#FFFFFF"
  canary-copy: "#FFF5C2"
  pink-copy: "#FFE1E8"
  ink: "#1B2232"
  ink-2: "#3A4458"
  ink-3: "#4F5B70"
  form-blue: "#2347B5"
  form-rule: "#A9BBE3"
  form-faint: "#E4EBF9"
  pen-blue: "#1F2F7C"
  carbon-blue: "#2D3A79"
  ledger-green: "#1C7442"
  pad-violet: "#5B3DA8"
  vermilion: "#BC3418"
  on-ink: "#FFFFFF"
typography:
  stamp-word:
    fontFamily: "'Big Shoulders Display', 'Arial Narrow', sans-serif"
    fontSize: "64px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.05em"
  serial:
    fontFamily: "'Big Shoulders Display', 'Arial Narrow', sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 0.85
    letterSpacing: "0.04em"
  page-title:
    fontFamily: "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  slip-name:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.005em"
  sheet-title:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  form-label:
    fontFamily: "'Public Sans', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.01em"
  typed:
    fontFamily: "'Courier Prime', 'Courier New', ui-monospace, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0"
rounded:
  sheet: "2px"
  field: "2px"
  button: "3px"
  tab: "5px"
  stamp: "7px"
  stamp-sm: "5px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  sheet-pad: "16px 20px"
components:
  button-default:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    height: "36px"
    padding: "0 14px"
  button-default-hover:
    backgroundColor: "{colors.form-faint}"
  button-primary:
    backgroundColor: "{colors.form-blue}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.button}"
    height: "36px"
    padding: "0 14px"
  button-approve:
    backgroundColor: "{colors.ledger-green}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.button}"
    height: "36px"
  button-reject:
    backgroundColor: "{colors.vermilion}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.button}"
    height: "36px"
  slip:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.sheet}"
    padding: "20px 20px 14px"
    width: "760px"
  slip-held:
    backgroundColor: "{colors.canary-copy}"
  slip-voided:
    backgroundColor: "{colors.pink-copy}"
  paper-slip:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sheet}"
    padding: "10px 11px 10px 9px"
  form-field:
    textColor: "{colors.ink}"
    typography: "{typography.typed}"
    padding: "5px 8px 7px"
  stamp-approved:
    textColor: "{colors.ledger-green}"
    typography: "{typography.stamp-word}"
    rounded: "{rounded.stamp}"
    padding: "9px 15px 8px"
  stamp-on-hold:
    textColor: "{colors.pad-violet}"
    typography: "{typography.stamp-word}"
    rounded: "{rounded.stamp}"
  stamp-void:
    textColor: "{colors.vermilion}"
    typography: "{typography.stamp-word}"
    rounded: "{rounded.stamp}"
---

# Design System: Invoice Desk

## Overview

**Creative North Star: "The Carbon Copy"**

AP's own paper ritual made live. Every invoice becomes a multipart processing slip lying on a cool blue-grey desk blotter. The seven stages fill its numbered rows, and the decision lands as an inked rubber stamp. The colour of the carbon copy says whose desk the slip goes to: white is the AP file, canary is the reviewer, pink goes back to the vendor. The world is form-first: pre-printed rules and labels in NCR form-blue, boxed fields with tiny labels at their top-left, typewriter-set values, perforated tear lines, a routing slip with a ticked destination, and a copy-distribution footer closing every sheet.

Density is operator-grade: 14px body, ruled tables, 1px hairlines in form-blue tints, no decoration that is not also a form device. Depth is paper lying on paper. Motion is paper moving and ink landing; nothing glows. The same desk exists at night: dark sheets, lifted form-blue, brightened inks, tinted dark copies.

It refuses the fintech-SaaS default of white cards on a pale ground, an indigo accent, hero KPI tiles and pill badges. Counts are boxed form cells, outcomes are stamps, statuses are pen marks in tick boxes.

**Key Characteristics:**
- Three paper colours (white, canary, pink) carry meaning and never change between themes.
- Form-blue is the single drawn-line colour: labels, rules, headings, focus, links, and the primary button.
- Three stamp inks are the only saturated fills: ledger green, pad violet, vermilion.
- Three faces with three jobs: Public Sans for form text, Courier Prime for anything typed in, Big Shoulders Display for stamps and numerals.
- One authored icon set plus hand-drawn pen marks; no glyph or emoji icons.

## Colors

A cool blue-grey desk with white paper on it, one printed-form blue, and three rubber-stamp inks. Light values below are the frontmatter tokens; dark values are theme overrides in the stylesheet and sidecar.

### Primary
- **NCR Form Blue** (`form-blue`, dark `#8FAAF7`): the pre-printed layer. Field labels, sheet titles, header rules (2px), column heads, step numerals, links, caret, focus ring, selection tint, active-nav underline, and the primary button fill (`--action`, same value).
- **Pen Blue** (`pen-blue`, dark `#B4C5FF`): what a clerk writes. Tick marks in boxes and strike-through on completed actions.
- **Carbon Blue** (`carbon-blue`, dark `#BAC6F2`): drafted memo text on ruled lines.

### Secondary (stamp inks)
- **Ledger Green** (`ledger-green`, dark `#5FCB90`): APPROVED stamp, approve button, passing status text, string values in JSON.
- **Pad Violet** (`pad-violet`, dark `#BEA8FF`): ON HOLD stamp, warnings, low-confidence marks, missing values, call-back requirement.
- **Vermilion** (`vermilion`, dark `#FF8668`): VOID stamp, reject button, failed checks, error text, mismatch highlight.

### Neutral
- **Desk Blotter** (`desk` `#D4DCE6`, dark `#131922`): page ground and the tear-line notch colour. `desk-tray` (`#C9D3DF`, dark `#0F141C`) is the top bar and in-tray; `desk-edge` (`#A9B7C8`, dark `#2B3546`) is their borders and scrollbars.
- **White Copy** (`sheet` `#FFFFFF`, dark `#1C2331`): the AP-file sheet, buttons, in-tray slips.
- **Canary Copy** (`canary-copy` `#FFF5C2`, dark `#3D341A`): slip tint when held for the reviewer; the slip also carries a 6px top band in full-strength canary `#F2D246` (both themes).
- **Pink Copy** (`pink-copy` `#FFE1E8`, dark `#40222F`): slip tint when voided, returned to vendor; 6px top band in full-strength pink `#EE97B0` (both themes). Ink, secondary ink and form-blue all hold 4.5:1 or better on both dark tints.
- **Ink** (`ink` `#1B2232`, dark `#E6EAF2`), **ink-2** (`#3A4458`, dark `#BCC5D4`), **ink-3** (`#4F5B70`, dark `#9CA7BA`): text tiers; ink-3 is the lowest legible tier.
- **Form Rule** (`form-rule` `#A9BBE3`, dark `#3B4A69`): 1px field and row rules, dotted check rules, tear line. **Form Faint** (`form-faint` `#E4EBF9`, dark `#253048`): hover and count-chip fill.
- File tabs use five paper tints (plain, mint, amber, rose, sky) defined per theme; they label a slip's expected outcome, nothing else.

### Named Rules
**The Copy Colour Rule.** Sheet tint is the destination, not decoration: white (AP file), canary (reviewer), pink (return to vendor). The three paper colours are fixed names, so the distribution swatches keep the same fill in both themes.

**The Three Inks Rule.** Green, violet and vermilion appear only as outcome: stamps, sign-off buttons, check marks, and status text. A fourth saturated hue does not enter the system.

**The Pre-printed Rule.** Anything the form already says (labels, rules, headings) is form-blue; anything a person or the machine puts in is ink or typewriter. Never swap them.

## Typography

**Display Font:** Big Shoulders Display (with Arial Narrow, sans-serif), weights 700 to 900
**Body Font:** Public Sans (with system-ui, Segoe UI, sans-serif), weights 400 to 700
**Typewriter Font:** Courier Prime (with Courier New, ui-monospace), weights 400 and 700

**Character:** A government form with a rubber stamp and a typewriter on the desk. Public Sans is the neutral printed layer, Courier Prime is the keyed-in layer, and the condensed caps of the stamp are the loudest voice on the page. Body numerals are tabular everywhere; typed values reset to normal figures.

### Hierarchy
- **Stamp word** (900, 64px, line 1, +0.05em, uppercase): the slip's stamp (42px on phones). Specimen stamp 40px, small stamp 23px; mini-stamp 800 at 13px, +0.07em; stamp sub-line 700 at 16px on the slip (12.5px elsewhere), +0.16em.
- **Serial** (800, 30px, line .85, +0.04em): the slip No. Paper numbers in the tray and stage numerals use 800 at 21px and 18px.
- **Page title** (700, 24px, 1.25, -0.015em): landing and page headings; exception title 20px; primary reason 19px.
- **Slip name** (700, 19px, 1.2): the slip header. Sheet title 16px; form heading 13.5px; sub-heading 12.5px, all form-blue. The tray's rail title (700, 15px, ink) is deliberately different: it sits on the desk, off any sheet, so it is ink rather than form-blue.
- **Body** (400 and 600, 14px, 1.5): form text; secondary 13px and 12.5px; explanations cap at 72ch, ledes at 68ch.
- **Form label** (600, 12px, 1.25, +0.01em, sentence case, form-blue): the tiny label at a field's top-left; slip column heads, file tabs and the inferred tag also 12px; table column heads 11.5px. Slip header meta 13.5px; check progress and stage times 13px to 13.5px.
- **Typed** (400, 13.5px to 15px, 1.3): field values, check details, stage summaries, memo text (13px on 21px ruled lines), JSON (12.5px/1.6). Tally values 26px.

### Named Rules
**The Typed Value Rule.** Every value a person or the extractor entered (vendor, invoice no., date, PO, amount, file name, memo, signature inputs) is in Courier Prime. Labels are never typewritten.

**The Stamp Voice Rule.** Condensed display caps belong to stamps, serials and numerals. They never set headings or body copy.

## Layout

A desk with three working columns at desktop: the in-tray (272px fixed), the processing slip (flexible, max 760px centred; 880px when the document column is hidden), and the original document clipped on at 36%. Header height is 56px, sticky. The process view fills the viewport under the bar, and the tray and slip scroll independently.

The slip reads top to bottom: header (name, serial, decision box 248px wide), a five-column boxed field row (Vendor, Invoice no., Date, PO, Amount), the seven numbered stage rows on a 22/22/flex/84/16px grid, a tear line, Remarks, routing slip beside actions (220px + flex), payment line, memo, signature block, and the copy-distribution footer with a 2px form-blue top rule. Pages (Runs, Procurement data) sit on a 1480px max container with 22px 28px padding; Runs leads with a six-cell batch control tally and a two-column exceptions list; Procurement data is a main column plus a sticky 300px contents and policy aside.

Rhythm is 4/8/12/16/20px with 14-18px between sections. Fields are bordered cells sharing 1px rules, not separated cards.

Breakpoints:
- **1279px and below**: the document column leaves the grid; a Slip/Original tab switch replaces it; the tally goes to three columns; data aside stacks above the content.
- **960px and below**: organisation name hides; exception rows go single column.
- **799px and below**: the app becomes one column; nav scrolls under the brand; slip header and fields collapse (2-up fields, vendor full width); stage meta moves under the stage name; tally goes to two columns; tables scroll horizontally.

## Elevation & Depth

Paper lying on paper. Depth is a stack of soft contact shadows, never a glow and never a hard offset. Resting sheets use a three-layer shadow (1px contact, 2px, then a long 14px blur at -14px spread); in-tray slips use a lighter two-layer; hover and the current slip use a lift. Dark mode drops the mid layer and deepens the long layer. The in-tray drop zone is a recess: inset lip shadow plus stacked-sheet edge lines at its bottom. Stamps are the only translucent layer: multiply blend at 0.88 in light, screen blend at 0.92 in dark, so typed text under the ink stays readable. A white slip shows the canary and pink copies beneath it as 3px and 6px offset edges.

### Shadow Vocabulary
- **Sheet** (`0 1px 1px rgba(27,34,50,.07), 0 2px 4px -1px rgba(27,34,50,.08), 0 14px 30px -14px rgba(27,34,50,.3)`): slips, pages' sheets, document sheet.
- **Slip** (`0 1px 1px rgba(27,34,50,.08), 0 3px 8px -3px rgba(27,34,50,.2)`): in-tray paper, active theme toggle.
- **Lift** (`0 2px 3px -1px rgba(27,34,50,.12), 0 10px 18px -8px rgba(27,34,50,.32)`): hovered and current paper.

### Named Rules
**The Paper Only Rule.** Shadows describe sheets resting on the desk. Nothing glows, no coloured shadows, no offset block shadows.

## Shapes

Paper is nearly square: sheets and fields at 2px, buttons at 3px, count chips 3px, tabs round only their top corners (5px). Stamps are the exception at 7px (5px small, 3px mini). A stamp is a 3.5px border with a second 1.5px rule inset 8.5px inside it, rotated -6deg (-4deg small, -2.5deg mini), roughened and speckled by the ink filter. Tick boxes are 20px (16px small) printed squares with a 1.5px form-blue border; the pen mark spills past the box like a real tick. Perforated tear lines (2px dashed, with a half-circle notch of desk colour at each edge) separate sections of a slip. The document is clipped to its sheet by a wire paper clip at 7deg.

Pills are not used; counts are 3px-radius chips.

## Components

### Buttons
- **Shape:** squared (3px), 36px tall (28px small), 600 weight at 13.5px (12.5px small), 1px border.
- **Default:** white sheet, form-rule border, ink text. Hover: form-faint fill and form-blue border. Active: 1px press down.
- **Primary:** form-blue fill, white text (dark: lifted blue fill, near-black text). Hover mixes 16% ink in. Used once per view ("Drop an invoice").
- **Approve / Reject:** ledger green and vermilion fills; the only saturated controls on a slip.
- **Ghost:** transparent, ink-2 text; hover shows desk fill and edge border.
- **Disabled:** 42% opacity, not-allowed cursor. Busy: progress cursor.

### Processing Slip
The signature sheet. White by default, canary when held, pink when voided (300ms tint transition). Header carries the slip name and organisation in form-blue, the file in typewriter, a serial No. in display numerals (a sample's own number, else the run's place in the register, oldest first), and the decision. Until the decision, a dashed placeholder (min-height 106px) holds the stamp's place or a retry control; once inked, the stamp overprints the slip head (absolute, 12px from the right, 50px from the top, above the field row's top edge). Form fields are bordered cells with a 12px label above a typed value. Remarks is one such boxed field: the headline typed in the outcome ink, the explanation once, then each reason with its code in small mono.

### Stage Rows
Seven numbered rows with a tick box, an outline icon, a name, a typed summary that types itself in, a status, and a ms count. Running rows get a 7% form-blue wash, a 2px box, and a blinking caret; passing rows pen a blue tick; warnings a violet exclamation; failures a vermilion cross (on a rejected run, the stage that raised the blocking reason reads "Blocks payment" in vermilion); skipped a grey strike. Rows expand with a chevron to dotted-rule check lists, tables, and ink bars. Problems keep their full text; passing detail is truncated.

### Stamps
Large (40px), small (23px), and mini (13px, 3px double border) variants in the three inks: APPROVED, ON HOLD, VOID. A decision made by a person reads "Approved" or "Rejected" with the sub-line "By reviewer" and the date. The ink filter is two SVG filters in the page: `ink` (fractal-noise displacement of 2.4 for rough edges, then a thresholded grain for speckled coverage) for the stamp frame and word, and a lighter `ink-sm` for the stamp's date line, mini stamps and exception bars. Landing: scale 1.25 to 1 and fade in over 260ms with a (.2,.9,.25,1) curve, an ink blot (a tone-coloured wash through the ink filter, opacity .3 to 0 and scale 1.06 to 1 over 260ms; none under reduced motion), plus a 2px sheet jolt at 190ms delay for 220ms; opening a finished run shows the stamp already inked.

### In-tray Slips and Drop Zone
Each sample is a mini sheet: a display numeral, vendor in bold, a two-line scenario, a file tab in a paper tint for the expected outcome, and a ruled footer. The current slip shifts 7px right with a 1.5px form-blue outline; hover lifts by 1px. The drop zone is a recessed tray with a lip; dragging over it turns the lip form-blue and the border dashed, and the icon drops 3px.

### Form Fields and Sign-off
Boxed cells with a form-blue label at top-left and a typed value; input boxes are transparent with a 15px typewriter value and take a 2px form-blue focus outline plus a 7% blue wash. The review block is a 1.5px form-blue box with name and note cells and a dashed violet call-back row for bank changes; approve and reject are stamp-ink buttons.

### Routing Slip, Remarks, Memo
Remarks is a form heading with dotted-rule reasons, each with a pen mark. The routing slip is a bordered list of destinations; the active one is bold with a pen tick. Actions are tick boxes that strike through in pen blue when checked. The memo is a collapsible, lightly tinted box with typed text on 21px ruled lines.

### Registers, Tally and Tables
Ruled tables: form-blue 1.5px header rule, 1px form-rule row rules, no zebra, right-aligned tabular numbers, whole-row link with a faint blue hover. The batch control sheet is six bordered tally cells with a 26px typed value; the exception list pairs a pen mark, label, ink bar (inked with the small filter; its length is the share of invoices received) and an "n of N" count. Filter tabs are paper file tabs: selected tab becomes sheet-coloured and joins the sheet below.

### Navigation
A desk-coloured top bar: brand mark (a stamped slip), name, organisation, three text links with a 2.5px form-blue underline on the current page and a count chip, then a three-way theme toggle (System, Light, Dark; the active option sits on a sheet chip) and a ghost Reset demo button. Focus: 2px form-blue outline, 2px offset.

### Icons
One authored line set: 20-unit grid, 1.5px stroke, round caps and joins, `currentColor`, form-blue where decorative. Seven stage icons (inbox tray, reading document, sum, building, duplicate, linked records, stamp) plus interface icons. Status is shown with pen marks (tick, exclamation, cross, dash, info) at 2.1px stroke, drawn in with a dash-offset animation (220ms, second stroke delayed 140ms). No emoji, no icon fonts, no glyph characters used as icons.

### Copy Voice
Plain clerk's English, sentence case, singular nouns for form labels ("Remarks", "Routing", "Copies"). Outcomes lead with the reason before the ritual. Empty and error states speak as the desk: "No runs yet. Pick a sample and the first one lands here." and "This slip is no longer on file." Drafts and cached reads are labelled as such. Nothing is claimed to be sent or paid.

## Do's and Don'ts

### Do:
- **Do** tint the slip by its destination (white, canary, pink) and show the same three swatches in the distribution footer.
- **Do** set every entered or extracted value in Courier Prime and every pre-printed label in form-blue Public Sans.
- **Do** keep stamps to the three inks, rotated -6deg, with the ink filter and a double-ruled frame.
- **Do** use pen marks in tick boxes for status and one line-icon set for everything else.
- **Do** express depth only with the three paper shadows above, and keep rest-state hairlines at 1px in form-rule.
- **Do** keep text on ink, ink-2 or ink-3 tiers; ink-3 is the lowest tier for any readable text.
- **Do** honour `prefers-reduced-motion` by dropping every animation and transition.

### Don't:
- **Don't** use white cards on a pale ground with an indigo accent, hero KPI tiles, or pill badges.
- **Don't** add glow, coloured shadows, gradients as decoration, or backdrop blur.
- **Don't** set headings or body text in the stamp face; it is for stamps and numerals.
- **Don't** introduce a fourth saturated colour or recolour the paper tints per theme.
- **Don't** replace the stamp with a coloured pill or a badge; outcome is always a stamp or mini-stamp.
- **Don't** use emoji or glyph characters as icons.
