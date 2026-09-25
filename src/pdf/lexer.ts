/**
 * @doccloak/core/pdf - content stream lexer (T206).
 *
 * Tokenizes a PDF content stream (ISO 32000-1 section 7.2 and 7.8.2) into
 * operators with typed operands, keeping the source byte range of every
 * operator so untouched operators can be copied back verbatim by the
 * serializer. Inline images (BI ... ID <binary> EI) are kept as one opaque
 * operator holding the raw bytes. Unknown operators are kept as-is.
 *
 * The lexer never throws on malformed input: an unparsable byte sequence
 * ends up as an operator with `op: ''` and the raw bytes, which the callers
 * treat as "unsafe page" (rasterize) rather than silently dropping content.
 */

export type Operand =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: Uint8Array; hex: boolean }
  | { kind: 'array'; items: Operand[] }
  | { kind: 'dict'; entries: Map<string, Operand> }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' };

export interface ContentOp {
  /** Operator name ('Tj', 'TJ', 'q', ...). 'BI' for an inline image. '' for unparsable bytes. */
  op: string;
  operands: Operand[];
  /** Byte range of the whole operator (operands included) in the source stream. Absent for synthesized ops. */
  start?: number;
  end?: number;
  /** For 'BI': the raw bytes of the whole BI ... EI segment. For '': the skipped bytes. */
  raw?: Uint8Array;
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWhitespace(b: number): boolean {
  return WHITESPACE.has(b);
}
function isDelimiter(b: number): boolean {
  return DELIMITERS.has(b);
}
function isRegular(b: number): boolean {
  return !isWhitespace(b) && !isDelimiter(b);
}
function isDigitLike(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e;
}

type Token =
  | { type: 'operand'; operand: Operand; start: number; end: number }
  | { type: 'keyword'; value: string; start: number; end: number }
  | { type: 'arrayOpen'; start: number; end: number }
  | { type: 'arrayClose'; start: number; end: number }
  | { type: 'dictOpen'; start: number; end: number }
  | { type: 'dictClose'; start: number; end: number }
  | { type: 'eof'; start: number; end: number };

class Scanner {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  skipWhitespaceAndComments(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWhitespace(c)) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  next(): Token {
    this.skipWhitespaceAndComments();
    const b = this.bytes;
    const start = this.pos;
    if (this.pos >= b.length) return { type: 'eof', start, end: start };
    const c = b[this.pos];

    if (c === 0x5b) { this.pos++; return { type: 'arrayOpen', start, end: this.pos }; }
    if (c === 0x5d) { this.pos++; return { type: 'arrayClose', start, end: this.pos }; }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) { this.pos += 2; return { type: 'dictOpen', start, end: this.pos }; }
      return this.hexString(start);
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) { this.pos += 2; return { type: 'dictClose', start, end: this.pos }; }
      // A lone '>' is malformed; treat as a keyword so the caller marks the op unsafe.
      this.pos++;
      return { type: 'keyword', value: '>', start, end: this.pos };
    }
    if (c === 0x28) return this.literalString(start);
    if (c === 0x2f) return this.name(start);
    if (c === 0x7b || c === 0x7d) { this.pos++; return { type: 'keyword', value: String.fromCharCode(c), start, end: this.pos }; }
    if (c === 0x29) { this.pos++; return { type: 'keyword', value: ')', start, end: this.pos }; }
    if (isDigitLike(c)) return this.number(start);

    // Regular characters: keyword (operator, true/false/null)
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    const word = latin1(b.subarray(start, this.pos));
    if (word === 'true') return { type: 'operand', operand: { kind: 'bool', value: true }, start, end: this.pos };
    if (word === 'false') return { type: 'operand', operand: { kind: 'bool', value: false }, start, end: this.pos };
    if (word === 'null') return { type: 'operand', operand: { kind: 'null' }, start, end: this.pos };
    return { type: 'keyword', value: word, start, end: this.pos };
  }

  private number(start: number): Token {
    const b = this.bytes;
    while (this.pos < b.length && isRegular(b[this.pos])) this.pos++;
    const text = latin1(b.subarray(start, this.pos));
    const value = parsePdfNumber(text);
    if (value === null) return { type: 'keyword', value: text, start, end: this.pos };
    return { type: 'operand', operand: { kind: 'number', value }, start, end: this.pos };
  }

  private name(start: number): Token {
    const b = this.bytes;
    this.pos++; // '/'
    let out = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos];
      if (c === 0x23 && this.pos + 2 < b.length + 1) {
        const hex = latin1(b.subarray(this.pos + 1, this.pos + 3));
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return { type: 'operand', operand: { kind: 'name', value: out }, start, end: this.pos };
  }

  private hexString(start: number): Token {
    const b = this.bytes;
    this.pos++; // '<'
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos];
      const d = hexDigit(c);
      if (d >= 0) digits.push(d);
      // Whitespace is ignored; anything else is malformed but tolerated (skipped) like viewers do.
      this.pos++;
    }
    this.pos++; // '>'
    if (digits.length % 2 === 1) digits.push(0);
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return { type: 'operand', operand: { kind: 'string', bytes, hex: true }, start, end: this.pos };
  }

  private literalString(start: number): Token {
    const b = this.bytes;
    this.pos++; // '('
    let depth = 1;
    const out: number[] = [];
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const n = b[this.pos++];
        switch (n) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x28: out.push(0x28); break;
          case 0x29: out.push(0x29); break;
          case 0x5c: out.push(0x5c); break;
          case 0x0d: if (b[this.pos] === 0x0a) this.pos++; break; // line continuation
          case 0x0a: break;
          default: {
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) {
                v = v * 8 + (b[this.pos++] - 0x30);
              }
              out.push(v & 0xff);
            } else if (n !== undefined) {
              out.push(n); // unknown escape: the backslash is ignored
            }
          }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else {
        // Raw EOL bytes stay as they are (pdf.js keeps them; only escaped EOLs are line continuations),
        // so the codes we match against are the ones the reference extractor sees.
        out.push(c);
      }
    }
    return { type: 'operand', operand: { kind: 'string', bytes: Uint8Array.from(out), hex: false }, start, end: this.pos };
  }
}

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * PDF numbers: optional sign, digits, optional fraction; tolerant to '--5', '.5', '5.', '3.4.5' (viewers
 * accept). Any '-' among the sign characters makes the number negative, as pdf.js and Acrobat read '--5'.
 */
export function parsePdfNumber(text: string): number | null {
  if (!/^[+-]*(\d+\.?\d*|\.\d+)(\.\d*)*$/.test(text)) return null;
  const negative = (text.match(/^[+-]*/)?.[0] ?? '').includes('-');
  const body = text.replace(/^[+-]*/, '');
  const firstDot = body.indexOf('.');
  const cleaned = firstDot >= 0 ? body.slice(0, firstDot + 1) + body.slice(firstDot + 1).replace(/\./g, '') : body;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

const INLINE_IMAGE_ABBREV: Record<string, string> = {
  BPC: 'BitsPerComponent', CS: 'ColorSpace', D: 'Decode', DP: 'DecodeParms', F: 'Filter',
  H: 'Height', W: 'Width', IM: 'ImageMask', I: 'Interpolate', L: 'Length',
};

/** Tokenize a content stream into operators. Never throws. */
export function lexContent(bytes: Uint8Array): ContentOp[] {
  const scanner = new Scanner(bytes);
  const ops: ContentOp[] = [];
  let operands: Operand[] = [];
  let operandsStart = -1;

  const flushUnsafe = (start: number, end: number): void => {
    ops.push({ op: '', operands: [], start, end, raw: bytes.subarray(start, end) });
  };

  for (;;) {
    const tok = scanner.next();
    if (tok.type === 'eof') {
      if (operands.length > 0) flushUnsafe(operandsStart, tok.end);
      break;
    }
    if (tok.type === 'operand') {
      if (operands.length === 0) operandsStart = tok.start;
      operands.push(tok.operand);
      continue;
    }
    if (tok.type === 'arrayOpen' || tok.type === 'dictOpen') {
      if (operands.length === 0) operandsStart = tok.start;
      const composite = readComposite(scanner, tok.type === 'arrayOpen' ? 'array' : 'dict');
      if (composite === null) {
        flushUnsafe(operandsStart, scanner.pos);
        operands = [];
        continue;
      }
      operands.push(composite);
      continue;
    }
    if (tok.type === 'arrayClose' || tok.type === 'dictClose') {
      // Stray closer: unsafe
      flushUnsafe(operands.length ? operandsStart : tok.start, tok.end);
      operands = [];
      continue;
    }
    // keyword = operator
    const start = operands.length ? operandsStart : tok.start;
    if (tok.value === 'BI') {
      const end = readInlineImage(scanner);
      if (end < 0) {
        // No EI: the rest of the stream is opaque to us (a viewer may still find text in it).
        flushUnsafe(start, bytes.length);
        break;
      }
      ops.push({ op: 'BI', operands: [], start, end, raw: bytes.subarray(start, end) });
      operands = [];
      continue;
    }
    if (!/^[A-Za-z'"*]{1,3}[0-9]?$/.test(tok.value)) {
      flushUnsafe(start, tok.end);
      operands = [];
      continue;
    }
    ops.push({ op: tok.value, operands, start, end: tok.end });
    operands = [];
  }
  return ops;
}

/** Nesting bound for arrays/dicts inside operands: deeper input is treated as unsafe instead of overflowing the stack. */
const MAX_COMPOSITE_DEPTH = 64;

function readComposite(scanner: Scanner, kind: 'array' | 'dict', depth = 0): Operand | null {
  if (depth >= MAX_COMPOSITE_DEPTH) return null;
  if (kind === 'array') {
    const items: Operand[] = [];
    for (;;) {
      const tok = scanner.next();
      if (tok.type === 'eof') return null;
      if (tok.type === 'arrayClose') return { kind: 'array', items };
      if (tok.type === 'operand') { items.push(tok.operand); continue; }
      if (tok.type === 'arrayOpen' || tok.type === 'dictOpen') {
        const inner = readComposite(scanner, tok.type === 'arrayOpen' ? 'array' : 'dict', depth + 1);
        if (inner === null) return null;
        items.push(inner);
        continue;
      }
      return null; // keyword or stray closer inside an array
    }
  }
  const entries = new Map<string, Operand>();
  for (;;) {
    const keyTok = scanner.next();
    if (keyTok.type === 'eof') return null;
    if (keyTok.type === 'dictClose') return { kind: 'dict', entries };
    if (keyTok.type !== 'operand' || keyTok.operand.kind !== 'name') return null;
    const valTok = scanner.next();
    let value: Operand | null = null;
    if (valTok.type === 'operand') value = valTok.operand;
    else if (valTok.type === 'arrayOpen' || valTok.type === 'dictOpen') {
      value = readComposite(scanner, valTok.type === 'arrayOpen' ? 'array' : 'dict', depth + 1);
    }
    if (value === null) return null;
    entries.set(keyTok.operand.value, value);
  }
}

/**
 * Consume an inline image after its BI keyword: the key/value pairs up to ID,
 * one whitespace byte, then the binary data up to EI. Returns the end offset
 * (just after EI), or -1 when the image never ends. When the data is unfiltered
 * (or carries /Length) its length is computed; otherwise EI is searched for
 * with the reference extractor's rules.
 */
function readInlineImage(scanner: Scanner): number {
  const b = scanner.bytes;
  const params = new Map<string, Operand>();
  for (;;) {
    const tok = scanner.next();
    if (tok.type === 'eof') return -1;
    if (tok.type === 'keyword') {
      if (tok.value === 'ID') break;
      continue;
    }
    if (tok.type === 'operand' && tok.operand.kind === 'name') {
      const key = INLINE_IMAGE_ABBREV[tok.operand.value] ?? tok.operand.value;
      const valTok = scanner.next();
      if (valTok.type === 'operand') params.set(key, valTok.operand);
      else if (valTok.type === 'arrayOpen' || valTok.type === 'dictOpen') {
        const v = readComposite(scanner, valTok.type === 'arrayOpen' ? 'array' : 'dict');
        if (v) params.set(key, v);
      } else if (valTok.type === 'eof') return -1;
    }
  }
  // Exactly one whitespace byte after ID
  let dataStart = scanner.pos;
  if (dataStart < b.length && isWhitespace(b[dataStart])) dataStart++;

  const filter = params.get('Filter');
  const hasFilter = filter !== undefined && !(filter.kind === 'array' && filter.items.length === 0);
  let dataEnd = -1;
  const declared = numberParam(params, 'Length');
  if (declared !== null && declared >= 0 && dataStart + declared <= b.length) dataEnd = dataStart + declared;
  if (dataEnd < 0 && !hasFilter) {
    const w = numberParam(params, 'Width');
    const h = numberParam(params, 'Height');
    const bpc = params.get('ImageMask')?.kind === 'bool' && (params.get('ImageMask') as { value: boolean }).value ? 1 : numberParam(params, 'BitsPerComponent') ?? 8;
    const ncomp = componentsFor(params.get('ColorSpace'));
    if (w !== null && h !== null && ncomp !== null) {
      const rowBytes = Math.ceil((w * bpc * ncomp) / 8);
      dataEnd = dataStart + rowBytes * h;
      if (dataEnd > b.length) dataEnd = -1;
    }
  }
  if (dataEnd < 0) {
    const found = findInlineImageEnd(b, dataStart, filterNames(filter));
    if (found < 0) {
      scanner.pos = b.length;
      return -1;
    }
    scanner.pos = found;
    return found;
  }
  // Find EI after dataEnd
  let p = dataEnd;
  while (p < b.length && isWhitespace(b[p])) p++;
  if (b[p] === 0x45 && b[p + 1] === 0x49 && (p + 2 >= b.length || !isRegular(b[p + 2]))) {
    scanner.pos = p + 2;
    return scanner.pos;
  }
  // Length mismatch (filtered data shorter than computed, or garbage): fall back to the search.
  const searched = findInlineImageEnd(b, dataStart, filterNames(filter));
  if (searched < 0) {
    scanner.pos = b.length;
    return -1;
  }
  scanner.pos = searched;
  return scanner.pos;
}

function filterNames(filter: Operand | undefined): string[] {
  if (!filter) return [];
  if (filter.kind === 'name') return [filter.value];
  if (filter.kind === 'array') return filter.items.filter((it) => it.kind === 'name').map((it) => (it as { value: string }).value);
  return [];
}

/** Bytes pdf.js requires after a candidate EI: ASCII (or EOL) for this many bytes, else the EI is image data. */
const EI_LOOKAHEAD = 10;

/**
 * Search for the end of inline image data the way pdf.js does: the first "EI" followed by
 * whitespace (or EOF) whose next bytes are ASCII; a whitespace before the E is not required.
 * DCT data ends at its EOI marker, ASCIIHex at '>', ASCII85 at '~>', so a false "EI" inside
 * such data cannot end the image early. Returns the offset just after EI, or -1 when no end
 * is found (the caller marks the rest of the stream unsafe).
 */
function findInlineImageEnd(b: Uint8Array, from: number, filters: string[]): number {
  let p = from;
  const first = filters[0];
  if (first === 'DCTDecode' || first === 'DCT') {
    // Scan JPEG markers for EOI (FFD9); skip entropy-coded segments by their lengths.
    for (let q = from; q + 1 < b.length; q++) {
      if (b[q] === 0xff && b[q + 1] === 0xd9) { p = q + 2; break; }
    }
  } else if (first === 'ASCIIHexDecode' || first === 'AHx') {
    const q = b.indexOf(0x3e, from);
    if (q >= 0) p = q + 1;
  } else if (first === 'ASCII85Decode' || first === 'A85') {
    for (let q = from; q + 1 < b.length; q++) {
      if (b[q] === 0x7e && b[q + 1] === 0x3e) { p = q + 2; break; }
    }
  }
  for (; p + 1 < b.length; p++) {
    if (b[p] !== 0x45 || b[p + 1] !== 0x49) continue;
    if (p + 2 < b.length && !isWhitespace(b[p + 2])) continue;
    let ok = true;
    for (let k = p + 2; k < Math.min(b.length, p + 2 + EI_LOOKAHEAD); k++) {
      const c = b[k];
      if (c !== 0x0a && c !== 0x0d && c !== 0x09 && (c < 0x20 || c > 0x7e)) { ok = false; break; }
    }
    if (ok) return p + 2;
  }
  return -1;
}

function numberParam(params: Map<string, Operand>, key: string): number | null {
  const v = params.get(key);
  return v && v.kind === 'number' ? v.value : null;
}

function componentsFor(cs: Operand | undefined): number | null {
  if (!cs) return 1;
  if (cs.kind === 'name') {
    switch (cs.value) {
      case 'DeviceGray': case 'G': case 'CalGray': case 'Indexed': case 'I': return 1;
      case 'DeviceRGB': case 'RGB': case 'CalRGB': case 'Lab': return 3;
      case 'DeviceCMYK': case 'CMYK': return 4;
      default: return null; // named resource: unknown component count
    }
  }
  if (cs.kind === 'array' && cs.items[0]?.kind === 'name') {
    const fam = cs.items[0].value;
    if (fam === 'Indexed' || fam === 'I') return 1;
    return componentsFor(cs.items[0]);
  }
  return null;
}

/* ---------- operand constructors (for synthesized operators) ---------- */

export const num = (value: number): Operand => ({ kind: 'number', value });
export const name = (value: string): Operand => ({ kind: 'name', value });
export const hexString = (bytes: Uint8Array): Operand => ({ kind: 'string', bytes, hex: true });
export const array = (items: Operand[]): Operand => ({ kind: 'array', items });
export const makeOp = (op: string, ...operands: Operand[]): ContentOp => ({ op, operands });

/** Operator classes used by the state machine and the surgery. */
export const TEXT_SHOW_OPS: ReadonlySet<string> = new Set(['Tj', 'TJ', "'", '"']);
export const TEXT_POSITION_OPS: ReadonlySet<string> = new Set(['Td', 'TD', 'Tm', 'T*']);
