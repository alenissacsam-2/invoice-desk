// Pure: reason codes → decision, route, plain-English explanation, next actions, payment, vendor email draft.
import { money, addDays, fmtDate, isCreditNote, normalizePO } from './rules.js';

/** Reasons that need a call-back to the vendor (phone number in our vendor master) before anyone may approve. */
export const CALLBACK_CODES = ['BANK_DETAILS_CHANGED', 'SUSPICIOUS_INSTRUCTIONS', 'REMIT_DOMAIN_LOOKALIKE'];
// PO quantity/value flags that a duplicate produces just by re-billing what the original already consumed.
const CONSUMED = ['QTY_EXCEEDS_PO', 'QTY_EXCEEDS_RECEIPT', 'PO_OVERRUN'];

const ROUTE = {
  NOT_AN_INVOICE: 'AP clerk', DUPLICATE_INVOICE: 'AP clerk', VENDOR_BLOCKED: 'Procurement',
  BANK_DETAILS_CHANGED: 'Treasury & Security', SUSPICIOUS_INSTRUCTIONS: 'Treasury & Security', REMIT_DOMAIN_LOOKALIKE: 'Treasury & Security',
  VENDOR_UNKNOWN: 'Procurement', CREDIT_NOTE: 'AP clerk',
  PO_NOT_FOUND: 'Procurement', PO_AMBIGUOUS: 'Procurement', PO_VENDOR_MISMATCH: 'Procurement', CURRENCY_MISMATCH: 'Procurement', PO_CLOSED: 'Procurement',
  PRICE_VARIANCE: 'Procurement', PO_OVERRUN: 'Procurement', QTY_EXCEEDS_PO: 'Procurement',
  QTY_EXCEEDS_RECEIPT: 'Receiving',
  MISSING_FIELD: 'AP clerk', ARITHMETIC_MISMATCH: 'AP clerk', LOW_CONFIDENCE: 'AP clerk', DATE_OUT_OF_RANGE: 'AP clerk', TAX_ID_INVALID: 'AP clerk',
  POSSIBLE_DUPLICATE: 'AP clerk', DUPLICATE_FILE: 'AP clerk',
};
const PRIORITY = ['Treasury & Security', 'Procurement', 'Receiving', 'AP clerk'];
// Route priority, with two exceptions: a possible duplicate is checked before any PO question (its PO flags are
// often the original's consumption showing through), and a credit note leads the other AP clerk items.
const rank = (code) => (code === 'POSSIBLE_DUPLICATE' ? 0.5 : code === 'CREDIT_NOTE' ? 2.5 : PRIORITY.indexOf(ROUTE[code] ?? 'AP clerk'));

/** Short sentence-case name per reason code: what the UI shows; the raw code is secondary. */
export const LABELS = {
  NOT_AN_INVOICE: 'Not an invoice', DUPLICATE_INVOICE: 'Already processed', VENDOR_BLOCKED: 'Vendor blocked',
  BANK_DETAILS_CHANGED: 'Bank details changed', SUSPICIOUS_INSTRUCTIONS: 'Suspicious instructions on invoice', REMIT_DOMAIN_LOOKALIKE: 'Lookalike email domain',
  VENDOR_UNKNOWN: 'Unknown vendor', PO_NOT_FOUND: 'No matching PO', PO_AMBIGUOUS: 'More than one PO fits', PO_VENDOR_MISMATCH: 'PO belongs to another vendor',
  CURRENCY_MISMATCH: 'Currency differs from PO', PO_CLOSED: 'PO closed', PRICE_VARIANCE: 'Price above PO',
  PO_OVERRUN: 'Amount over PO', QTY_EXCEEDS_PO: 'Quantity over PO', QTY_EXCEEDS_RECEIPT: 'Billed more than received',
  MISSING_FIELD: 'Missing invoice number or date', ARITHMETIC_MISMATCH: "Numbers don't add up", LOW_CONFIDENCE: 'Hard to read',
  DATE_OUT_OF_RANGE: 'Date out of range', TAX_ID_INVALID: 'Malformed tax ID', POSSIBLE_DUPLICATE: 'Possible duplicate',
  DUPLICATE_FILE: 'Same file received before', CREDIT_NOTE: 'Credit note',
  PO_INFERRED: 'PO inferred', VARIANCE_WITHIN_TOLERANCE: 'Small variance within tolerance', TAX_INCLUSIVE: 'Prices include tax',
};
/** Label for one reason; MISSING_FIELD names what is actually missing when it isn't the number or date. */
export function labelFor(code, ex = {}, vendor = null) {
  if (code === 'MISSING_FIELD' && ex && (ex.invoice_number && ex.invoice_date)) return 'Missing required details';
  if (code === 'VENDOR_UNKNOWN' && vendor) return 'Vendor identity unclear'; // matched a master vendor, but name and tax ID disagree
  return LABELS[code] ?? code;
}
const lc = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s); // "Price above PO" → "price above PO" mid-sentence

const validDate = (s) => (s && addDays(s, 0) === s ? s : null); // "2026-11-31" → null
/**
 * Due date: the LATER of the printed due date and invoice date + the vendor's master terms (we pay on our terms,
 * a shorter printed date doesn't pull payment forward). No master terms: printed date, else invoice date + 30.
 * Dates that are not real calendar dates count as missing.
 */
export function dueDate(ex = {}, vendor = null) {
  const printed = validDate(ex.due_date), inv = validDate(ex.invoice_date);
  const t = vendor?.payment_terms_days;
  const terms = t !== null && t !== undefined && t !== '' && Number.isFinite(Number(t)) ? Number(t) : null;
  const byTerms = inv ? addDays(inv, terms ?? 30) : null;
  if (terms !== null) return [printed, byTerms].filter(Boolean).sort().at(-1) ?? null;
  return printed ?? byTerms;
}
/** The one payment rule, for the system and for a reviewer's approval: due date, never in the past; nothing for a credit note, whatever its sign. */
export function schedulePayment(ex = {}, vendor = null, today = null, currency = ex.currency || vendor?.currency || 'USD') {
  if (isCreditNote(ex)) return null;
  const due = dueDate(ex, vendor);
  return { amount: ex.total ?? null, currency, scheduledFor: !due || (today && due < today) ? (today ?? due) : due };
}

// What has to happen before the money moves, per top reason.
const UNTIL = {
  BANK_DETAILS_CHANGED: 'Treasury confirms the change by calling the vendor on the phone number in our vendor master, never the contact on the invoice',
  QTY_EXCEEDS_RECEIPT: 'Receiving confirms what actually arrived',
  MISSING_FIELD: 'the vendor sends a corrected invoice',
  PRICE_VARIANCE: 'the PO requester approves the difference or the PO is amended',
  PO_OVERRUN: 'the PO requester approves the extra or the PO is amended',
  QTY_EXCEEDS_PO: 'the PO requester approves the extra quantity or the PO is amended',
  VENDOR_UNKNOWN: 'Procurement identifies or sets up the vendor',
  PO_NOT_FOUND: 'Procurement finds or raises the right PO',
  PO_AMBIGUOUS: 'Procurement says which PO it belongs to',
  POSSIBLE_DUPLICATE: 'the AP clerk confirms it is not a double charge',
  SUSPICIOUS_INSTRUCTIONS: 'Treasury confirms the invoice is genuine by calling the vendor on the phone number in our vendor master',
  REMIT_DOMAIN_LOOKALIKE: 'Treasury confirms the invoice is genuine by calling the vendor on the phone number in our vendor master',
};

// One call-back instruction for every Treasury reason, so several of them list it once.
const callBack = (c) => `Call ${c.vname} on ${c.vendor?.phone ? `${c.vendor.phone}, the number in our vendor master` : 'the number in our vendor master'}, not any number or email on the invoice.`;

function actionsFor(code, c) {
  const req = c.po?.requester ? ` (${c.po.requester})` : '';
  switch (code) {
    case 'NOT_AN_INVOICE': return ['File the document or return it to the sender; there is nothing to pay.'];
    case 'DUPLICATE_INVOICE': return [`Do not pay: the original ${c.original?.invoice_number ?? 'invoice'} is already on file${c.original?.run_id ? ` (run ${c.original.run_id})` : ''}.`,
      ...(c.emailKind === 'courtesy' ? ['Send the vendor the drafted courtesy note so they stop the reminders.'] : [])];
    case 'VENDOR_BLOCKED': return [`Ask Procurement why ${c.vname} is blocked before anyone contacts the vendor.`];
    case 'BANK_DETAILS_CHANGED': return [
      'Keep payment blocked until the new bank details are verified.',
      callBack(c),
      'Only Treasury updates the vendor master, and only after that call confirms the change.',
    ];
    case 'SUSPICIOUS_INSTRUCTIONS': return [
      'Ignore the instructions printed on the document; it goes through the normal checks like any other invoice.',
      callBack(c), // same wording as for a bank change, so the list shows it once
    ];
    case 'REMIT_DOMAIN_LOOKALIKE': return [
      'Do not reply to or use the email address on the invoice.',
      callBack(c),
    ];
    case 'CREDIT_NOTE': return [`Apply the credit against ${c.vname}'s next payment${c.original?.invoice_number ? ` (it refers to invoice ${c.original.invoice_number})` : ''}.`, 'Nothing is paid out for a credit note.'];
    case 'VENDOR_UNKNOWN': return ['Procurement to identify the sender and, if genuine, onboard it (tax form, bank details verified by call-back).'];
    case 'PO_NOT_FOUND': return [`Ask the requester for the correct PO, or raise one for ${c.vname}.`];
    case 'PO_AMBIGUOUS': return ['Ask Procurement which of the candidate POs this invoice belongs to.'];
    case 'PO_VENDOR_MISMATCH': return ['Check with Procurement which PO this vendor should have quoted.'];
    case 'CURRENCY_MISMATCH': return ['Ask the vendor to re-issue in the PO currency, or have Procurement amend the PO.'];
    case 'PO_CLOSED': return ['Ask Procurement whether to reopen the PO or raise a new one.'];
    case 'PRICE_VARIANCE': case 'PO_OVERRUN': case 'QTY_EXCEEDS_PO':
      return [`Ask the PO requester${req} to approve the difference or amend the PO; otherwise request a corrected invoice.`];
    case 'QTY_EXCEEDS_RECEIPT': return ['Ask Receiving to confirm whether the rest of the goods arrived and post the goods receipt.', c.emailKind === 'receipt' ? 'If they did not arrive, send the drafted email asking for a credit note or a re-bill for what was received.' : 'If they did not arrive, ask the vendor for a credit note or a re-bill for what was received.'];
    case 'MISSING_FIELD': return [c.emailKind === 'missing' ? `Send the drafted email asking the vendor for a corrected ${c.credit ? 'credit note' : 'invoice'}.` : `Ask the vendor for a corrected ${c.credit ? 'credit note' : 'invoice'} once the other issues are resolved.`];
    case 'ARITHMETIC_MISMATCH': return ['Check the totals against the original document; request a corrected invoice if they are wrong.'];
    case 'LOW_CONFIDENCE': return ['Compare the flagged fields with the original document and correct them if needed.'];
    case 'DATE_OUT_OF_RANGE': return ['Confirm the invoice date with the vendor.'];
    case 'TAX_ID_INVALID': return ['Check the tax ID against the vendor\'s tax form on file.'];
    case 'POSSIBLE_DUPLICATE': return ['Compare this invoice with the earlier one side by side before paying.'];
    case 'DUPLICATE_FILE': return ['Check whether this resend is a reminder for an invoice already being paid.'];
    default: return [];
  }
}

const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function decide({ ex = {}, vendor = null, po = null, reasons = [], today, inferred = false, original = null, sameFile = false }) {
  // A possible duplicate of an approved invoice on the same PO: its PO quantity/value flags are that original's
  // consumption showing through, so they are kept for information and do not drive the decision.
  const dupOfSamePo = reasons.some((r) => r.code === 'POSSIBLE_DUPLICATE') && original?.status === 'approved' && po?.po_number && original.po_number
    && normalizePO(original.po_number) === normalizePO(po.po_number);
  const echoed = new Set(dupOfSamePo ? reasons.filter((r) => r.severity === 'hold' && CONSUMED.includes(r.code)) : []);
  reasons = reasons.map((r) => ({ ...r, ...(echoed.has(r) ? { severity: 'info' } : {}), label: r.label ?? labelFor(r.code, ex, vendor) }));
  const cur = ex.currency || po?.currency || vendor?.currency || 'USD';
  const has = (code) => reasons.some((r) => r.code === code);
  const credit = has('CREDIT_NOTE') || isCreditNote(ex);
  const amt = credit && typeof ex.total === 'number' ? money(-Math.abs(ex.total), cur) : money(ex.total ?? null, cur);
  const named = vendor?.name ?? ex.vendor?.name ?? null;
  const vname = named ?? 'An unknown vendor'; // sentence start
  const vMid = named ?? 'an unknown vendor'; // mid-sentence
  const doc = credit ? 'credit note' : 'invoice';
  const invRef = ex.invoice_number ? `${doc} ${ex.invoice_number}` : `an unnumbered ${doc}`;
  const hRef = ex.invoice_number ? invRef : `unnumbered ${doc}`;
  const subj = named ? `${named} ${hRef}` : `${hRef} from an unknown vendor`;
  const poNo = po?.po_number ?? null;

  const blocks = reasons.filter((r) => r.severity === 'block');
  const holds = reasons.filter((r) => r.severity === 'hold');
  const callback = holds.filter((r) => CALLBACK_CODES.includes(r.code));
  const decision = blocks.length ? 'REJECT' : holds.length ? 'REVIEW' : 'APPROVE';
  const pick = [...(blocks.length ? blocks : holds)].sort((a, b) => rank(a.code) - rank(b.code)); // stable: same route keeps stage order
  const top = pick[0]?.code;
  let route = top ? ROUTE[top] ?? 'AP clerk' : null;
  // A rejected resend that also carries a fraud signal still goes to Treasury: nothing is paid, but the attempt needs a call-back.
  const fraudOnReject = top === 'DUPLICATE_INVOICE' && callback.length > 0;
  if (fraudOnReject) route = 'Treasury & Security';
  const primaryReason = pick[0] ? { code: pick[0].code, severity: pick[0].severity, label: pick[0].label, message: pick[0].message } : null;

  const { kind: emailKind, email: vendorEmail } = draftEmail({ ex, vendor, po, reasons, decision, original, amt, named, invRef, sameFile, credit });
  const c = { vname: vMid, vendor, po, original, sameFile, emailKind, credit };

  const poClause = poNo
    ? inferred ? `, which we matched to ${poNo} because it quoted no PO number` : ` against ${poNo}`
    : ex.po_number ? ` quoting ${ex.po_number}` : credit ? '' : ' with no PO number';
  const intro = `${vname} sent ${invRef} for ${amt}${poClause}`;
  const PO_CODES = ['PO_NOT_FOUND', 'PO_AMBIGUOUS', 'PO_VENDOR_MISMATCH', 'CURRENCY_MISMATCH', 'PO_CLOSED', 'PRICE_VARIANCE', 'PO_OVERRUN', 'QTY_EXCEEDS_PO', 'QTY_EXCEEDS_RECEIPT'];
  const poClean = po && !reasons.some((r) => PO_CODES.includes(r.code));

  let headline, sentences, payment = null;
  if (decision === 'APPROVE') {
    const due = dueDate(ex, vendor);
    payment = schedulePayment(ex, vendor, today, cur);
    const { scheduledFor } = payment;
    headline = `Approve ${amt} to ${vMid} for ${invRef}${poNo ? (inferred ? ` (matched to ${poNo})` : ` against ${poNo}`) : ''}.`;
    const variance = reasons.find((r) => r.code === 'VARIANCE_WITHIN_TOLERANCE');
    const receipt = po?.category === 'goods' ? ' and what was received' : '';
    sentences = [
      intro,
      variance ? variance.message : `Prices and quantities match the PO${receipt}, the totals add up, and it is not a duplicate`,
      `Payment of ${amt} is scheduled for ${fmtDate(scheduledFor)}${due && scheduledFor !== due ? ` (it was due ${fmtDate(due)})` : ''}${emailKind === 'inferred' ? ', and we drafted a note asking them to quote the PO next time' : ''}`,
    ];
  } else if (has('NOT_AN_INVOICE')) {
    headline = `Reject: this document from ${vMid} is not an invoice.`;
    sentences = [blocks.find((r) => r.code === 'NOT_AN_INVOICE').message, 'Nothing will be paid; the AP clerk can file it or return it to the sender'];
  } else {
    const more = pick.length - 1;
    const plus = more ? ` (+${more} more)` : '';
    headline = decision === 'REJECT'
      ? `Reject ${subj}: ${lc(pick[0].label)}${fraudOnReject ? `, and it carries a fraud warning sign (${lc(callback[0].label)})` : ''}.`
      : top === 'CREDIT_NOTE'
        ? `Hold for AP clerk: ${subj} for ${amt}, nothing to pay${plus}.`
        : `Hold for ${route}: ${subj}${!named && top === 'VENDOR_UNKNOWN' ? '' : `, ${lc(pick[0].label)}`}${plus}.`;
    // On a reject with a fraud signal, the second sentence is that signal, not a second block reason.
    const shownR = fraudOnReject ? [pick[0], callback[0]] : pick.slice(0, 2);
    const hidden = (decision === 'REJECT' ? pick.length + holds.length : pick.length) - shownR.length;
    // On a duplicate, PO quantity/value flags are just the original's consumption showing through; say so.
    const echo = top === 'DUPLICATE_INVOICE' && holds.length && holds.every((r) => CONSUMED.includes(r.code)) && hidden === holds.length;
    const others = !hidden ? '' : echo
      ? ` The ${hidden} other flag${hidden > 1 ? 's' : ''} (PO quantities and value already used up) follow from the original having been booked.`
      : ` ${hidden} other issue${hidden > 1 ? 's are' : ' is'} listed below.`;
    const echoNote = echoed.size ? ` Its PO quantity and value flags come from the earlier invoice already being booked against ${poNo}, so they are listed for information only.` : '';
    const queue = route === 'AP clerk' ? 'the AP clerk' : route;
    const last = decision === 'REJECT'
      // "again" only if the original is really being paid
      ? `It will not be paid${top === 'DUPLICATE_INVOICE' && original?.status === 'approved' ? ' again' : ''}${fraudOnReject ? ', and Treasury should call the vendor on the number on file about the warning sign' : ''}.${others}`
      : credit
        ? top === 'CREDIT_NOTE'
          ? `It is on hold with ${queue}, who applies it against ${vMid}'s next payment.${others}`
          : `Nothing is paid out for a credit note; it is on hold with ${queue} until ${UNTIL[top] ?? 'someone resolves this'}, then applied against ${vMid}'s next payment.${others}`
        : `It is on hold with ${queue}, and nothing will be paid until ${UNTIL[top] ?? 'someone resolves this'}.${others}${echoNote}`;
    sentences = [`${intro}${poClean ? `, and the ${po.category === 'services' ? 'services' : 'goods'} and prices match the PO` : ''}`, ...shownR.map((r) => r.message), last];
  }
  const explanation = sentences.map(sentence).join(' ');

  const nextActions = decision === 'APPROVE'
    ? [`Pay ${amt} on ${fmtDate(payment.scheduledFor)} to the bank account in our vendor master.`,
      ...(emailKind === 'inferred' ? [`Send the drafted note asking ${vMid} to quote ${poNo} on future invoices.`] : [])]
    : [...new Set([...pick, ...(fraudOnReject ? callback : [])].flatMap((r) => actionsFor(r.code, c)))];

  return { decision, headline, reasons, primaryReason, explanation, route: decision === 'APPROVE' ? null : route, nextActions, payment, vendorEmail };
}

/** The one vendor email draft for this outcome (or none), and its kind, so next actions only mention what was drafted. */
function draftEmail({ ex, vendor, po, reasons, decision, original, amt, named, invRef, sameFile, credit }) {
  const none = { kind: null, email: null };
  const has = (code) => reasons.some((r) => r.code === code);
  const holding = (code) => reasons.some((r) => r.code === code && r.severity === 'hold');
  if (has('VENDOR_BLOCKED') || has('NOT_AN_INVOICE')) return none;
  const sign = `\n\nKind regards,\nAccounts Payable\n${po?.buyer_entity || ex.bill_to_name || ''}`.trimEnd();
  const dated = ex.invoice_date ? ` dated ${fmtDate(ex.invoice_date)}` : '';
  const poRef = po?.po_number ?? ex.po_number;
  const hello = `Hello ${named ? `${named} team` : 'there'},\n\n`;
  const treasury = reasons.some((r) => r.severity === 'hold' && CALLBACK_CODES.includes(r.code));
  // Master contact first; the invoice's contact only when the vendor is unknown and nothing suggests a fraud attempt.
  const to = vendor?.remit_email || (treasury ? null : ex.vendor?.email) || null;

  if (has('BANK_DETAILS_CHANGED')) {
    if (!vendor?.remit_email) return none; // never write to the invoice's contact about a bank change
    const bd = ex.bank_details ?? {};
    const acct = String(bd.account_number ?? '').replace(/\D/g, '');
    const newBank = bd.bank_name || acct ? ` (${[bd.bank_name, acct ? `account ending ${acct.slice(-4)}` : ''].filter(Boolean).join(', ')})` : '';
    return { kind: 'bank', email: {
      to: vendor.remit_email,
      subject: `Please confirm: bank details change on ${invRef}`,
      body: `${hello}We received ${invRef}${dated} for ${amt}, which asks us to send payment to new bank details${newBank}. We have not changed anything in our records yet.\n\n`
        + `As a security step, our Treasury team will call you to verify this request at the phone number we have on file${vendor.phone ? `, ${vendor.phone},` : ''} before any payment is released. `
        + `If you did not ask to change your bank details, please reply to this email right away, as the request may not have come from you.${sign}`,
    } };
  }
  if (!to) return none;
  if (has('DUPLICATE_INVOICE')) {
    // Our own re-upload of the same file: nothing to tell the vendor. Otherwise only ever to the master address.
    if (sameFile || !vendor?.remit_email) return none;
    const orig = original?.invoice_number ?? ex.invoice_number;
    const status = original?.status === 'on_hold' ? 'is with our team for review' : 'is approved and scheduled for payment under your agreed terms';
    return { kind: 'courtesy', email: {
      to: vendor.remit_email, subject: `Re: ${invRef} – already received`,
      body: `${hello}Thank you for the reminder about ${invRef} for ${amt}. We already have this invoice on file${orig !== ex.invoice_number ? ` as ${orig}` : ''}, and it ${status}.\n\nThere is no need to send it again; we will not pay it twice.${sign}`,
    } };
  }
  if (has('MISSING_FIELD')) {
    const what = credit ? 'credit note' : 'invoice';
    const missing = [!ex.invoice_number && `${credit ? 'a' : 'an'} ${what} number`, !ex.invoice_date && `${credit ? 'a' : 'an'} ${what} date`, !ex.vendor?.name && 'your company name', ex.total == null && 'the total amount'].filter(Boolean);
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0] ?? 'some required details';
    return { kind: 'missing', email: {
      to, subject: `Corrected ${what} needed${poRef ? ` for ${poRef}` : ''}`,
      body: `${hello}We received your ${what} for ${amt}${poRef ? ` referencing ${poRef}` : ''}, but it does not show ${list}. We need ${missing.length > 1 ? 'these' : 'this'} to ${credit ? 'apply the credit' : 'process the payment'}.\n\nCould you please send a corrected ${what} that includes ${list}? We will process it as soon as it arrives.${sign}`,
    } };
  }
  // Receiving data only goes to a vendor we know, and not while this may be a duplicate ("not received" may be the original's consumption).
  if (holding('QTY_EXCEEDS_RECEIPT') && vendor && !has('POSSIBLE_DUPLICATE')) {
    const lines = reasons.filter((r) => r.code === 'QTY_EXCEEDS_RECEIPT').map((r) => `- ${r.message}`).join('\n');
    return { kind: 'receipt', email: {
      to, subject: `${invRef}: quantities billed exceed goods received${poRef ? ` on ${poRef}` : ''}`,
      body: `${hello}Thank you for ${invRef}${dated} for ${amt}. Our receiving records do not yet show all of the goods billed:\n${lines}\n\n`
        + `If these items have shipped, please send the delivery note or tracking details so our receiving team can check. Otherwise, please send a credit note for the difference, or re-bill for the quantities we have received.${sign}`,
    } };
  }
  if (has('PO_INFERRED') && decision !== 'REJECT' && poRef) {
    return { kind: 'inferred', email: {
      to, subject: `Please quote ${poRef} on future invoices`,
      body: `${hello}Thank you for ${invRef} for ${amt}. It did not show a purchase order number, so we matched it to ${poRef} ourselves.\n\nTo avoid delays, please quote the PO number on future invoices.${sign}`,
    } };
  }
  return none;
}
