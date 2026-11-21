import type { DocumentType } from '@app/shared';

/*
 * OCR / PDF text -> the same payload keys as JSON documents, so both go
 * through the same field rules. The label handling is shaped by real
 * documents: bilingual labels ("नाम / Name" OCRs as junk before "Name"),
 * other people's names ("Father's Name"), OCR noise after a name, and
 * two-column PDF rows where a tab ends the value (see pdf.ts).
 */

const PAN_IN_TEXT = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const GSTIN_IN_TEXT = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;
// The 5th character of an IFSC is always zero; documents sometimes print the letter O.
const IFSC_IN_TEXT = /\b[A-Z]{4}[0O][A-Z0-9]{6}\b/;

const OTHER_NAME = /(?:father'?s?|mother'?s?|spouse'?s?|guardian'?s?|branch|bank|nominee'?s?|trade|business)\s*$/i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[  ]+/g, ' ').replace(/ *\t */g, '\t').trim())
    .filter((l) => l !== '');
}

const firstCell = (s: string) => s.replace(/^[\s:.\-|]+/, '').split('\t')[0]!.trim();

/** Candidates for a label's value: the rest of its line, then the next line. */
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

/** A name printed in capitals (PAN cards) ends at the first word that isn't, which drops trailing OCR noise. */
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
