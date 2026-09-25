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

function runRule(rule: RegexRule, segment: TextSegment, out: DetectedEntity[]): void {
  rule.pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = rule.pattern.exec(segment.text)) !== null) {
    if (match[0].length === 0) {
      // Defensive: a zero-width match would otherwise loop forever.
      rule.pattern.lastIndex++;
      continue;
    }
    // A class that admits whitespace (IBAN, phone) can end the match on a
    // space before the next word; the replacement would then swallow it.
    const lead = match[0].length - match[0].trimStart().length;
    const value = match[0].trim();
    if (value.length === 0) continue;
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
  for (const entity of sorted) {
    const overlaps = resolved.some(
      (existing) => entity.start < existing.end && entity.end > existing.start
    );
    if (!overlaps) {
      resolved.push(entity);
    }
  }

  return resolved;
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
 * itself ends in an unspaced script (CJK, Thai).
 */
export function propagateEntities(text: string, entities: DetectedEntity[]): DetectedEntity[] {
  const propagated: DetectedEntity[] = [];
  const seen = new Set<string>();

  for (const e of entities) {
    seen.add(`${e.start}:${e.end}`);
  }

  const terms: { term: string; type: DetectedEntity['type'] }[] = [];
  const addedTerms = new Set<string>();

  for (const e of entities) {
    const val = e.value.trim();
    if (codePointLength(val) >= 2 && !addedTerms.has(val.toLowerCase())) {
      addedTerms.add(val.toLowerCase());
      terms.push({ term: val, type: e.type });
    }
    if (val.includes(' ')) {
      for (const word of val.split(/\s+/)) {
        const w = word.replace(/[.,;:!?()]+$/, '');
        if (w.length >= 4 && !addedTerms.has(w.toLowerCase())) {
          addedTerms.add(w.toLowerCase());
          terms.push({ term: w, type: e.type });
        }
      }
    }
  }

  for (const { term, type } of terms) {
    const exactCase = codePointLength(term) <= 2;
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
      if (needsBoundaryBefore && WORD_CHAR.test(codePointBefore(text, idx))) continue;
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

  const mlResults = filterFalsePositives(trimSpanPunctuation(mlEntities));
  const regexResults = regexEntities;
  const initial = resolveOverlaps(splitCatchAlls(text, [...mlResults, ...regexResults]));
  const propagated = propagateEntities(text, initial);
  return resolveOverlaps([...initial, ...propagated]);
}
