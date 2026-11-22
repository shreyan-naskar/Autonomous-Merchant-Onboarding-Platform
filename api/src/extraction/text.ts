import { DOCUMENT_TYPES, type DocumentType } from '@app/shared';

/*
 * OCR / PDF text -> the same payload keys as JSON documents, so both go
 * through the same field rules. The label handling is shaped by real
 * documents: bilingual labels ("नाम / Name" OCRs as junk before "Name"),
 * other people's names ("Father's Name"), OCR noise after a name, and
 * two-column PDF rows where a tab ends the value (see pdf.ts).
 */

/*
 * An ID as a string of position kinds: L letter, D digit, X letter or digit,
 * E 1-9 or a letter, Z the letter Z, 0 a zero (documents sometimes print O).
 */
type Kind = 'L' | 'D' | 'X' | 'E' | 'Z' | '0';

const STRICT: Record<Kind, string> = { L: '[A-Z]', D: '[0-9]', X: '[A-Z0-9]', E: '[1-9A-Z]', Z: 'Z', '0': '[0O]' };
// OCR's letter/digit mix-ups: 5 for S, 1 for I, 0 for O, 8 for B, 2 for Z, 6 for G (and back).
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B' };
const TO_DIGIT: Record<string, string> = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
const LOOSE: Record<Kind, string> = { L: '[A-Z012568]', D: '[0-9ODQILZSGB]', X: '[A-Z0-9]', E: '[1-9A-Z]', Z: '[Z2]', '0': '[0O]' };

interface IdPattern {
  kinds: Kind[];
  strict: RegExp;
  /** Each position also accepts its OCR look-alike and may be followed by one space; the end is checked separately. */
  loose: RegExp;
  /** Extra condition on a tolerant match, where free-form parts could be ordinary words run together. */
  plausible: (value: string) => boolean;
}

function idPattern(shape: string, plausible: (value: string) => boolean = () => true): IdPattern {
  const kinds = [...shape] as Kind[];
  return {
    kinds,
    strict: new RegExp(`\\b${kinds.map((k) => STRICT[k]).join('')}\\b`, 'g'),
    loose: new RegExp(`(?<![A-Z0-9])${kinds.map((k) => LOOSE[k]).join(' ?')}`, 'g'),
    plausible,
  };
}

const PAN_IN_TEXT = idPattern('LLLLLDDDDL');
const GSTIN_IN_TEXT = idPattern('DDLLLLLDDDDLEZX');
// Tolerant matches need a digit in the branch code: "HDFC0 BANK LT" is words, not an IFSC.
const IFSC_IN_TEXT = idPattern('LLLL0XXXXXX', (v) => /[0-9]/.test(v.slice(5)));

/** OCR splits an ID in a few places ("27AAF C54321 M1 Z5"); more spaces is more likely separate words. */
const MAX_ID_SPLITS = 3;
/** Look-alike characters corrected per ID. One is a likely misread; more is likely not this ID at all. */
const MAX_ID_FIXES = 1;

/** The value with look-alikes replaced by what each position requires, and how many were replaced. */
function fixLookAlikes(raw: string, kinds: readonly Kind[]): { value: string; fixes: number } {
  let fixes = 0;
  const value = [...raw]
    .map((c, i) => {
      const k = kinds[i]!;
      const fixed = k === 'L' && /[0-9]/.test(c) ? TO_LETTER[c] : k === 'D' && /[A-Z]/.test(c) ? TO_DIGIT[c] : k === 'Z' && c === '2' ? 'Z' : undefined;
      if (fixed === undefined) return c;
      fixes++;
      return fixed;
    })
    .join('');
  return { value, fixes };
}

/** Upper-cases ASCII letters only, so every index still lines up with the original text. */
const upperAscii = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

/**
 * Every distinct ID in the text. Exact matches when there are any; otherwise
 * the tolerant reading of what OCR produces: an ID split by spaces, with
 * lower-case noise run into its end ("AAFCS4321Mm"), or with one letter/digit
 * look-alike ("C54321" for "CS4321"). Either way the result has the exact
 * shape of the ID. read.ts treats a value not spelled out in the text as a
 * guess and keeps it below the review threshold.
 */
function idMatches(text: string, id: IdPattern): string[] {
  const up = upperAscii(text);
  const strict = [...up.matchAll(id.strict)].map((m) => m[0]);
  if (strict.length > 0) return [...new Set(strict)];
  const out: string[] = [];
  for (const m of up.matchAll(id.loose)) {
    const raw = m[0].replace(/ /g, '');
    if (m[0].length - raw.length > MAX_ID_SPLITS) continue;
    const { value, fixes } = fixLookAlikes(raw, id.kinds);
    if (fixes > MAX_ID_FIXES || !id.plausible(value)) continue;
    // Checked on the original text: a lower-case letter after the ID is noise, an upper-case one or a digit means a longer code.
    if (/[A-Z0-9]/.test(text[m.index + m[0].length] ?? '')) continue;
    out.push(value);
  }
  return [...new Set(out)];
}

const OTHER_NAME = /(?:father'?s?|mother'?s?|spouse'?s?|guardian'?s?|branch|bank|nominee'?s?|trade|business)\s*$/i;

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \u00a0]+/g, ' ').replace(/ *\t */g, '\t').trim())
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

/** The next line is a fallback candidate; when the value itself is unreadable (or redacted) it is usually the next label. */
const LABEL_WORD = /^(?:registration|details|name|number|date|address|trade|type|constitution|certificate|account|branch|ifsc|pan|gstin|customer|father'?s?)$/i;

const firstName = (candidates: string[]) =>
  candidates.map(cleanName).find((n): n is string => n !== null && !LABEL_WORD.test(n.split(' ')[0]!));

function accountNumber(ls: readonly string[]): string | undefined {
  for (const v of labelled(ls, /(?:bank\s+)?(?:account|a\/c)\s*(?:number|no\.?)/)) {
    const digits = v.match(/[0-9][0-9 ]{7,}[0-9]/)?.[0]?.replace(/ /g, '');
    if (digits && digits.length >= 9 && digits.length <= 18) return digits;
  }
  return undefined;
}

/** The 5th character is always zero; a branch code of digits read as "O02117" is digits too. Letter branch codes are kept. */
function fixIfsc(v: string): string {
  const branch = v.slice(5);
  return `${v.slice(0, 4)}0${/^[0-9O]+$/.test(branch) && /[0-9]/.test(branch) ? branch.replace(/O/g, '0') : branch}`;
}

function ifsc(text: string): string | undefined {
  const v = idMatches(text, IFSC_IN_TEXT)[0];
  return v ? fixIfsc(v) : undefined;
}

/**
 * Every distinct value of the fields found by pattern. More than one means the
 * document is ambiguous, e.g. an edited PDF whose old value is still in the
 * text layer under the new one.
 */
export function patternValues(type: DocumentType, text: string): Record<string, string[]> {
  switch (type) {
    case 'PAN_CARD':
      return { pan: idMatches(text, PAN_IN_TEXT) };
    case 'GST_CERT':
      return { gstin: idMatches(text, GSTIN_IN_TEXT) };
    case 'BANK_PROOF':
      return { ifsc: [...new Set(idMatches(text, IFSC_IN_TEXT).map(fixIfsc))] };
  }
}

function clean(obj: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter((e): e is [string, string] => !!e[1]));
}

/** Words that name the kind of document; OCR-tolerant spacing. */
const SIGNATURES: Record<DocumentType, RegExp> = {
  PAN_CARD: /permanent\s*account\s*number|income\s*tax\s*department/i,
  GST_CERT: /goods\s*and\s*services\s*tax|gst\s*reg|registration\s*certificate|\bgstin\b/i,
  BANK_PROOF: /\bifsc\b|cancell?ed\s*cheque|statement\s*of\s*account|account\s*statement|passbook/i,
};

/**
 * The other kind of document this text reads as, when it doesn't read as the
 * expected one: a GST certificate uploaded as the PAN card. Null when the text
 * names the expected kind, names none, or names several.
 */
export function looksLike(expected: DocumentType, text: string): DocumentType | null {
  if (SIGNATURES[expected].test(text)) return null;
  const others = DOCUMENT_TYPES.filter((t) => t !== expected && SIGNATURES[t].test(text));
  return others.length === 1 ? others[0]! : null;
}

export function parseDocumentText(type: DocumentType, text: string): Record<string, string> {
  const ls = lines(text);
  switch (type) {
    case 'PAN_CARD':
      return clean({
        pan: idMatches(text, PAN_IN_TEXT)[0],
        name: firstName(labelled(ls, /name/, OTHER_NAME)),
      });
    case 'GST_CERT':
      return clean({
        gstin: idMatches(text, GSTIN_IN_TEXT)[0],
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
