/**
 * Pure entity pipeline (T005).
 *
 * Extracted from the web app's detection.worker.ts: text and entities in,
 * entities out. No worker messaging, no providers, no environment access.
 * The worker (and any other host) composes these functions around its own
 * ML provider call.
 *
 * Security pass 2026-09:
 *  - T180: detectWithRegex runs every rule line by line (rules flagged
 *    `multiline` see the whole text), so quadratic patterns cost O(line^2)
 *    instead of O(document^2).
 *  - T181: filterFalsePositives is script-aware (CJK/Thai and PERSON values
 *    of two characters survive) and propagateEntities uses Unicode letter/
 *    digit boundaries, exact offsets on the original text and a common-word
 *    guard for lowercase PERSON matches.
 */

import type { DetectedEntity } from './types.ts';
import type { RegexRule } from './regex/types.ts';
import { ALL_REGEX_RULES } from './regex/index.ts';

// ── detectWithRegex ────────────────────────────────────────

/** One newline-free slice of the input plus its offset in the original text. */
interface TextSegment {
  text: string;
  offset: number;
}

/**
 * Split on '\n' keeping offsets. '\r' stays inside the line (a CRLF line then
 * ends with '\r', exactly as it did when the whole text was matched at once).
 * Empty lines are skipped: no rule can match the empty string.
 */
export function segmentLines(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    if (lineEnd > lineStart) {
      segments.push({ text: text.slice(lineStart, lineEnd), offset: lineStart });
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return segments;
}

// ── Company and street name runs (T246) ───────────────────
//
// The company rules of every pack and the street rules whose street word ends
// the name ("Königstraße 45") take `[\p{L}][\p{L}\s...]+` before it, so the
// match starts at the first letter of the line: "elle a réalisé de nombreuses
// rotations de camions pour le compte de la SCI", "Herr Klaus Müller wohnt in
// der Königstraße 45". A name is a run of capitalised words (or digits), with
// lowercase connectors between them and lowercase parts of a legal form: the
// match is cut to the longest such run before its end, and dropped when the
// cut no longer matches the rule (only "SCI" is left).

const COMPANY_RULE = /^regex:(?!cn:)[a-z]{2}:company$/;
const SUFFIX_STREET_RULES: ReadonlySet<string> = new Set([
  'regex:at:street', 'regex:de:street', 'regex:ch:street-german', 'regex:nl:street', 'regex:no:street', 'regex:se:street',
]);
/** Street rules that start with the street type ("Calle", "Rua", "via", "rue"): no lowercase one-letter type. */
const PREFIX_STREET_RULES: ReadonlySet<string> = new Set([
  'regex:es:street', 'regex:pt:street', 'regex:it:street', 'regex:ch:street-french', 'regex:be:street',
]);

/** Postal code + city rules whose city part is any run of letters ("1996 also succeeds"). */
const POSTAL_CITY_RULE = /^regex:(?!nl:|cn:|jp:|universal:)[a-z]{2}:postal(?:-city)?$/;

/** Lowercase words a company or street name may hold between its capitalised words. */
const NAME_CONNECTORS: ReadonlySet<string> = new Set([
  'de', 'du', 'des', 'la', 'le', 'les', 'et', 'and', 'und', '&', 'y', 'e', 'i', 'van', 'von', 'der', 'den',
  'di', 'da', 'del', 'della', 'dei', 'do', 'dos', 'das', 'of', 'am', 'an', 'im', 'zum', 'zur', 'af', 'av',
  // lowercase parts of legal forms (Polish "sp. z o.o.", "Spółka z ograniczoną odpowiedzialnością")
  'sp.', 'sp', 'z', 'o.o.', 'o.o', 'o.', 'o', 'ograniczoną', 'odpowiedzialnością', 'akcyjna', 'jawna', 'komandytowa',
  'sp.j.', 'sp.k.', 's.c.', 's.r.l.', 's.p.a.', 's.a.s.', 's.n.c.', 'mbh',
  // city names ("Frankfurt am Main", "Saint-Denis-en-Val", "Boulogne-sur-Mer", "Nowy Dwór nad Wisłą")
  'sur', 'sous', 'en', 'bei', 'ob', 'nad', 'pod', 'upon',
]);

/** Legal forms of the company packs, without dots, lowercase. */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  'sarl', 'sas', 'sa', 'eurl', 'sci', 'snc', 'sasu', 'gmbh', 'ag', 'kg', 'ohg', 'gbr', 'ug', 'mbh', 'kgaa', 'ev',
  'ltd', 'plc', 'llp', 'inc', 'llc', 'corp', 'co', 'lp', 'pllc', 'pc', 'ab', 'hb', 'kb', 'as', 'asa', 'ans', 'da',
  'bv', 'nv', 'vof', 'cv', 'sl', 'slu', 'sau', 'sc', 'srl', 'spa', 'sapa', 'lda', 'sgps', 'spj', 'spk', 'sp', 'zoo',
]);

function capitalised(token: string): boolean {
  return /^[«"'(]*[\p{Lu}\p{N}&]/u.test(token);
}

const anchoredPatterns = new WeakMap<RegexRule, RegExp>();
function anchored(rule: RegexRule): RegExp {
  let re = anchoredPatterns.get(rule);
  if (!re) {
    re = new RegExp(`^(?:${rule.pattern.source})$`, rule.pattern.flags.replace('g', ''));
    anchoredPatterns.set(rule, re);
  }
  return re;
}

/**
 * The part of a company or street match that is a name, as [offset into the
 * value, value], or null when nothing name-like is left. Other rules pass
 * through unchanged.
 */
export function nameRunOf(rule: RegexRule, value: string): [number, string] | null {
  if (PREFIX_STREET_RULES.has(rule.detector)) {
    // "c intérêts au taux prévu par l'article L" (es "C/" in French prose), "r. L'ordonnance a été mise
    // à disposition" (pt "R."): a street type of one lowercase letter is prose, not an address.
    return /^[a-z]\.?\s/.test(value) ? null : [0, value];
  }
  const tokens = [...value.matchAll(/\S+/g)].map((m) => ({ text: m[0], at: m.index! }));
  if (POSTAL_CITY_RULE.test(rule.detector)) {
    // The city after the code: capitalised words and connectors, cut at the first other word.
    const first = tokens.findIndex((t) => /\p{L}/u.test(t.text));
    if (first < 0 || !capitalised(tokens[first].text)) return null;
    let last = first;
    while (last + 1 < tokens.length && (capitalised(tokens[last + 1].text) || NAME_CONNECTORS.has(tokens[last + 1].text.toLowerCase()))) last++;
    while (last > first && !capitalised(tokens[last].text)) last--;
    const cut = value.slice(0, tokens[last].at + tokens[last].text.length);
    if (cut === value) return [0, value];
    return anchored(rule).test(cut) ? [0, cut] : null;
  }
  const company = COMPANY_RULE.test(rule.detector);
  if (!company && !SUFFIX_STREET_RULES.has(rule.detector)) return [0, value];
  if (company) {
    // A company is a name and a legal form: "ACAS" is not "AC" + "AS" (Norwegian AS), nor "The ACAS".
    const last = tokens[tokens.length - 1]?.text.replace(/[.,]/g, '') ?? '';
    if (tokens.length < 2) return null;
    if (/^\p{Lu}{2,5}$/u.test(last) && !LEGAL_FORMS.has(last.toLowerCase())) return null;
  }
  // A street's last two words (street word and number: "gate 22", "Königstraße 45") may be lowercase.
  const free = company ? 0 : 2;
  const fits = (from: number): boolean => {
    if (!capitalised(tokens[from].text) && from < tokens.length - free) return false;
    for (let i = from + 1; i < tokens.length - free; i++) {
      const t = tokens[i].text;
      if (!capitalised(t) && !NAME_CONNECTORS.has(t.toLowerCase().replace(/,$/, ''))) return false;
    }
    return true;
  };
  // At most 6 words of a company name, 3 of a street name before its street word and number.
  const longest = company ? 6 : 3;
  for (let from = Math.max(0, tokens.length - free - longest); from < tokens.length; from++) {
    if (!fits(from)) continue;
    if (from === 0) return [0, value];
    if (company && tokens.length - from < 2) return null;
    const at = tokens[from].at;
    const cut = value.slice(at);
    return anchored(rule).test(cut) ? [at, cut] : null;
  }
  return null;
}

function runRule(rule: RegexRule, segment: TextSegment, out: DetectedEntity[], pattern: RegExp = rule.pattern, depth = 0): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(segment.text)) !== null) {
    if (match[0].length === 0) {
      // Defensive: a zero-width match would otherwise loop forever.
      pattern.lastIndex++;
      continue;
    }
    // A class that admits whitespace (IBAN, phone) can end the match on a
    // space before the next word; the replacement would then swallow it.
    let lead = match[0].length - match[0].trimStart().length;
    let value = match[0].trim();
    if (value.length === 0) continue;
    const run = nameRunOf(rule, value);
    // What a cut (or a rejected) match leaves before its name can hold another name: one greedy
    // match took "Dupont et Fils SARL. Le conseil est Capgemini SAS" (T246). Search it again.
    const headEnd = run ? run[0] : value.search(/\S+$/);
    if (headEnd > 0 && depth < 4) {
      const head: TextSegment = { text: value.slice(0, headEnd), offset: segment.offset + match.index + lead };
      runRule(rule, head, out, new RegExp(rule.pattern.source, rule.pattern.flags), depth + 1);
    }
    if (!run) continue;
    lead += run[0];
    value = run[1];
    if (rule.validate && !rule.validate(value)) continue;
    out.push({
      type: rule.type,
      value,
      start: segment.offset + match.index + lead,
      end: segment.offset + match.index + lead + value.length,
      confidence: rule.confidence,
      detector: rule.detector,
    });
  }
}

/**
 * Run the regex rules of a region over the text.
 *
 * Rules without `multiline` run on each line separately (offsets are added
 * back, so spans are document-absolute); rules with `multiline: true` run on
 * the whole text. Output order is rule-major, then position, as before.
 *
 * Complexity note (T180): several street/company rules are quadratic in the
 * length of their input. Per-line matching bounds that to the longest line,
 * so 100 KB of ordinary prose is fast; a single 100 KB line without newlines
 * is still slow until the patterns themselves are bounded (T198).
 */
export function detectWithRegex(text: string, regexRegion: string = 'all'): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const rules = regexRegion === 'all'
    ? ALL_REGEX_RULES
    : ALL_REGEX_RULES.filter((r) => r.region === 'universal' || r.region === regexRegion);
  const whole: TextSegment = { text, offset: 0 };
  const lines = segmentLines(text);
  for (const rule of rules) {
    if (rule.multiline) {
      runRule(rule, whole, entities);
    } else {
      for (const line of lines) runRule(rule, line, entities);
    }
  }
  return entities;
}

// ── resolveOverlaps ────────────────────────────────────────

export function resolveOverlaps(entities: DetectedEntity[]): DetectedEntity[] {
  const sorted = [...entities].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const aLen = a.end - a.start;
    const bLen = b.end - b.start;
    if (aLen !== bLen) return bLen - aLen;
    return b.confidence - a.confidence;
  });

  const resolved: DetectedEntity[] = [];
  const remainders: DetectedEntity[] = [];
  for (const entity of sorted) {
    let coveredTo = -1;
    for (const existing of resolved) {
      if (entity.start < existing.end && entity.end > existing.start) coveredTo = Math.max(coveredTo, existing.end);
    }
    if (coveredTo < 0) {
      resolved.push(entity);
      continue;
    }
    // The entity loses to the spans it overlaps, but what it covers past them may still be a value:
    // keep it (remainderFrom) so it is not left in clear (T233). A PDF exported from a spreadsheet
    // glued a clipped cell to the next one ("31-147 Krakók.wisniewska@firma.pl"): the model took
    // "31-147 Krakók", the e-mail rule the whole token, and dropping the e-mail left
    // ".wisniewska@firma.pl" in the output.
    remainders.push(...remainderFrom(entity, coveredTo));
  }

  // Each remainder is strictly shorter than its entity, so this terminates.
  return remainders.length > 0 ? resolveOverlaps([...resolved, ...remainders]) : resolved;
}

const REMAINDER_LEAD = /^[\s.,;:!?\-–—/()[\]{}"'«»“”‘’„]+/u;
const REMAINDER_TRAIL = /[\s,.;:!?)\]}"'»”’]+$/u;
const HAS_TEXT = /[\p{L}\p{N}]/u;

/**
 * What `entity` covers from `from` on, as entities. A regex match only means something whole
 * ("00 before 2025" is a date because "00" reads as a day), so its rule runs again on the rest and
 * only what it matches there survives ("wisniewska@firma.pl" does, "before 2025" does not). A model
 * span has no rule to re-run: its rest is kept without the punctuation at its edges ("ith" of a
 * "Smith" the winner cut at "Sm").
 */
function remainderFrom(entity: DetectedEntity, from: number): DetectedEntity[] {
  if (from >= entity.end) return [];
  const raw = entity.value.slice(from - entity.start);
  if (entity.detector.startsWith('regex:')) {
    const rule = ALL_REGEX_RULES.find((r) => r.detector === entity.detector);
    if (rule) {
      const out: DetectedEntity[] = [];
      runRule(rule, { text: raw, offset: from }, out);
      // What follows a postal code is its city even when it no longer matches the rule: the model
      // took "Venloer Straße 311\n50823", the postal rule "50823 Köln", and dropping "Köln" left the
      // city in clear (T246). Other rules' leftovers stay dropped ("Warszawa" after an e-mail, T233).
      if (out.length > 0 || !/:postal(?:[-_]city)?$/.test(entity.detector)) return out;
    }
  }
  const lead = REMAINDER_LEAD.exec(raw)?.[0].length ?? 0;
  const trail = REMAINDER_TRAIL.exec(raw.slice(lead))?.[0].length ?? 0;
  const value = raw.slice(lead, raw.length - trail);
  if (!HAS_TEXT.test(value)) return [];
  const start = from + lead;
  return [{ ...entity, value, start, end: start + value.length }];
}

// ── trimSpanPunctuation ────────────────────────────────────

const LEADING_PUNCT = /^[\s(\[{"'«“‘„]+/u;
const TRAILING_PUNCT = /[\s,.;:!?)\]}"'»”’]+$/u;

/**
 * Word-level providers (BardS.ai splits on whitespace) return spans that
 * carry the punctuation glued to the last word: "Anna Nowak," or
 * "jan@example.com.". The redacted text then loses that punctuation and the
 * mapping stores it as part of the value. Trim a fixed set of opening and
 * closing punctuation at both ends of every span (T204); a span that would
 * become empty is dropped. Regex spans are not passed through this: their
 * patterns already stop at the identifier.
 */
export function trimSpanPunctuation(entities: DetectedEntity[]): DetectedEntity[] {
  const out: DetectedEntity[] = [];
  for (const entity of entities) {
    const value = entity.value;
    const lead = LEADING_PUNCT.exec(value)?.[0].length ?? 0;
    const trail = TRAILING_PUNCT.exec(value.slice(lead))?.[0].length ?? 0;
    if (lead === 0 && trail === 0) {
      out.push(entity);
      continue;
    }
    const trimmed = value.slice(lead, value.length - trail);
    if (trimmed.length === 0) continue;
    out.push({ ...entity, value: trimmed, start: entity.start + lead, end: entity.end - trail });
  }
  return out;
}

// ── splitAtLineBreaks ──────────────────────────────────────

const LINE_BREAK = /[\r\n\u000B\u000C\u2028\u2029]/;
const LINE_BREAKS = /[\r\n\u000B\u000C\u2028\u2029]+/g;
const ONLY_SPACES = /^[^\S\r\n\u000B\u000C\u2028\u2029]*$/;

/**
 * A model span never runs across a line break (T260). Word-level providers
 * merge neighbouring words of one type, and the end of one paragraph or
 * table cell gets glued to the start of the next: "Banque Phocéenne de
 * Crédit\n40" (the house number of the address below), "18 000,00\nB" (the
 * first letter of the next cell). One placeholder then swallowed the line
 * break in pasted text, and in a document it stood in the first paragraph
 * while a piece of the second one vanished.
 *
 * Each line's part becomes its own span, so a two-line address is two
 * values that go back where they were. A part too short to be a value on
 * its own (what filterFalsePositives would drop) is not left in clear when
 * it touches another model span on its line: that span grows over it ("40"
 * joins "La Canebière, 13001 Marseille"). Otherwise it is dropped: it was
 * never a value, only the tail of a wrong merge. Regex spans are matched
 * line by line already (segmentLines).
 */
export function splitAtLineBreaks(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  if (!entities.some((e) => LINE_BREAK.test(e.value))) return entities;
  const whole: DetectedEntity[] = [];
  const orphans: DetectedEntity[] = [];
  for (const entity of entities) {
    if (!LINE_BREAK.test(entity.value)) {
      whole.push(entity);
      continue;
    }
    let cursor = 0;
    const parts: Array<[number, number]> = [];
    LINE_BREAKS.lastIndex = 0;
    for (let m = LINE_BREAKS.exec(entity.value); m !== null; m = LINE_BREAKS.exec(entity.value)) {
      parts.push([cursor, m.index]);
      cursor = m.index + m[0].length;
    }
    parts.push([cursor, entity.value.length]);
    for (const [from, to] of parts) {
      const raw = entity.value.slice(from, to);
      const lead = raw.length - raw.trimStart().length;
      const value = raw.trim();
      if (value.length === 0) continue;
      const start = entity.start + from + lead;
      const piece = { ...entity, value, start, end: start + value.length };
      const standsAlone = filterFalsePositives(trimSpanPunctuation([piece])).length > 0;
      (standsAlone ? whole : orphans).push(piece);
    }
  }
  for (const orphan of orphans) {
    // The span right after it or right before it on the same line, with nothing but spaces between.
    const after = whole.findIndex((e) => e.start >= orphan.end && ONLY_SPACES.test(text.slice(orphan.end, e.start)));
    if (after >= 0) {
      const e = whole[after];
      whole[after] = { ...e, start: orphan.start, value: text.slice(orphan.start, e.end) };
      continue;
    }
    const before = whole.findIndex((e) => e.end <= orphan.start && ONLY_SPACES.test(text.slice(e.end, orphan.start)));
    if (before >= 0) {
      const e = whole[before];
      whole[before] = { ...e, end: orphan.end, value: text.slice(e.start, orphan.end) };
    }
  }
  return whole;
}

// ── filterFalsePositives ───────────────────────────────────

/**
 * Scripts whose names are routinely one or two characters long (and whose
 * words are not space-delimited). A value containing any of these keeps the
 * lower two-character threshold for every entity type.
 */
const CJK_THAI = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Two-character PERSON values that are titles, suffixes or abbreviations,
 * never names. Compared against the lowercased trimmed value (T181, R2).
 */
export const PERSON_SHORT_STOPLIST: ReadonlySet<string> = new Set([
  'mr', 'ms', 'dr', 'jr', 'sr', 'st', 'ii', 'iv', 'vi', 'no', 're', 'cc',
  // Name particles a model can return on their own ("DE" of "TRIBUNAL DE
  // COMMERCE", T240): as a whole PERSON value they are never a name, and
  // propagation would replace every occurrence.
  'de', 'du', 'da', 'di', 'des', 'del', 'der', 'den', 'dos', 'das', 'van', 'von',
]);

function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * Drop ML spans that are too short to be real entities (R2):
 *  - values containing CJK or Thai characters: at least 2 code points, any type
 *  - PERSON: at least 2 characters, unless the value is a known 2-letter
 *    title/suffix (PERSON_SHORT_STOPLIST); initials like "J." pass
 *  - every other type: at least 3 characters (unchanged)
 */
export function filterFalsePositives(entities: DetectedEntity[]): DetectedEntity[] {
  return entities.filter((e) => {
    const value = e.value.trim();
    if (value.length === 0) return false;
    if (CJK_THAI.test(value)) return codePointLength(value) >= 2;
    if (e.type === 'PERSON') {
      if (value.length < 2) return false;
      return !PERSON_SHORT_STOPLIST.has(value.toLowerCase());
    }
    return value.length >= 3;
  });
}

// ── propagateEntities ──────────────────────────────────────

/**
 * Words that are also given names or surnames, per language (T181, R15).
 * A PERSON term found in the text with DIFFERENT casing than the detected
 * entity, and NOT starting with an uppercase letter, is skipped when its
 * lowercase form is listed here: "Bill" the person never turns "the bill is
 * due" into "[PERSON_1] is due". Capitalised and ALL-CAPS mentions always
 * propagate, and lowercase mentions of ordinary names ("thanks john") are
 * still caught (golden prop-03-case-insensitive).
 *
 * Only words that appear in lowercase in running prose belong here. German
 * nouns are always capitalised in prose, so the DE list holds adjectives and
 * month names that double as surnames or first names; the PL list holds
 * nouns (animals, months, plants) that are frequent Polish surnames and
 * first names.
 */
export const COMMON_WORD_NAMES: Readonly<Record<'en' | 'pl' | 'de', readonly string[]>> = {
  en: [
    'bill', 'mark', 'will', 'may', 'art', 'grace', 'hope', 'rose', 'jack', 'sue',
    'pat', 'chase', 'dawn', 'june', 'carol', 'guy', 'rich', 'frank', 'ray', 'don',
    'bob', 'jay', 'gene',
  ],
  pl: [
    'lis', 'wilk', 'wrona', 'sowa', 'kruk', 'baran', 'kot', 'mucha', 'kowal', 'sroka',
    'wróbel', 'dudek', 'mróz', 'zając', 'sobota', 'piątek', 'maj', 'marzec', 'kwiecień',
    'lipiec', 'róża', 'jagoda', 'malina', 'kalina', 'cebula',
  ],
  de: [
    'lang', 'klein', 'groß', 'gross', 'weiß', 'weiss', 'schwarz', 'braun', 'roth', 'kurz',
    'jung', 'alt', 'neu', 'ernst', 'reich', 'stark', 'wild', 'frei', 'gut', 'voll',
    'kühn', 'fromm', 'hell', 'klug', 'treu', 'lieb', 'mai',
  ],
};

const COMMON_WORD_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(COMMON_WORD_NAMES).flat(),
);

/** A character that continues a word: a Unicode letter or digit. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Scripts written without spaces between words. A term edge in one of these
 * scripts cannot demand a non-letter neighbour (a Chinese name is normally
 * glued to the next character), mirroring the restore-side rule that CJK
 * keys carry no boundaries.
 */
const UNSPACED_SCRIPT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const pair = Array.from(text.slice(Math.max(0, index - 2), index));
  return pair[pair.length - 1] ?? '';
}

function codePointAt(text: string, index: number): string {
  if (index >= text.length) return '';
  const cp = text.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function startsUppercase(value: string): boolean {
  const first = codePointAt(value, 0);
  return first !== '' && first !== first.toLowerCase();
}

/** French and Italian elisions ("d'", "l'", "qu'") written before a word. */
const ELISION_PREFIXES = ['qu', 'c', 'd', 'j', 'l', 'm', 'n', 's', 't'];

/**
 * An elision glued to a capitalised hit ("dALTAMIR", "lEtat"): OCR often drops the apostrophe of
 * "d'ALTAMIR". The lowercase prefix then counts as the word boundary when it starts a word itself.
 */
function elidedBefore(text: string, idx: number, found: string): boolean {
  if (!startsUppercase(found)) return false;
  return ELISION_PREFIXES.some((p) => idx >= p.length
    && text.slice(idx - p.length, idx) === p
    && !WORD_CHAR.test(codePointBefore(text, idx - p.length)));
}

/**
 * Find every further occurrence of each detected value (and of the words of
 * multi-word values) in the text and emit it as a 'propagated' entity.
 *
 * Terms: whole values of at least 2 characters; words of multi-word values
 * of at least 4 characters (trailing punctuation stripped). Terms of at most
 * 2 characters match with exact case; longer terms match case-insensitively
 * (Unicode case folding via the 'iu' flags) on the ORIGINAL text, so offsets
 * are exact even after characters whose lowercase form has a different
 * length (Turkish dotted İ). A hit needs a non-letter, non-digit neighbour
 * on both sides ([\p{L}\p{N}] complement), except on a side where the term
 * itself ends in an unspaced script (CJK, Thai), and before a capitalised hit
 * glued to an elision whose apostrophe OCR dropped ("dALTAMIR").
 */
export function propagateEntities(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const propagated: DetectedEntity[] = [];
  const seen = new Set<string>();

  for (const e of entities) {
    seen.add(`${e.start}:${e.end}`);
  }

  const terms: { term: string; type: DetectedEntity['type']; exact?: boolean }[] = [];
  const addedTerms = new Set<string>();

  for (const e of entities) {
    const val = e.value.trim();
    if (codePointLength(val) >= 2 && !addedTerms.has(val.toLowerCase())) {
      addedTerms.add(val.toLowerCase());
      terms.push({ term: val, type: e.type });
    }
    // A company is named again without its legal form ("McAllister Landscaping LLC", then "door
    // logo reading 'McAllister Landscaping'").
    if (e.type === 'COMPANY') {
      const name = val.replace(/,?\s+\S+$/, '');
      const form = val.slice(name.length).replace(/[\s,.]/g, '').toLowerCase();
      if (name !== val && LEGAL_FORMS.has(form) && /\s/.test(name) && !addedTerms.has(name.toLowerCase())) {
        addedTerms.add(name.toLowerCase());
        terms.push({ term: name, type: e.type });
      }
    }
    // A person is named again by one word ("Kowalski" after "Jan Kowalski"); the words of a company,
    // an address or a title are ordinary words elsewhere: "travail" of "France Travail" took the
    // "code du travail", "Krakowie" of an address took the court "Sąd Rejonowy ... w Krakowie" (T246).
    // An identifier inside a longer value is a word with digits ("93718264" of "licznik nr
    // 93718264", "2026/2871" of "RG n° 2026/2871"): those spread for every type, exact case.
    if (val.includes(' ')) {
      for (const word of val.split(/\s+/)) {
        const w = word.replace(/[.,;:!?()]+$/, '');
        const identifier = /\d/.test(w) && w.length >= 5;
        if (e.type !== 'PERSON' && !identifier) continue;
        if (w.length >= 4 && !addedTerms.has(w.toLowerCase())) {
          addedTerms.add(w.toLowerCase());
          terms.push({ term: w, type: e.type, exact: e.type !== 'PERSON' });
        }
      }
    }
  }

  for (const { term, type, exact } of terms) {
    const exactCase = codePointLength(term) <= 2 || exact === true;
    const pattern = new RegExp(escapeRegExp(term), exactCase ? 'gu' : 'giu');
    const needsBoundaryBefore = !UNSPACED_SCRIPT.test(codePointAt(term, 0));
    const needsBoundaryAfter = !UNSPACED_SCRIPT.test(codePointBefore(term, term.length));
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const idx = match.index;
      const found = match[0];
      const end = idx + found.length;
      // Same overlap semantics as the original indexOf loop (searchFrom = idx + 1).
      pattern.lastIndex = idx + 1;
      const key = `${idx}:${end}`;
      if (seen.has(key)) continue;
      if (needsBoundaryBefore && WORD_CHAR.test(codePointBefore(text, idx)) && !elidedBefore(text, idx, found)) continue;
      if (needsBoundaryAfter && WORD_CHAR.test(codePointAt(text, end))) continue;
      if (
        type === 'PERSON'
        && found !== term
        && !startsUppercase(found)
        && COMMON_WORD_NAME_SET.has(found.toLowerCase())
      ) {
        continue;
      }
      seen.add(key);
      propagated.push({
        type,
        value: found,
        start: idx,
        end,
        confidence: 0.95,
        detector: 'propagated',
      });
    }
  }

  return propagated;
}

// ── detectEntities ─────────────────────────────────────────

// ── splitCatchAlls ─────────────────────────────────────────

/**
 * Regex rules at or below this confidence are catch-alls (`universal:
 * long_number`): they exist to cover digit runs no specific rule knows.
 */
const CATCH_ALL_CONFIDENCE = 0.5;
/** Detections (ML or regex) a catch-all yields to when they overlap it. */
const SPECIFIC_CONFIDENCE = 0.8;

/**
 * T230: a catch-all regex span yields to the specific detections it
 * overlaps. `long_number` admits whitespace, so a PESEL cell followed by a
 * phone cell ("90050598761 512 987 654") is one 23-character span that
 * resolveOverlaps prefers (same start, longer) over PESEL 0.9 + PHONE 0.8:
 * the row came out as one [SSN] and the phone "was not detected".
 *
 * Every catch-all that overlaps a specific span is replaced by its
 * leftovers: the uncovered slices are re-run through the same rule, so an
 * unknown long number next to a phone is still caught, and the specific
 * spans then win. Catch-alls nothing specific overlaps are untouched, and
 * so is everything else (the leak-averse "earlier start, longer span" order
 * stays for all other overlaps).
 */
export function splitCatchAlls(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const specific = entities.filter((e) => e.confidence >= SPECIFIC_CONFIDENCE);
  if (specific.length === 0) return entities;
  const out: DetectedEntity[] = [];
  for (const entity of entities) {
    const catchAll = entity.detector.startsWith('regex:') && entity.confidence <= CATCH_ALL_CONFIDENCE;
    if (!catchAll) {
      out.push(entity);
      continue;
    }
    const covering = specific
      .filter((s) => s.start < entity.end && s.end > entity.start)
      .sort((a, b) => a.start - b.start);
    if (covering.length === 0) {
      out.push(entity);
      continue;
    }
    const rule = ALL_REGEX_RULES.find((r) => r.detector === entity.detector);
    let cursor = entity.start;
    const gaps: Array<[number, number]> = [];
    for (const s of covering) {
      if (s.start > cursor) gaps.push([cursor, s.start]);
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < entity.end) gaps.push([cursor, entity.end]);
    for (const [start, end] of gaps) {
      if (rule) {
        runRule(rule, { text: text.slice(start, end), offset: start }, out);
      } else {
        const slice = text.slice(start, end);
        const lead = slice.length - slice.trimStart().length;
        const value = slice.trim();
        if (value.length > 0) {
          out.push({ ...entity, value, start: start + lead, end: start + lead + value.length });
        }
      }
    }
  }
  return out;
}

export function detectEntities(
  text: string,
  mlEntities: DetectedEntity[],
  regexEntities: DetectedEntity[],
): DetectedEntity[] {
  if (!text.trim()) return [];

  const mlResults = filterFalsePositives(trimSpanPunctuation(splitAtLineBreaks(text, mlEntities)));
  const regexResults = regexEntities;
  const initial = resolveOverlaps(splitCatchAlls(text, [...mlResults, ...regexResults]));
  const propagated = propagateEntities(text, initial);
  return resolveOverlaps([...initial, ...propagated]);
}
