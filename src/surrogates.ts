/**
 * @doccloak/core - realistic, shape-preserving surrogate generator (T043).
 *
 * Generates fake-but-plausible replacements for detected entities instead
 * of bracket placeholders: locale-aware names, dates shifted while keeping
 * their format, IBANs/phones/IDs that keep their shape (checksum-valid
 * where the checksum is cheap to compute).
 *
 * Determinism contract: every surrogate is a pure function of
 * (session salt, entity type, original value, attempt). No Math.random or
 * Date.now is ever consulted at module or generation scope, so the same
 * original always yields the same surrogate within a session and tests are
 * reproducible. The salt itself is created once per session (see
 * generateSessionSalt, called from the AnonymizationSession constructor)
 * and persisted with the map so a deserialized session keeps producing
 * consistent surrogates.
 *
 * Fake-identifier policy: we never deliberately generate a real person's
 * identifier. Generated PESELs encode a 19th-century birth date (a range
 * the registry never issued numbers for) and generated SSN shapes use the
 * 900-999 area (never allocated by the SSA). Random collisions with real
 * identifiers of other kinds are statistically possible but not
 * targetable: nothing about the original value survives into the surrogate
 * beyond its shape.
 */

import type { EntityType } from './types.ts';

// ── Deterministic hashing / PRNG ───────────────────────────

/** 32-bit FNV-1a over a UTF-16 string. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;

function rngFor(salt: string, ...parts: Array<string | number>): Rand {
  return mulberry32(fnv1a(`${salt}\u0000${parts.join('\u0000')}`));
}

function pick<T>(rand: Rand, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

/** Integer in [min, max] inclusive. */
function randInt(rand: Rand, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function randDigit(rand: Rand): string {
  return String(randInt(rand, 0, 9));
}

// ── Session salt ───────────────────────────────────────────

/**
 * One salt per session, created at session construction time (never at
 * module scope). WebCrypto when available; a constructor-time Math.random
 * fallback otherwise (the salt only needs to be unique-ish per session,
 * not cryptographically strong - surrogates are not secrets).
 */
export function generateSessionSalt(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// ── Name pools (EN + PL) ───────────────────────────────────

const EN_FIRST_MALE = [
  'James', 'John', 'Robert', 'Michael', 'William', 'David', 'Richard', 'Joseph',
  'Thomas', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Steven', 'Paul',
  'Andrew', 'Joshua', 'Kevin', 'Brian', 'George', 'Timothy', 'Ronald', 'Edward',
  'Jason', 'Jeffrey', 'Ryan', 'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan',
  'Stephen', 'Larry', 'Justin', 'Scott', 'Brandon', 'Benjamin', 'Samuel', 'Gregory',
] as const;

const EN_FIRST_FEMALE = [
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Elizabeth', 'Barbara', 'Susan', 'Jessica',
  'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley',
  'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol', 'Amanda', 'Dorothy', 'Melissa',
  'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura', 'Cynthia', 'Kathleen', 'Amy',
  'Angela', 'Shirley', 'Anna', 'Ruth', 'Brenda', 'Pamela', 'Emma', 'Nicole',
] as const;

const EN_SURNAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Wilson', 'Anderson', 'Taylor', 'Thomas', 'Moore', 'Jackson', 'Martin', 'Lee',
  'Thompson', 'White', 'Harris', 'Clark', 'Lewis', 'Robinson', 'Walker', 'Young',
  'Allen', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams', 'Nelson',
  'Hill', 'Campbell', 'Mitchell', 'Roberts', 'Carter', 'Phillips', 'Evans', 'Turner',
] as const;

const PL_FIRST_MALE = [
  'Jan', 'Piotr', 'Krzysztof', 'Andrzej', 'Tomasz', 'Paweł', 'Michał', 'Marcin',
  'Marek', 'Grzegorz', 'Jerzy', 'Tadeusz', 'Adam', 'Łukasz', 'Zbigniew', 'Ryszard',
  'Dariusz', 'Henryk', 'Mariusz', 'Kazimierz', 'Wojciech', 'Robert', 'Mateusz', 'Marian',
  'Rafał', 'Jacek', 'Janusz', 'Mirosław', 'Maciej', 'Sławomir', 'Jarosław', 'Kamil',
  'Wiesław', 'Roman', 'Władysław', 'Jakub', 'Artur', 'Zdzisław', 'Edward', 'Dawid',
] as const;

const PL_FIRST_FEMALE = [
  'Anna', 'Maria', 'Katarzyna', 'Małgorzata', 'Agnieszka', 'Barbara', 'Krystyna', 'Ewa',
  'Elżbieta', 'Zofia', 'Janina', 'Teresa', 'Joanna', 'Magdalena', 'Monika', 'Jadwiga',
  'Danuta', 'Irena', 'Halina', 'Helena', 'Beata', 'Aleksandra', 'Marta', 'Dorota',
  'Marianna', 'Grażyna', 'Jolanta', 'Stanisława', 'Iwona', 'Karolina', 'Bożena', 'Urszula',
  'Justyna', 'Renata', 'Alicja', 'Paulina', 'Sylwia', 'Natalia', 'Wanda', 'Agata',
] as const;

/** Masculine base forms; feminizePlSurname derives -ska/-cka/-dzka endings. */
const PL_SURNAMES = [
  'Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamiński', 'Lewandowski', 'Zieliński',
  'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowski', 'Jankowski', 'Mazur', 'Kwiatkowski', 'Krawczyk',
  'Piotrowski', 'Grabowski', 'Nowakowski', 'Pawłowski', 'Michalski', 'Nowicki', 'Adamczyk', 'Dudek',
  'Zając', 'Wieczorek', 'Jabłoński', 'Król', 'Majewski', 'Olszewski', 'Jaworski', 'Wróbel',
  'Malinowski', 'Pawlak', 'Witkowski', 'Walczak', 'Stępień', 'Górski', 'Rutkowski', 'Michalak',
] as const;

function feminizePlSurname(surname: string): string {
  if (surname.endsWith('dzki')) return surname.slice(0, -1) + 'a';
  if (surname.endsWith('cki')) return surname.slice(0, -1) + 'a';
  if (surname.endsWith('ski')) return surname.slice(0, -1) + 'a';
  return surname; // invariant surnames (Nowak, Mazur, ...)
}

// ── Other pools ────────────────────────────────────────────

/** Reserved/example domains only (RFC 2606 / RFC 6761): never routable. */
export const FAKE_EMAIL_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'mail.example',
  'post.example', 'inbox.test', 'mail.test', 'poczta.test',
] as const;

const EN_STREETS = [
  'Maple', 'Oak', 'Cedar', 'Elm', 'Willow', 'Chestnut', 'Birch', 'Highland',
  'Lakeview', 'Hillcrest', 'Riverside', 'Sunset', 'Meadow', 'Orchard', 'Garden', 'Prospect',
] as const;

const PL_STREETS = [
  'Polna', 'Leśna', 'Słoneczna', 'Krótka', 'Szkolna', 'Ogrodowa', 'Lipowa', 'Brzozowa',
  'Kwiatowa', 'Sosnowa', 'Łąkowa', 'Akacjowa', 'Spacerowa', 'Parkowa', 'Zielona', 'Wiosenna',
] as const;

const EN_COMPANIES = [
  'Northbridge Solutions', 'Bluepine Systems', 'Graystone Consulting', 'Silverleaf Media',
  'Ironwood Logistics', 'Brightharbor Labs', 'Stonegate Partners', 'Clearwater Dynamics',
  'Redfern Ventures', 'Copperfield Trading', 'Summitline Software', 'Harborview Analytics',
  'Oakfield Services', 'Westgate Supplies', 'Pinecrest Manufacturing', 'Lakeshore Digital',
] as const;

const PL_COMPANIES = [
  'Polbud', 'Stalmex', 'Drewpol', 'Budomax', 'Agropol', 'Techmet', 'Instalex', 'Metalpol',
  'Transwex', 'Elektrobud', 'Chemipol', 'Dombex', 'Hydromax', 'Termopol', 'Mebloplast', 'Kablomex',
] as const;

const COMPANY_SUFFIXES = [
  'Sp. z o.o.', 'sp. z o.o.', 'S.A.', 'sp.j.', 'sp. j.', 'GmbH', 'AG',
  'Ltd.', 'Ltd', 'LLC', 'Inc.', 'Inc', 'B.V.', 'S.à r.l.', 'AB', 'Oy',
] as const;

// ── Locale / shape helpers ─────────────────────────────────

type Locale = 'en' | 'pl';

const PL_CHARS_RE = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

function foldDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
}

const PL_FIRST_FOLDED = new Set(
  [...PL_FIRST_MALE, ...PL_FIRST_FEMALE].map((n) => foldDiacritics(n).toLowerCase()),
);
const EN_FEMALE_LOWER = new Set(EN_FIRST_FEMALE.map((n) => n.toLowerCase()));
const EN_MALE_LOWER = new Set(EN_FIRST_MALE.map((n) => n.toLowerCase()));
const PL_FEMALE_FOLDED = new Set(PL_FIRST_FEMALE.map((n) => foldDiacritics(n).toLowerCase()));
const PL_MALE_FOLDED = new Set(PL_FIRST_MALE.map((n) => foldDiacritics(n).toLowerCase()));

function detectPersonLocale(value: string): Locale {
  if (PL_CHARS_RE.test(value)) return 'pl';
  const tokens = value.toLowerCase().split(/[\s-]+/);
  for (const t of tokens) {
    const folded = foldDiacritics(t);
    if (PL_FIRST_FOLDED.has(folded)) return 'pl';
    if (/(?:ski|ska|cki|cka|dzki|dzka|wicz|czyk|szek|owski|ewski)$/.test(folded)) return 'pl';
  }
  return 'en';
}

type CapsPattern = 'upper' | 'lower' | 'title';

function capsPatternOf(token: string): CapsPattern {
  if (/\p{L}/u.test(token)) {
    if (token === token.toUpperCase() && token !== token.toLowerCase()) return 'upper';
    if (token === token.toLowerCase()) return 'lower';
  }
  return 'title';
}

function applyCaps(word: string, pattern: CapsPattern): string {
  if (pattern === 'upper') return word.toUpperCase();
  if (pattern === 'lower') return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Same-shape substitution: digits become other digits, ASCII letters
 * become other letters of the same case; everything else (separators,
 * diacritics, symbols) is kept verbatim. The generic fallback.
 */
function sameShape(value: string, rand: Rand): string {
  let out = '';
  for (const ch of value) {
    if (ch >= '0' && ch <= '9') out += randDigit(rand);
    else if (ch >= 'a' && ch <= 'z') out += String.fromCharCode(97 + randInt(rand, 0, 25));
    else if (ch >= 'A' && ch <= 'Z') out += String.fromCharCode(65 + randInt(rand, 0, 25));
    else out += ch;
  }
  return out;
}

/** Digits-only substitution: keeps every non-digit (incl. letters) as-is. */
function sameShapeDigits(value: string, rand: Rand): string {
  return value.replace(/\d/g, () => randDigit(rand));
}

// ── PERSON ─────────────────────────────────────────────────

type Gender = 'f' | 'm';

function detectGender(value: string, locale: Locale, rand: Rand): Gender {
  const tokens = value.split(/\s+/);
  const first = foldDiacritics(tokens[0] ?? '').toLowerCase();
  if (locale === 'pl') {
    if (PL_FEMALE_FOLDED.has(first)) return 'f';
    if (PL_MALE_FOLDED.has(first)) return 'm';
    const last = foldDiacritics(tokens[tokens.length - 1] ?? '').toLowerCase();
    if (/(?:ska|cka|dzka)$/.test(last)) return 'f';
    if (/(?:ski|cki|dzki)$/.test(last)) return 'm';
    // Polish female given names end in -a almost without exception.
    if (first.endsWith('a')) return 'f';
    if (first.length > 1) return 'm';
  } else {
    if (EN_FEMALE_LOWER.has(first)) return 'f';
    if (EN_MALE_LOWER.has(first)) return 'm';
  }
  return rand() < 0.5 ? 'f' : 'm';
}

function surnameFor(locale: Locale, gender: Gender, rand: Rand): string {
  if (locale === 'pl') {
    const base = pick(rand, PL_SURNAMES);
    return gender === 'f' ? feminizePlSurname(base) : base;
  }
  return pick(rand, EN_SURNAMES);
}

function firstNameFor(locale: Locale, gender: Gender, rand: Rand): string {
  const pool =
    locale === 'pl'
      ? gender === 'f' ? PL_FIRST_FEMALE : PL_FIRST_MALE
      : gender === 'f' ? EN_FIRST_FEMALE : EN_FIRST_MALE;
  return pick(rand, pool);
}

/**
 * Token count and per-token capitalization are preserved: a two-token
 * name maps to first + surname, extra middle tokens become extra given
 * names, a hyphenated final token becomes a hyphenated double surname.
 */
function generatePerson(original: string, rand: Rand): string {
  const tokens = original.trim().split(/\s+/);
  if (tokens.length === 0 || original.trim() === '') return sameShape(original, rand);
  const locale = detectPersonLocale(original);
  const gender = detectGender(original, locale, rand);

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const caps = capsPatternOf(tokens[i]);
    const isLast = i === tokens.length - 1;
    let word: string;
    if (tokens.length === 1 || !isLast) {
      word = firstNameFor(locale, gender, rand);
    } else if (tokens[i].includes('-')) {
      const parts = tokens[i].split('-');
      word = parts.map(() => surnameFor(locale, gender, rand)).join('-');
    } else {
      word = surnameFor(locale, gender, rand);
    }
    out.push(caps === 'title' ? word : applyCaps(word, caps));
  }
  return out.join(' ');
}

// ── EMAIL ──────────────────────────────────────────────────

export interface SurrogateContext {
  /** Per-session salt; the sole source of randomness. */
  salt: string;
  /**
   * Already-issued session mappings, used to derive an email local part
   * from the surrogate of the matching PERSON (jan.kowalski maps to
   * adam.nowak style). Optional; without it emails get an unrelated
   * deterministic fake identity.
   */
  entries?: ReadonlyArray<{ original: string; replacement: string; entityType: EntityType }>;
}

/** A replacement usable as a name source: not a bracket/legacy token. */
function isNameLike(replacement: string): boolean {
  return !/[[\]<>]/.test(replacement) && /\p{L}/u.test(replacement);
}

function findMatchingPerson(
  local: string,
  entries: SurrogateContext['entries'],
): { original: string; replacement: string } | null {
  if (!entries) return null;
  const haystack = foldDiacritics(local).toLowerCase();
  for (const e of entries) {
    if (e.entityType !== 'PERSON' || !isNameLike(e.replacement)) continue;
    const tokens = foldDiacritics(e.original).toLowerCase().split(/[\s-]+/);
    if (tokens.some((t) => t.length >= 3 && haystack.includes(t))) {
      return { original: e.original, replacement: e.replacement };
    }
  }
  return null;
}

function generateEmail(original: string, ctx: SurrogateContext, rand: Rand): string {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(original);
  if (!m) return sameShape(original, rand);
  const [, local] = m;

  const digitsMatch = /^(.*?)(\d+)$/.exec(local);
  const localBase = digitsMatch ? digitsMatch[1] : local;
  const digitCount = digitsMatch ? digitsMatch[2].length : 0;

  const sep = ['.', '_', '-'].find((s) => localBase.includes(s)) ?? '';

  const person = findMatchingPerson(localBase, ctx.entries);
  let nameTokens: string[];
  if (person) {
    nameTokens = foldDiacritics(person.replacement).toLowerCase().split(/[\s-]+/);
  } else {
    // No in-session person to mirror: deterministic unrelated identity.
    nameTokens = [
      foldDiacritics(firstNameFor('en', rand() < 0.5 ? 'f' : 'm', rand)).toLowerCase(),
      foldDiacritics(pick(rand, EN_SURNAMES)).toLowerCase(),
    ];
  }

  let newLocal: string;
  const origTokens = sep ? localBase.split(sep) : [localBase];
  if (sep && origTokens.length === nameTokens.length) {
    // Mirror the original pattern token by token; single-letter tokens
    // stay initials (j.kowalski maps to a.nowak).
    newLocal = origTokens
      .map((t, i) => (t.length === 1 ? nameTokens[i].charAt(0) : nameTokens[i]))
      .join(sep);
  } else {
    newLocal = nameTokens.join(sep || '.');
  }
  if (digitCount > 0) {
    let digits = '';
    for (let i = 0; i < digitCount; i++) digits += randDigit(rand);
    newLocal += digits;
  }

  const domain = pick(rand, FAKE_EMAIL_DOMAINS);
  return `${newLocal}@${domain}`;
}

// ── DATE ───────────────────────────────────────────────────

const EN_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;
const EN_MONTHS_ABBR = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const;
const PL_MONTHS_GEN = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
] as const;
const PL_MONTHS_NOM = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
] as const;
const MONTH_LISTS: ReadonlyArray<readonly string[]> = [
  EN_MONTHS, EN_MONTHS_ABBR, PL_MONTHS_GEN, PL_MONTHS_NOM,
];

function lookupMonth(token: string): { month: number; list: readonly string[] } | null {
  const lower = token.toLowerCase();
  for (const list of MONTH_LISTS) {
    const i = list.indexOf(lower);
    if (i !== -1) return { month: i + 1, list };
  }
  return null;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

interface ParsedDate {
  y: number;
  m: number;
  d: number;
  rebuild: (y: number, m: number, d: number) => string;
}

function parseDate(value: string): ParsedDate | null {
  let m = /^(\d{4})([./-])(\d{1,2})\2(\d{1,2})$/.exec(value);
  if (m) {
    const [, ys, sep, ms, ds] = m;
    return {
      y: +ys, m: +ms, d: +ds,
      rebuild: (y, mo, d) => `${y}${sep}${pad(mo, ms.length)}${sep}${pad(d, ds.length)}`,
    };
  }
  // Day-first (European) reading for D.M.YYYY / D/M/YYYY / D-M-YYYY.
  m = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})$/.exec(value);
  if (m) {
    const [, ds, sep, ms, ys] = m;
    if (+ms >= 1 && +ms <= 12) {
      return {
        y: +ys, m: +ms, d: +ds,
        rebuild: (y, mo, d) => `${pad(d, ds.length)}${sep}${pad(mo, ms.length)}${sep}${y}`,
      };
    }
    return null;
  }
  // "15 March 2024" / "15 marca 2024"
  m = /^(\d{1,2})(\s+)(\p{L}+)(\s+)(\d{4})$/u.exec(value);
  if (m) {
    const [, ds, ws1, monthToken, ws2, ys] = m;
    const month = lookupMonth(monthToken);
    if (!month) return null;
    const caps = capsPatternOf(monthToken);
    return {
      y: +ys, m: month.month, d: +ds,
      rebuild: (y, mo, d) =>
        `${pad(d, ds.length)}${ws1}${applyCaps(month.list[mo - 1], caps)}${ws2}${y}`,
    };
  }
  // "March 15, 2024" / "March 15 2024"
  m = /^(\p{L}+)(\s+)(\d{1,2})(,?)(\s+)(\d{4})$/u.exec(value);
  if (m) {
    const [, monthToken, ws1, ds, comma, ws2, ys] = m;
    const month = lookupMonth(monthToken);
    if (!month) return null;
    const caps = capsPatternOf(monthToken);
    return {
      y: +ys, m: month.month, d: +ds,
      rebuild: (y, mo, d) =>
        `${applyCaps(month.list[mo - 1], caps)}${ws1}${pad(d, ds.length)}${comma}${ws2}${y}`,
    };
  }
  return null;
}

/**
 * Per-session day offset in [-30, -1] or [1, 30]: derived from the salt
 * only, so every date in a session shifts by the same amount and relative
 * spacing between dates is preserved. Never 0 (a zero shift would leak the
 * original date unchanged).
 */
export function sessionDayOffset(salt: string): number {
  const n = randInt(rngFor(salt, 'DATE_OFFSET'), 1, 60);
  return n <= 30 ? n : 30 - n;
}

function generateDate(original: string, ctx: SurrogateContext, rand: Rand, attempt: number): string {
  const parsed = parseDate(original.trim());
  if (parsed) {
    const { y, m, d } = parsed;
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const ts = Date.UTC(y, m - 1, d);
      const check = new Date(ts);
      if (
        check.getUTCFullYear() === y &&
        check.getUTCMonth() === m - 1 &&
        check.getUTCDate() === d
      ) {
        const offset = sessionDayOffset(ctx.salt) + attempt;
        const shifted = new Date(ts + offset * 86400000);
        return parsed.rebuild(
          shifted.getUTCFullYear(),
          shifted.getUTCMonth() + 1,
          shifted.getUTCDate(),
        );
      }
    }
  }
  // Unparseable shapes keep their exact layout with substituted digits.
  return sameShapeDigits(original, rand);
}

// ── PHONE ──────────────────────────────────────────────────

/**
 * Formatting (spaces, dashes, parentheses) is kept verbatim; the
 * international prefix (+CC, 00CC, or a leading trunk 0) keeps its
 * digits and every subscriber digit is substituted.
 */
function generatePhone(original: string, rand: Rand): string {
  const trimmed = original.trim();
  let preserved: number;
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) preserved = Math.min(2, Math.max(0, digitsOnly.length - 4));
  else if (digitsOnly.startsWith('00')) preserved = Math.min(4, Math.max(0, digitsOnly.length - 4));
  else if (digitsOnly.startsWith('0')) preserved = 1;
  else preserved = 0;

  let seen = 0;
  return original.replace(/\d/g, (d) => {
    seen++;
    return seen <= preserved ? d : randDigit(rand);
  });
}

// ── IBAN ───────────────────────────────────────────────────

/** BBAN+check+country lengths for common IBAN countries. */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AT: 20, BE: 16, BG: 22, CH: 21, CZ: 24, DE: 22, DK: 18, EE: 20, ES: 24,
  FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IT: 27, LT: 20,
  LU: 20, LV: 21, NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19,
  SK: 24,
};

/** mod 97 over the alphanumeric IBAN expansion (A=10 .. Z=35). */
function ibanMod97(s: string): number {
  let rem = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem;
}

function generateIban(original: string, rand: Rand): string {
  const compact = original.replace(/\s/g, '').toUpperCase();
  const m = /^([A-Z]{2})\d{2}[A-Z0-9]+$/.exec(compact);
  if (!m) return sameShape(original, rand);
  const country = m[1];
  const length = IBAN_LENGTHS[country] ?? compact.length;
  const bbanLength = length - 4;

  // Mirror the original's letter/digit pattern positionally when lengths
  // match (keeps e.g. GB bank-code letters); otherwise all digits.
  let bban = '';
  for (let i = 0; i < bbanLength; i++) {
    const origCh = compact.length === length ? compact[4 + i] : '0';
    bban += origCh >= 'A' && origCh <= 'Z'
      ? String.fromCharCode(65 + randInt(rand, 0, 25))
      : randDigit(rand);
  }
  const check = String(98 - ibanMod97(`${bban}${country}00`)).padStart(2, '0');
  const generated = `${country}${check}${bban}`;

  // Reapply the original's grouping when the alnum counts line up.
  const origAlnum = original.replace(/\s/g, '').length;
  if (origAlnum === generated.length) {
    let i = 0;
    return original.replace(/[^\s]/g, () => generated[i++]);
  }
  return /\s/.test(original)
    ? generated.replace(/(.{4})(?=.)/g, '$1 ')
    : generated;
}

// ── National IDs (SSN entity type: PESEL, US SSN, ...) ─────

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3] as const;

function peselChecksum(digits10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(digits10[i]) * PESEL_WEIGHTS[i];
  return (10 - (sum % 10)) % 10;
}

/**
 * Checksum-valid PESEL with a deliberate implausibility marker: the
 * encoded birth date lies in 1800-1899 (PESEL month field 81-92). The
 * registry has never issued numbers for people born in the 19th century,
 * so a generated value can never be a real living person's PESEL. We never
 * deliberately generate a real identifier; random collisions with other
 * identifier kinds are statistically possible but not targetable.
 */
function generatePesel(rand: Rand): string {
  const yy = pad(randInt(rand, 0, 99), 2);
  const mm = pad(80 + randInt(rand, 1, 12), 2); // 1800s century encoding
  const dd = pad(randInt(rand, 1, 28), 2);
  let serial = '';
  for (let i = 0; i < 4; i++) serial += randDigit(rand);
  const body = `${yy}${mm}${dd}${serial}`;
  return `${body}${peselChecksum(body)}`;
}

function generateNationalId(original: string, rand: Rand): string {
  const digits = original.replace(/\D/g, '');
  if (digits.length === 11 && /^\d{11}$/.test(original.trim())) {
    return generatePesel(rand);
  }
  if (digits.length === 9) {
    // US SSN shape: force a 900-999 area, which the SSA never allocates.
    let seen = 0;
    return original.replace(/\d/g, () => {
      seen++;
      return seen === 1 ? '9' : randDigit(rand);
    });
  }
  return sameShapeDigits(original, rand);
}

// ── CREDIT_CARD ────────────────────────────────────────────

function luhnCheckDigit(payload: string): number {
  let sum = 0;
  let double = true; // start doubling from the rightmost payload digit
  for (let i = payload.length - 1; i >= 0; i--) {
    let d = Number(payload[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

function generateCreditCard(original: string, rand: Rand): string {
  const digitCount = (original.match(/\d/g) ?? []).length;
  if (digitCount < 2) return sameShapeDigits(original, rand);
  let payload = '';
  for (let i = 0; i < digitCount - 1; i++) payload += randDigit(rand);
  const full = payload + String(luhnCheckDigit(payload));
  let i = 0;
  return original.replace(/\d/g, () => full[i++]);
}

// ── IP_ADDRESS ─────────────────────────────────────────────

function generateIp(original: string, rand: Rand): string {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(original.trim());
  if (m) {
    return [0, 0, 0, 0].map(() => randInt(rand, 1, 254)).join('.');
  }
  // IPv6 and anything else: substitute hex digits, keep structure.
  return original.replace(/[0-9a-fA-F]/g, (ch) => {
    const v = randInt(rand, 0, 15).toString(16);
    return ch === ch.toUpperCase() && /[a-f]/i.test(ch) ? v.toUpperCase() : v;
  });
}

// ── ADDRESS / COMPANY (pool-based, kept simple) ────────────

function generateAddress(original: string, rand: Rand): string {
  const isPl = PL_CHARS_RE.test(original) || /\b(?:ul|al|os|pl)\.\s/i.test(original);
  const n = randInt(rand, 1, 120);
  if (isPl) return `ul. ${pick(rand, PL_STREETS)} ${n}`;
  return `${n} ${pick(rand, EN_STREETS)} Street`;
}

function generateCompany(original: string, rand: Rand): string {
  const suffix = COMPANY_SUFFIXES.find((s) => original.trim().endsWith(s));
  const isPl =
    PL_CHARS_RE.test(original) ||
    (suffix !== undefined && /z o\.o\.|S\.A\.|sp\. ?j\./i.test(suffix));
  const base = isPl ? pick(rand, PL_COMPANIES) : pick(rand, EN_COMPANIES);
  return suffix ? `${base} ${suffix}` : base;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Generate a surrogate for one entity. Pure and deterministic in
 * (ctx.salt, type, original, attempt); bump `attempt` to re-derive after
 * a collision.
 */
export function generateSurrogate(
  original: string,
  type: EntityType,
  ctx: SurrogateContext,
  attempt = 0,
): string {
  const rand = rngFor(ctx.salt, type, original, attempt);
  switch (type) {
    case 'PERSON': return generatePerson(original, rand);
    case 'EMAIL': return generateEmail(original, ctx, rand);
    case 'DATE': return generateDate(original, ctx, rand, attempt);
    case 'PHONE': return generatePhone(original, rand);
    case 'IBAN': return generateIban(original, rand);
    case 'SSN': return generateNationalId(original, rand);
    case 'CREDIT_CARD': return generateCreditCard(original, rand);
    case 'IP_ADDRESS': return generateIp(original, rand);
    case 'ADDRESS': return generateAddress(original, rand);
    case 'COMPANY': return generateCompany(original, rand);
    case 'CURRENCY': return sameShapeDigits(original, rand);
    default: return sameShape(original, rand);
  }
}

/**
 * Collision-safe wrapper: re-derives with a bumped attempt while the
 * candidate equals the original or `isTaken` reports a clash (another
 * original value or an already-issued replacement); after bounded retries
 * it appends digits until unique. Termination is guaranteed because the
 * taken set is finite.
 */
export function generateUniqueSurrogate(
  original: string,
  type: EntityType,
  ctx: SurrogateContext,
  isTaken: (candidate: string) => boolean,
): string {
  const MAX_ATTEMPTS = 8;
  let candidate = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    candidate = generateSurrogate(original, type, ctx, attempt);
    if (candidate !== original && !isTaken(candidate)) return candidate;
  }
  for (let n = 2; ; n++) {
    const suffixed = `${candidate}${n}`;
    if (suffixed !== original && !isTaken(suffixed)) return suffixed;
  }
}
