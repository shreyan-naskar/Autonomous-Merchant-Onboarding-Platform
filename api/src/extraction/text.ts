import type { DocumentType } from '@app/shared';

/*
 * Free text (OCR output, PDF text) -> a structured document payload with the
 * same keys as JSON documents (see DOCUMENT_FIELDS in extract.ts), so text
 * documents go through exactly the same field rules. Pure.
 *
 * Values are found by pattern (PAN, GSTIN, IFSC) or by label ("Name",
 * "Legal Name", "Account Number", ...). A value that cannot be found is
 * left out; extractFields then flags that field as unreadable.
 *
 * Real documents this has to cope with (seen on a real PAN card and a bank
 * statement PDF):
 *  - bilingual labels: "नाम / Name" OCRs as junk before "Name", so a label
 *    may follow junk and a separator, not only start the line;
 *  - several labelled names on one document ("Father's Name", "Branch Name"):
 *    those are excluded;
 *  - names followed by OCR noise ("SHREYAN NASKAR Wid aA"), or prefixed with
 *    a title ("Mr."): only the name words are kept;
 *  - two-column layouts: PDF rows arrive as "label : value<TAB>other column",
 *    so a value ends at a tab (see pdf.ts);
 *  - an IFSC printed with the letter O as its 5th character (always 0).
 */

const PAN_IN_TEXT = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const GSTIN_IN_TEXT = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;
// The 5th character of an IFSC is always zero; documents sometimes print the letter O.
const IFSC_IN_TEXT = /\b[A-Z]{4}[0O][A-Z0-9]{6}\b/;

/** Words before "Name" that make it someone else's name (not the holder's). */
const OTHER_NAME = /(?:father'?s?|mother'?s?|spouse'?s?|guardian'?s?|branch|bank|nominee'?s?|trade|business)\s*$/i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    // Keep tabs: they separate columns in PDF rows.
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/ *\t */g, '\t').trim())
    .filter((l) => l !== '');
}

/** The first cell of a value: drop leading separators, stop at a column break. */
const firstCell = (s: string) => s.replace(/^[\s:.\-|]+/, '').split('\t')[0]!.trim();

/**
 * Candidate values for a label, in order: the rest of the label's line
 * (first cell), then the next line. The label must start the line or follow
 * a separator (space, '/', '|', tab), and must not be preceded by `notAfter`.
 */
function labelled(ls: readonly string[], label: RegExp, notAfter?: RegExp): string[] {
  const re = new RegExp(`(^|[\\s/|])(?:${label.source})(?![A-Za-z])`, 'gi');
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    for (const m of ls[i]!.matchAll(re)) {
      const before = ls[i]!.slice(0, m.index + m[1]!.length);
      if (notAfter?.test(before)) continue;
      const rest = firstCell(ls[i]!.slice(m.index + m[0].length));
      if (rest !== '') out.push(rest);
      if (i + 1 < ls.length) out.push(firstCell(ls[i + 1]!));
      break;
    }
  }
  return out;
}

const TITLE = /^(?:mr|mrs|ms|miss|shri|sri|smt|kumari|dr|m\/s)\.?$/i;
const NAME_TOKEN = /^[A-Za-z][A-Za-z.'-]*$/;
const isCaps = (t: string) => t === t.toUpperCase();

/**
 * Keep only the name words: drop a leading title, then take the leading run
 * of capitalized words. A name printed in capitals (PAN cards) ends at the
 * first word that is not in capitals, which drops trailing OCR noise.
 * Null when the text does not start like a name.
 */
export function cleanName(raw: string): string | null {
  const tokens = raw.split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && TITLE.test(tokens[0]!)) tokens.shift();
  const first = tokens[0];
  if (!first || !NAME_TOKEN.test(first) || first[0] !== first[0]!.toUpperCase()) return null;
  const caps = isCaps(first) && first.replace(/[^A-Za-z]/g, '').length >= 2;
  const words: string[] = [];
  for (const t of tokens) {
    if (t === '&') {
      words.push(t);
      continue;
    }
    if (!NAME_TOKEN.test(t) || t[0] !== t[0]!.toUpperCase()) break;
    if (caps && !isCaps(t)) break;
    words.push(t);
  }
  while (words.at(-1) === '&') words.pop();
  const name = words.join(' ');
  return name.replace(/[^A-Za-z]/g, '').length >= 3 ? name : null;
}

const firstName = (candidates: string[]) => candidates.map(cleanName).find((n): n is string => n !== null);

const firstMatch = (text: string, re: RegExp) => text.toUpperCase().match(re)?.[0];

/** Account numbers: 9-18 digits, possibly written in groups ("5010 0234 5678 91"). */
function accountNumber(ls: readonly string[]): string | undefined {
  for (const v of labelled(ls, /(?:bank\s+)?(?:account|a\/c)\s*(?:number|no\.?)/)) {
    const digits = v.match(/[0-9][0-9 ]{7,}[0-9]/)?.[0]?.replace(/ /g, '');
    if (digits && digits.length >= 9 && digits.length <= 18) return digits;
  }
  return undefined;
}

function ifsc(text: string): string | undefined {
  const v = firstMatch(text, IFSC_IN_TEXT);
  return v ? `${v.slice(0, 4)}0${v.slice(5)}` : undefined;
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
        name: firstName(labelled(ls, /name/, OTHER_NAME)),
      });
    case 'GST_CERT':
      return clean({
        gstin: firstMatch(text, GSTIN_IN_TEXT),
        legal_name: firstName(labelled(ls, /legal\s+name(?:\s+of\s+business)?/)),
      });
    case 'BANK_PROOF':
      return clean({
        account_number: accountNumber(ls),
        ifsc: ifsc(text),
        account_holder: firstName(labelled(ls, /(?:account\s+holder(?:\s+name)?|customer\s+name|name)/, OTHER_NAME)),
      });
  }
}
