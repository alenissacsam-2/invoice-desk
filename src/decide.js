// Pure: reason codes → decision, route, plain-English explanation, next actions, payment, vendor email draft.
import { money, addDays } from './rules.js';

const ROUTE = {
  NOT_AN_INVOICE: 'AP clerk', DUPLICATE_INVOICE: 'AP clerk', VENDOR_BLOCKED: 'Procurement',
  BANK_DETAILS_CHANGED: 'Treasury & Security', VENDOR_UNKNOWN: 'Procurement',
  PO_NOT_FOUND: 'Procurement', PO_AMBIGUOUS: 'Procurement', PO_VENDOR_MISMATCH: 'Procurement', CURRENCY_MISMATCH: 'Procurement', PO_CLOSED: 'Procurement',
  PRICE_VARIANCE: 'Procurement', PO_OVERRUN: 'Procurement', QTY_EXCEEDS_PO: 'Procurement',
  QTY_EXCEEDS_RECEIPT: 'Receiving',
  MISSING_FIELD: 'AP clerk', ARITHMETIC_MISMATCH: 'AP clerk', LOW_CONFIDENCE: 'AP clerk', DATE_OUT_OF_RANGE: 'AP clerk', TAX_ID_INVALID: 'AP clerk',
  POSSIBLE_DUPLICATE: 'AP clerk', DUPLICATE_FILE: 'AP clerk',
};
const PRIORITY = ['Treasury & Security', 'Procurement', 'Receiving', 'AP clerk'];
const rank = (code) => PRIORITY.indexOf(ROUTE[code] ?? 'AP clerk');

const SHORT = {
  NOT_AN_INVOICE: 'not an invoice', DUPLICATE_INVOICE: 'duplicate of an invoice already on file', VENDOR_BLOCKED: 'vendor is blocked',
  BANK_DETAILS_CHANGED: 'bank details differ from the vendor master', VENDOR_UNKNOWN: 'vendor not in the vendor master',
  PO_NOT_FOUND: 'no matching PO', PO_AMBIGUOUS: 'more than one PO could fit', PO_VENDOR_MISMATCH: 'PO belongs to another vendor',
  CURRENCY_MISMATCH: 'currency differs from the PO', PO_CLOSED: 'PO is closed', PRICE_VARIANCE: 'price above the PO',
  PO_OVERRUN: 'amount over the PO', QTY_EXCEEDS_PO: 'quantity over the PO', QTY_EXCEEDS_RECEIPT: 'billed for more than was received',
  MISSING_FIELD: 'required details missing', ARITHMETIC_MISMATCH: "the numbers don't add up", LOW_CONFIDENCE: 'some fields were hard to read',
  DATE_OUT_OF_RANGE: 'invoice date out of range', TAX_ID_INVALID: 'tax ID is malformed', POSSIBLE_DUPLICATE: 'possible duplicate',
  DUPLICATE_FILE: 'same file received before',
};

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
};

function actionsFor(code, c) {
  const req = c.po?.requester ? ` (${c.po.requester})` : '';
  switch (code) {
    case 'NOT_AN_INVOICE': return ['File the document or return it to the sender; there is nothing to pay.'];
    case 'DUPLICATE_INVOICE': return [`Do not pay: the original ${c.original?.invoice_number ?? 'invoice'} is already on file${c.original?.run_id ? ` (run ${c.original.run_id})` : ''}.`, 'Send the vendor the drafted courtesy note so they stop the reminders.'];
    case 'VENDOR_BLOCKED': return [`Ask Procurement why ${c.vname} is blocked before anyone contacts the vendor.`];
    case 'BANK_DETAILS_CHANGED': return [
      'Keep payment blocked until the new bank details are verified.',
      `Call ${c.vname} on the number in our vendor master${c.vendor?.phone ? ` (${c.vendor.phone})` : ''}, not any number or email on the invoice.`,
      'Only Treasury updates the vendor master, and only after that call confirms the change.',
    ];
    case 'VENDOR_UNKNOWN': return ['Procurement to identify the sender and, if genuine, onboard it (tax form, bank details verified by call-back).'];
    case 'PO_NOT_FOUND': return [`Ask the requester for the correct PO, or raise one for ${c.vname}.`];
    case 'PO_AMBIGUOUS': return ['Ask Procurement which of the candidate POs this invoice belongs to.'];
    case 'PO_VENDOR_MISMATCH': return ['Check with Procurement which PO this vendor should have quoted.'];
    case 'CURRENCY_MISMATCH': return ['Ask the vendor to re-issue in the PO currency, or have Procurement amend the PO.'];
    case 'PO_CLOSED': return ['Ask Procurement whether to reopen the PO or raise a new one.'];
    case 'PRICE_VARIANCE': case 'PO_OVERRUN': case 'QTY_EXCEEDS_PO':
      return [`Ask the PO requester${req} to approve the difference or amend the PO; otherwise request a corrected invoice.`];
    case 'QTY_EXCEEDS_RECEIPT': return ['Ask Receiving to confirm whether the rest of the goods arrived and post the goods receipt.', 'If they did not arrive, send the drafted email asking for a credit note or a re-bill for what was received.'];
    case 'MISSING_FIELD': return ['Send the drafted email asking the vendor for a corrected invoice.'];
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

export function decide({ ex = {}, vendor = null, po = null, reasons = [], today, inferred = false, original = null }) {
  const cur = ex.currency || po?.currency || vendor?.currency || 'USD';
  const amt = money(ex.total ?? null, cur);
  const vname = vendor?.name ?? ex.vendor?.name ?? 'An unknown vendor';
  const invRef = ex.invoice_number ? `invoice ${ex.invoice_number}` : 'an unnumbered invoice';
  const hRef = ex.invoice_number ? invRef : 'unnumbered invoice';
  const poNo = po?.po_number ?? null;
  const c = { vname, vendor, po, original };

  const blocks = reasons.filter((r) => r.severity === 'block');
  const holds = reasons.filter((r) => r.severity === 'hold');
  const decision = blocks.length ? 'REJECT' : holds.length ? 'REVIEW' : 'APPROVE';
  const pick = [...(blocks.length ? blocks : holds)].sort((a, b) => rank(a.code) - rank(b.code)); // stable: same route keeps stage order
  const top = pick[0]?.code;
  const route = top ? ROUTE[top] ?? 'AP clerk' : null;
  const has = (code) => reasons.some((r) => r.code === code);

  const poClause = poNo
    ? inferred ? `, which we matched to ${poNo} because it quoted no PO number` : ` against ${poNo}`
    : ex.po_number ? ` quoting ${ex.po_number}` : ' with no PO number';
  const intro = `${vname} sent ${invRef} for ${amt}${poClause}`;
  const PO_CODES = ['PO_NOT_FOUND', 'PO_AMBIGUOUS', 'PO_VENDOR_MISMATCH', 'CURRENCY_MISMATCH', 'PO_CLOSED', 'PRICE_VARIANCE', 'PO_OVERRUN', 'QTY_EXCEEDS_PO', 'QTY_EXCEEDS_RECEIPT'];
  const poClean = po && !reasons.some((r) => PO_CODES.includes(r.code));

  let headline, sentences, payment = null;
  if (decision === 'APPROVE') {
    const due = ex.due_date || (ex.invoice_date ? addDays(ex.invoice_date, Number(vendor?.payment_terms_days ?? 30)) : null);
    const scheduledFor = !due || (today && due < today) ? (today ?? due) : due; // never schedule a payment in the past
    payment = { amount: ex.total ?? null, currency: cur, scheduledFor };
    headline = `Approve ${amt} to ${vname} for ${invRef}${poNo ? (inferred ? ` (matched to ${poNo})` : ` against ${poNo}`) : ''}.`;
    const variance = reasons.find((r) => r.code === 'VARIANCE_WITHIN_TOLERANCE');
    const receipt = po?.category === 'goods' ? ' and what was received' : '';
    sentences = [
      intro,
      variance ? variance.message : `Prices and quantities match the PO${receipt}, the totals add up, and it is not a duplicate`,
      `Payment of ${amt} is scheduled for ${scheduledFor}${due && scheduledFor !== due ? ` (it was due ${due})` : ''}${inferred ? ', and we drafted a note asking them to quote the PO next time' : ''}`,
    ];
  } else if (has('NOT_AN_INVOICE')) {
    headline = `Reject: this document from ${vname} is not an invoice.`;
    sentences = [blocks.find((r) => r.code === 'NOT_AN_INVOICE').message, 'Nothing will be paid; the AP clerk can file it or return it to the sender'];
  } else {
    const more = pick.length - 1;
    headline = decision === 'REJECT'
      ? `Reject ${vname} ${hRef}: ${SHORT[top] ?? top}.`
      : `Hold for ${route}: ${vname} ${hRef}, ${SHORT[top] ?? top}${more ? ` (+${more} more)` : ''}.`;
    const shown = pick.slice(0, 2).map((r) => r.message);
    const hidden = pick.length - shown.length + (decision === 'REJECT' ? holds.length : 0);
    // On a duplicate, PO quantity/value flags are just the original's consumption showing through; say so.
    const CONSUMED = ['QTY_EXCEEDS_PO', 'QTY_EXCEEDS_RECEIPT', 'PO_OVERRUN'];
    const echo = top === 'DUPLICATE_INVOICE' && holds.length && holds.every((r) => CONSUMED.includes(r.code)) && hidden === holds.length;
    const others = !hidden ? '' : echo
      ? ` The ${hidden} other flag${hidden > 1 ? 's' : ''} (PO quantities and value already used up) follow from the original having been booked.`
      : ` ${hidden} other issue${hidden > 1 ? 's are' : ' is'} listed below.`;
    const last = decision === 'REJECT'
      ? `It will not be paid${top === 'DUPLICATE_INVOICE' ? ' again' : ''}.${others}`
      : `It is on hold with ${route === 'AP clerk' ? 'the AP clerk' : route}, and nothing will be paid until ${UNTIL[top] ?? 'someone resolves this'}.${others}`;
    sentences = [`${intro}${poClean ? ', and the goods and prices match the PO' : ''}`, ...shown, last];
  }
  const explanation = sentences.map(sentence).join(' ');

  const nextActions = decision === 'APPROVE'
    ? [`Pay ${amt} on ${payment.scheduledFor} to the bank account in our vendor master.`,
      ...(inferred && poNo ? [`Send the drafted note asking ${vname} to quote ${poNo} on future invoices.`] : [])]
    : [...new Set(pick.flatMap((r) => actionsFor(r.code, c)))];

  return {
    decision, headline, reasons, explanation, route: decision === 'APPROVE' ? null : route, nextActions, payment,
    vendorEmail: draftEmail({ ex, vendor, po, reasons, decision, inferred, original, amt, vname, invRef }),
  };
}

function draftEmail({ ex, vendor, po, reasons, decision, inferred, original, amt, vname, invRef }) {
  const has = (code) => reasons.some((r) => r.code === code);
  if (has('VENDOR_BLOCKED') || has('NOT_AN_INVOICE')) return null;
  const sign = `\n\nKind regards,\nAccounts Payable\n${po?.buyer_entity || ex.bill_to_name || ''}`.trimEnd();
  const dated = ex.invoice_date ? ` dated ${ex.invoice_date}` : '';
  const poRef = po?.po_number ?? ex.po_number;
  const hello = `Hello ${vname} team,\n\n`;
  const to = vendor?.remit_email || ex.vendor?.email || null; // master contact first; invoice contact only if the vendor is unknown

  if (has('BANK_DETAILS_CHANGED')) {
    if (!vendor?.remit_email) return null; // never write to the invoice's contact about a bank change
    const bd = ex.bank_details ?? {};
    const acct = String(bd.account_number ?? '').replace(/\D/g, '');
    const newBank = bd.bank_name || acct ? ` (${[bd.bank_name, acct ? `account ending ${acct.slice(-4)}` : ''].filter(Boolean).join(', ')})` : '';
    return {
      to: vendor.remit_email,
      subject: `Please confirm: bank details change on ${invRef}`,
      body: `${hello}We received ${invRef}${dated} for ${amt}, which asks us to send payment to new bank details${newBank}. We have not changed anything in our records yet.\n\n`
        + `As a security step, our Treasury team will call you to verify this request at the phone number we have on file${vendor.phone ? ` (${vendor.phone})` : ''}, before any payment is released. `
        + `If you did not ask to change your bank details, please reply to this email right away, as the request may not have come from you.${sign}`,
    };
  }
  if (!to) return null;
  if (has('DUPLICATE_INVOICE')) {
    const orig = original?.invoice_number ?? ex.invoice_number;
    const status = original?.status === 'on_hold' ? 'is with our team for review' : 'is approved and scheduled for payment under your agreed terms';
    return {
      to, subject: `Re: ${invRef} – already received`,
      body: `${hello}Thank you for the reminder about ${invRef} for ${amt}. We already have this invoice on file as ${orig}, and it ${status}.\n\nThere is no need to send it again; we will not pay it twice.${sign}`,
    };
  }
  if (has('MISSING_FIELD')) {
    const missing = [!ex.invoice_number && 'an invoice number', !ex.invoice_date && 'an invoice date', !ex.vendor?.name && 'your company name', ex.total == null && 'the total amount'].filter(Boolean);
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0] ?? 'some required details';
    return {
      to, subject: `Corrected invoice needed${poRef ? ` for ${poRef}` : ''}`,
      body: `${hello}We received your invoice for ${amt}${poRef ? ` referencing ${poRef}` : ''}, but it does not show ${list}. We need ${missing.length > 1 ? 'these' : 'this'} to process the payment.\n\nCould you please send a corrected invoice that includes ${list}? We will process it as soon as it arrives.${sign}`,
    };
  }
  if (has('QTY_EXCEEDS_RECEIPT')) {
    const lines = reasons.filter((r) => r.code === 'QTY_EXCEEDS_RECEIPT').map((r) => `- ${r.message}`).join('\n');
    return {
      to, subject: `${invRef}: quantities billed exceed goods received${poRef ? ` on ${poRef}` : ''}`,
      body: `${hello}Thank you for ${invRef}${dated} for ${amt}. Our receiving records do not yet show all of the goods billed:\n${lines}\n\n`
        + `If these items have shipped, please send the delivery note or tracking details so our receiving team can check. Otherwise, please send a credit note for the difference, or re-bill for the quantities we have received.${sign}`,
    };
  }
  if (has('PO_INFERRED') && decision !== 'REJECT' && poRef) {
    return {
      to, subject: `Please quote ${poRef} on future invoices`,
      body: `${hello}Thank you for ${invRef} for ${amt}. It did not show a purchase order number, so we matched it to ${poRef} ourselves.\n\nTo avoid delays, please quote the PO number on future invoices.${sign}`,
    };
  }
  return null;
}
