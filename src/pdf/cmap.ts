/**
 * @doccloak/core/pdf - CMap parser, decoder and ToUnicode serializer (T208).
 *
 * Handles the CMap syntax of ISO 32000-1 section 9.7.5 (embedded CMap
 * streams) and 9.10.3 (ToUnicode CMaps): codespace ranges, cidrange /
 * cidchar, bfchar / bfrange (both the incrementing and the array form,
 * multi-code-unit UTF-16BE destinations with surrogates), /WMode, /CMapName.
 * `usecmap` and predefined CMaps other than Identity-H/V are refused: the
 * caller reports the font as unredactable rather than guessing.
 *
 * The parser is strict: malformed input throws CMapParseError, it never
 * returns a partial map silently. A missing codespace section is the one
 * tolerated defect (common in real ToUnicode CMaps): the ranges are then
 * derived from the byte lengths of the codes seen.
 */

import { latin1, parsePdfNumber } from './lexer.ts';

export interface CodespaceRange {
  /** Code length in bytes (1..4). */
  numBytes: number;
  /** Inclusive bounds as big-endian integers of `numBytes` bytes. */
  low: number;
  high: number;
}

export interface CMap {
  codespace: CodespaceRange[];
  /** code -> CID for CID CMaps. null means identity (Identity-H/V or a CMap without cid entries). */
  cidMap: Map<number, number> | null;
  /** code -> unicode string for ToUnicode CMaps. null when the CMap has no bf entries. */
  unicodeMap: Map<number, string> | null;
  /** True for vertical writing mode (/WMode 1, Identity-V). */
  vertical: boolean;
  /** /CMapName when present. */
  name?: string;
  /** Code lengths (in bytes, 1..4) seen in codespace ranges and mapping entries. */
  codeLengths: Set<number>;
}

export class CMapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CMapParseError';
  }
}

/** Largest number of entries one range (cidrange / bfrange) may expand to. Guards against memory bombs. */
export const MAX_RANGE_ENTRIES = 65536;

/** Upper bound for the total number of mapped codes; a 4-byte codespace could otherwise be enumerated by many ranges. */
const MAX_TOTAL_ENTRIES = 1 << 20;

/* ---------- tokenizer ---------- */

type Token =
  | { type: 'number'; value: number }
  | { type: 'name'; value: string }
  | { type: 'string'; bytes: Uint8Array }
  | { type: 'arrayOpen' }
  | { type: 'arrayClose' }
  | { type: 'dictOpen' }
  | { type: 'dictClose' }
  | { type: 'keyword'; value: string }
  | { type: 'eof' };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWhitespace(b: number): boolean {
  return WHITESPACE.has(b);
}
function isRegular(b: number): boolean {
  return !WHITESPACE.has(b) && !DELIMITERS.has(b);
}
function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

class Tokenizer {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  next(): Token {
    const b = this.bytes;
    // whitespace and comments
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWhitespace(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
    if (this.pos >= b.length) return { type: 'eof' };
    const start = this.pos;
    const c = b[this.pos];

    if (c === 0x5b) { this.pos++; return { type: 'arrayOpen' }; }
    if (c === 0x5d) { this.pos++; return { type: 'arrayClose' }; }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { this.pos += 2; return { type: 'dictOpen' }; }
      return this.hexString();
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) { this.pos += 2; return { type: 'dictClose' }; }
      throw new CMapParseError(`stray '>' at offset ${this.pos}`);
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x29) throw new CMapParseError(`stray ')' at offset ${this.pos}`);
    if (c === 0x2f) return this.name();
    if (c === 0x7b || c === 0x7d) { this.pos++; return { type: 'keyword', value: String.fromCharCode(c) }; }

    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    const word = latin1(b.subarray(start, this.pos));
    if (word.length === 0) throw new CMapParseError(`unexpected byte 0x${c.toString(16)} at offset ${start}`);
    const first = word.charCodeAt(0);
    if ((first >= 0x30 && first <= 0x39) || first === 0x2b || first === 0x2d || first === 0x2e) {
      const value = parsePdfNumber(word);
      if (value !== null) return { type: 'number', value };
    }
    return { type: 'keyword', value: word };
  }

  private name(): Token {
    const b = this.bytes;
    this.pos++; // '/'
    let out = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length) {
        const h1 = hexDigit(b[this.pos + 1]);
        const h2 = hexDigit(b[this.pos + 2]);
        if (h1 >= 0 && h2 >= 0) {
          out += String.fromCharCode((h1 << 4) | h2);
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return { type: 'name', value: out };
  }

  private hexString(): Token {
    const b = this.bytes;
    const start = this.pos;
    this.pos++; // '<'
    const digits: number[] = [];
    for (;;) {
      if (this.pos >= b.length) throw new CMapParseError(`unterminated hex string at offset ${start}`);
      const c = b[this.pos];
      if (c === 0x3e) break;
      const d = hexDigit(c);
      if (d >= 0) digits.push(d);
      else if (!isWhitespace(c)) throw new CMapParseError(`invalid hex digit 0x${c.toString(16)} at offset ${this.pos}`);
      this.pos++;
    }
    this.pos++; // '>'
    if (digits.length % 2 === 1) digits.push(0);
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return { type: 'string', bytes };
  }

  private literalString(): Token {
    const b = this.bytes;
    const start = this.pos;
    this.pos++; // '('
    let depth = 1;
    const out: number[] = [];
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break;
          case 0x0a: break;
          default: {
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
              out.push(v & 0xff);
            } else if (n !== undefined) {
              out.push(n);
            }
          }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) return { type: 'string', bytes: Uint8Array.from(out) };
        out.push(c);
      } else {
        out.push(c);
      }
    }
    throw new CMapParseError(`unterminated literal string at offset ${start}`);
  }
}

/* ---------- parser ---------- */

type Operand =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: Uint8Array }
  | { kind: 'array'; items: Operand[] }
  | { kind: 'dict' };

const SECTION_KEYWORDS = new Set([
  'begincodespacerange', 'endcodespacerange',
  'begincidrange', 'endcidrange',
  'begincidchar', 'endcidchar',
  'beginbfchar', 'endbfchar',
  'beginbfrange', 'endbfrange',
  'beginnotdefrange', 'endnotdefrange',
  'beginnotdefchar', 'endnotdefchar',
]);

function bigEndian(bytes: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes[i];
  return v;
}

/** UTF-16BE destination bytes -> JS string (a JS string is UTF-16, so surrogate pairs come out as one code point). */
function decodeUtf16BE(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  // A trailing single byte (1-byte destination, or an odd-length one) is one code unit.
  if (i < bytes.length) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Increment the last UTF-16 code unit of a destination string (bfrange incrementing form). */
function incrementLastUnit(dst: string, by: number): string {
  if (dst.length === 0) return dst;
  const last = dst.charCodeAt(dst.length - 1) + by;
  if (last > 0xffff) throw new CMapParseError('bfrange destination overflows a UTF-16 code unit');
  return dst.slice(0, -1) + String.fromCharCode(last);
}

class Parser {
  private readonly tok: Tokenizer;
  private readonly stack: Operand[] = [];
  private totalEntries = 0;

  readonly codespace: CodespaceRange[] = [];
  cidMap: Map<number, number> | null = null;
  unicodeMap: Map<number, string> | null = null;
  vertical = false;
  name: string | undefined;
  readonly codeLengths = new Set<number>();

  constructor(bytes: Uint8Array) {
    this.tok = new Tokenizer(bytes);
  }

  run(): void {
    for (;;) {
      const t = this.tok.next();
      if (t.type === 'eof') break;
      if (t.type === 'keyword') this.keyword(t.value);
      else this.stack.push(this.operand(t));
      if (this.stack.length > 64) this.stack.splice(0, this.stack.length - 64);
    }
    // A missing endcmap is tolerated (pdf.js keeps the map it has read); an unterminated section is not.
    this.deriveCodespace();
  }

  /** Read one operand (composites included) from a token already fetched. */
  private operand(t: Token): Operand {
    switch (t.type) {
      case 'number': return { kind: 'number', value: t.value };
      case 'name': return { kind: 'name', value: t.value };
      case 'string': return { kind: 'string', bytes: t.bytes };
      case 'arrayOpen': return this.array();
      case 'dictOpen': return this.dict();
      case 'arrayClose': throw new CMapParseError("stray ']'");
      case 'dictClose': throw new CMapParseError("stray '>>'");
      case 'keyword': throw new CMapParseError(`unexpected keyword '${t.value}' inside a composite`);
      case 'eof': throw new CMapParseError('unexpected end of CMap inside a composite');
    }
  }

  private array(): Operand {
    const items: Operand[] = [];
    for (;;) {
      const t = this.tok.next();
      if (t.type === 'arrayClose') return { kind: 'array', items };
      if (t.type === 'eof') throw new CMapParseError('unterminated array');
      items.push(this.operand(t));
    }
  }

  private dict(): Operand {
    let depth = 1;
    while (depth > 0) {
      const t = this.tok.next();
      if (t.type === 'eof') throw new CMapParseError('unterminated dictionary');
      if (t.type === 'dictOpen') depth++;
      else if (t.type === 'dictClose') depth--;
      else if (t.type === 'keyword' && SECTION_KEYWORDS.has(t.value)) throw new CMapParseError(`'${t.value}' inside a dictionary`);
    }
    return { kind: 'dict' };
  }

  private keyword(kw: string): void {
    switch (kw) {
      case 'begincmap':
      case 'endcmap':
        break;
      case 'usecmap':
        throw new CMapParseError('usecmap not supported');
      case 'def':
        this.def();
        break;
      case 'begincodespacerange':
        this.section('endcodespacerange', 2, (items) => this.codespaceEntry(items));
        break;
      case 'begincidrange':
        this.section('endcidrange', 3, (items) => this.cidRangeEntry(items));
        break;
      case 'begincidchar':
        this.section('endcidchar', 2, (items) => this.cidCharEntry(items));
        break;
      case 'beginbfchar':
        this.section('endbfchar', 2, (items) => this.bfCharEntry(items));
        break;
      case 'beginbfrange':
        this.section('endbfrange', 3, (items) => this.bfRangeEntry(items));
        break;
      case 'beginnotdefrange':
        this.section('endnotdefrange', 3, () => undefined);
        break;
      case 'beginnotdefchar':
        this.section('endnotdefchar', 2, () => undefined);
        break;
      default:
        if (SECTION_KEYWORDS.has(kw)) throw new CMapParseError(`'${kw}' without a matching begin`);
        // PostScript plumbing (findresource, dict, begin, end, pop, ...): ignored.
        break;
    }
  }

  private def(): void {
    if (this.stack.length < 2) return;
    const value = this.stack.pop() as Operand;
    const key = this.stack.pop() as Operand;
    if (key.kind !== 'name') return;
    if (key.value === 'WMode' && value.kind === 'number') this.vertical = value.value === 1;
    else if (key.value === 'CMapName' && value.kind === 'name') this.name = value.value;
  }

  /** Read `arity`-tuples of operands until `endKeyword`; every entry goes through `handle`. */
  private section(endKeyword: string, arity: number, handle: (items: Operand[]) => void): void {
    const beginKeyword = 'begin' + endKeyword.slice(3);
    this.stack.length = 0;
    const items: Operand[] = [];
    for (;;) {
      const t = this.tok.next();
      if (t.type === 'eof') throw new CMapParseError(`unterminated ${beginKeyword} section`);
      if (t.type === 'keyword') {
        if (t.value === endKeyword) {
          if (items.length !== 0) throw new CMapParseError(`incomplete entry before ${endKeyword}`);
          return;
        }
        throw new CMapParseError(`unexpected keyword '${t.value}' inside ${beginKeyword}`);
      }
      items.push(this.operand(t));
      if (items.length === arity) {
        handle(items);
        items.length = 0;
      }
    }
  }

  private code(op: Operand, what: string): { value: number; length: number } {
    if (op.kind !== 'string') throw new CMapParseError(`${what} must be a hex string`);
    const length = op.bytes.length;
    if (length < 1 || length > 4) throw new CMapParseError(`${what} must be 1..4 bytes, got ${length}`);
    return { value: bigEndian(op.bytes), length };
  }

  private range(lo: Operand, hi: Operand, what: string): { low: number; high: number; length: number } {
    const l = this.code(lo, `${what} low`);
    const h = this.code(hi, `${what} high`);
    // Bounds of different byte lengths (<00> <FFFF>): pdf.js takes the high bound's length.
    const length = Math.max(l.length, h.length);
    if (h.value < l.value) throw new CMapParseError(`${what} high < low`);
    return { low: l.value, high: h.value, length };
  }

  private budget(count: number): void {
    if (count > MAX_RANGE_ENTRIES) throw new CMapParseError(`range of ${count} entries exceeds the ${MAX_RANGE_ENTRIES} limit`);
    this.totalEntries += count;
    if (this.totalEntries > MAX_TOTAL_ENTRIES) throw new CMapParseError('CMap maps too many codes');
  }

  private integer(op: Operand, what: string): number {
    if (op.kind !== 'number' || !Number.isInteger(op.value) || op.value < 0) throw new CMapParseError(`${what} must be a non-negative integer`);
    return op.value;
  }

  private codespaceEntry([lo, hi]: Operand[]): void {
    const r = this.range(lo, hi, 'codespace range');
    this.codespace.push({ numBytes: r.length, low: r.low, high: r.high });
    this.codeLengths.add(r.length);
  }

  private cidRangeEntry([lo, hi, dst]: Operand[]): void {
    const r = this.range(lo, hi, 'cidrange');
    const cid = this.integer(dst, 'cidrange destination');
    this.budget(r.high - r.low + 1);
    const map = (this.cidMap ??= new Map());
    for (let c = r.low; c <= r.high; c++) map.set(c, cid + (c - r.low));
    this.codeLengths.add(r.length);
  }

  private cidCharEntry([src, dst]: Operand[]): void {
    const c = this.code(src, 'cidchar code');
    const cid = this.integer(dst, 'cidchar destination');
    this.budget(1);
    (this.cidMap ??= new Map()).set(c.value, cid);
    this.codeLengths.add(c.length);
  }

  private destination(op: Operand, what: string): string {
    if (op.kind !== 'string') throw new CMapParseError(`${what} must be a hex string`);
    return decodeUtf16BE(op.bytes);
  }

  private bfCharEntry([src, dst]: Operand[]): void {
    const c = this.code(src, 'bfchar code');
    const text = this.destination(dst, 'bfchar destination');
    this.budget(1);
    (this.unicodeMap ??= new Map()).set(c.value, text);
    this.codeLengths.add(c.length);
  }

  private bfRangeEntry([lo, hi, dst]: Operand[]): void {
    const r = this.range(lo, hi, 'bfrange');
    const count = r.high - r.low + 1;
    this.budget(count);
    const map = (this.unicodeMap ??= new Map());
    if (dst.kind === 'array') {
      // pdf.js maps what is there when the array is shorter or longer than the range.
      const n = Math.min(count, dst.items.length);
      for (let i = 0; i < n; i++) map.set(r.low + i, this.destination(dst.items[i], 'bfrange array item'));
    } else {
      const base = this.destination(dst, 'bfrange destination');
      for (let i = 0; i < count; i++) map.set(r.low + i, incrementLastUnit(base, i));
    }
    this.codeLengths.add(r.length);
  }

  /** No codespacerange section: cover the full range of every code length that appeared. */
  private deriveCodespace(): void {
    if (this.codespace.length > 0) return;
    const lengths = [...this.codeLengths].sort((a, b) => a - b);
    for (const n of lengths) this.codespace.push({ numBytes: n, low: 0, high: 2 ** (8 * n) - 1 });
  }
}

/** Parse an embedded CMap / ToUnicode stream. Throws CMapParseError on malformed input or `usecmap`. */
export function parseCMap(bytes: Uint8Array): CMap {
  const p = new Parser(bytes);
  p.run();
  const cmap: CMap = {
    codespace: p.codespace,
    cidMap: p.cidMap,
    unicodeMap: p.unicodeMap,
    vertical: p.vertical,
    codeLengths: p.codeLengths,
  };
  if (p.name !== undefined) cmap.name = p.name;
  return cmap;
}

/** The 2-byte Identity CMap: every code is its own CID. */
export function identityCMap(vertical: boolean): CMap {
  return {
    codespace: [{ numBytes: 2, low: 0, high: 0xffff }],
    cidMap: null,
    unicodeMap: null,
    vertical,
    name: vertical ? 'Identity-V' : 'Identity-H',
    codeLengths: new Set([2]),
  };
}

/** Only Identity-H / Identity-V are built in; any other predefined name is refused by the caller. */
export function predefinedCMap(name: string): CMap | undefined {
  if (name === 'Identity-H') return identityCMap(false);
  if (name === 'Identity-V') return identityCMap(true);
  return undefined;
}

/* ---------- decoding ---------- */

export interface DecodedCode {
  /** Big-endian value of the code bytes. */
  code: number;
  /** Number of bytes consumed (1..4). */
  length: number;
  /** Byte offset of the code inside the string operand. */
  offset: number;
}

/**
 * Split a string operand into character codes (ISO 32000-1 9.7.6.3). For each
 * position the shortest byte length whose codespace range contains the value
 * wins; with no full match, the shortest range that matches on the first byte
 * decides the length; otherwise 1 byte. Unmapped codes are still returned, the
 * caller treats them as notdef. A code cut short by the end of the string takes
 * the remaining bytes.
 */
export function splitCodes(cmap: CMap, bytes: Uint8Array): DecodedCode[] {
  const out: DecodedCode[] = [];
  const ranges = cmap.codespace;
  let fixed = 0;
  if (ranges.length === 0) fixed = cmap.codeLengths.size === 1 ? [...cmap.codeLengths][0] : 1;

  let offset = 0;
  while (offset < bytes.length) {
    let length = 0;
    if (fixed > 0) {
      length = fixed;
    } else {
      let value = 0;
      for (let n = 1; n <= 4 && length === 0; n++) {
        if (offset + n > bytes.length) break;
        value = value * 256 + bytes[offset + n - 1];
        for (const r of ranges) {
          if (r.numBytes === n && value >= r.low && value <= r.high) { length = n; break; }
        }
      }
      if (length === 0) {
        const first = bytes[offset];
        for (const r of ranges) {
          const shift = 2 ** (8 * (r.numBytes - 1));
          const lowFirst = Math.floor(r.low / shift);
          const highFirst = Math.floor(r.high / shift);
          if (first >= lowFirst && first <= highFirst && (length === 0 || r.numBytes < length)) length = r.numBytes;
        }
      }
      if (length === 0) length = 1;
    }
    if (offset + length > bytes.length) length = bytes.length - offset;
    out.push({ code: bigEndian(bytes.subarray(offset, offset + length)), length, offset });
    offset += length;
  }
  return out;
}

/** CID of a code: identity when the CMap has no cid entries, 0 (notdef) when the code is unmapped. */
export function cidOf(cmap: CMap, code: number): number {
  if (cmap.cidMap === null) return code;
  return cmap.cidMap.get(code) ?? 0;
}

/** Unicode text of a code from a ToUnicode CMap; undefined when unmapped (or when the CMap has no bf entries). */
export function unicodeOf(cmap: CMap, code: number): string | undefined {
  return cmap.unicodeMap?.get(code);
}

/* ---------- serializer ---------- */

export interface ToUnicodeEntry {
  code: number;
  /** Code length in bytes (1..4). */
  length: number;
  unicode: string;
}

function hex(value: number, bytes: number): string {
  return value.toString(16).toUpperCase().padStart(bytes * 2, '0');
}

function hexUtf16BE(text: string): string {
  let s = '';
  for (let i = 0; i < text.length; i++) s += hex(text.charCodeAt(i), 2);
  return s;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Write a ToUnicode CMap holding exactly the given codes. One full-width
 * codespace range per code length present, bfchar entries in groups of at most
 * 100, UTF-16BE destinations. Output is deterministic (sorted by length, then
 * code; later duplicates win) and reads back with parseCMap to the same map.
 */
export function serializeToUnicode(entries: ToUnicodeEntry[], options?: { name?: string; codespace?: readonly CodespaceRange[] }): Uint8Array {
  const byKey = new Map<string, ToUnicodeEntry>();
  for (const e of entries) {
    if (!Number.isInteger(e.length) || e.length < 1 || e.length > 4) throw new CMapParseError(`code length must be 1..4, got ${e.length}`);
    const max = 2 ** (8 * e.length) - 1;
    if (!Number.isInteger(e.code) || e.code < 0 || e.code > max) throw new CMapParseError(`code ${e.code} does not fit in ${e.length} byte(s)`);
    byKey.set(`${e.length}:${e.code}`, e);
  }
  const sorted = [...byKey.values()].filter((e) => e.unicode.length > 0).sort((a, b) => a.length - b.length || a.code - b.code);
  const lengths = [...new Set(sorted.map((e) => e.length))].sort((a, b) => a - b);
  const name = options?.name ?? 'DocCloak-ToUnicode';

  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    `/CMapName /${escapeName(name)} def`,
    '/CMapType 2 def',
  ];
  // Codespace: the source CMap's ranges when given (they cannot overlap, unlike full ranges of
  // different byte lengths), else the full range of every code length that occurs.
  const source = (options?.codespace ?? []).filter((r) => lengths.includes(r.numBytes));
  const covered = (e: ToUnicodeEntry): boolean => source.some((r) => r.numBytes === e.length && e.code >= r.low && e.code <= r.high);
  if (source.length > 0 && sorted.every(covered)) {
    lines.push(`${source.length} begincodespacerange`);
    for (const r of source) lines.push(`<${hex(r.low, r.numBytes)}> <${hex(r.high, r.numBytes)}>`);
    lines.push('endcodespacerange');
  } else if (lengths.length > 0) {
    lines.push(`${lengths.length} begincodespacerange`);
    for (const n of lengths) lines.push(`<${hex(0, n)}> <${hex(2 ** (8 * n) - 1, n)}>`);
    lines.push('endcodespacerange');
  }
  for (let i = 0; i < sorted.length; i += 100) {
    const group = sorted.slice(i, i + 100);
    lines.push(`${group.length} beginbfchar`);
    for (const e of group) lines.push(`<${hex(e.code, e.length)}> <${hexUtf16BE(e.unicode)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end', '');
  return asciiBytes(lines.join('\n'));
}

/** PDF name escaping (#xx for delimiters, whitespace and non-ASCII bytes). */
function escapeName(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || DELIMITERS.has(c) || c === 0x23) out += '#' + hex(c, 1);
    else out += String.fromCharCode(c);
  }
  return out;
}
