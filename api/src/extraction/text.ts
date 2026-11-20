import type { DocumentType } from '@app/shared';

/*
 * Free text (OCR output, PDF text) -> a structured document payload with the
 * same keys as JSON documents (see DOCUMENT_FIELDS in extract.ts), so text
 * documents go through exactly the same field rules. Pure.
 *
 * Values are found by pattern (PAN, GSTIN, IFSC) or by label ("Name",
 * "Legal Name", "Account Number", ...). A value that cannot be found is
 * left out; extractFields then flags that field as unreadable.
 */

const PAN_IN_TEXT = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const GSTIN_IN_TEXT = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;
const IFSC_IN_TEXT = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
}

/**
 * The value for a label: the rest of the label's line after ':' / '-' (when
 * non-empty), else the next line. The label must start the line.
 */
function labelled(ls: readonly string[], label: RegExp): string | undefined {
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i]!.match(new RegExp(`^(?:${label.source})(?![A-Za-z])\\s*[:.\\-]*\\s*(.*)$`, 'i'));
    if (!m) continue;
    const rest = m[1]!.trim();
    if (rest !== '') return rest;
    if (i + 1 < ls.length) return ls[i + 1];
  }
  return undefined;
}

const firstMatch = (text: string, re: RegExp) => text.toUpperCase().match(re)?.[0];

/** Account numbers: 9-18 digits, possibly written in groups ("5010 0234 5678 91"). */
function accountNumber(ls: readonly string[]): string | undefined {
  const v = labelled(ls, /(?:bank\s+)?(?:account|a\/c)\s*(?:number|no\.?)/);
  if (!v) return undefined;
  const digits = v.match(/[0-9][0-9 ]{7,}[0-9]/)?.[0]?.replace(/ /g, '');
  return digits && digits.length >= 9 && digits.length <= 18 ? digits : undefined;
}

function clean(obj: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter((e): e is [string, string] => !!e[1]));
}

export function parseDocumentText(type: DocumentType, text: string): Record<string, string> {
  const ls = lines(text);
  switch (type) {
    case 'PAN_CARD':
      return clean({
        pan: firstMatch(text, PAN_IN_TEXT),
        // "Name", but not "Father's Name" (that line does not start with Name).
        name: labelled(ls, /name/),
      });
    case 'GST_CERT':
      return clean({
        gstin: firstMatch(text, GSTIN_IN_TEXT),
        legal_name: labelled(ls, /legal\s+name(?:\s+of\s+business)?/),
      });
    case 'BANK_PROOF':
      return clean({
        account_number: accountNumber(ls),
        ifsc: firstMatch(text, IFSC_IN_TEXT),
        account_holder: labelled(ls, /(?:account\s+holder(?:\s+name)?|name)/),
      });
  }
}
