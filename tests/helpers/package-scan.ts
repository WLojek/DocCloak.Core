// Shared test helper: prove that an exported package holds no trace of the
// original text in ANY part and ANY encoding (SECURITY_REPORT-2026-09 L6).
//
// - ZIP containers (docx/xlsx): every entry is decoded as UTF-8 text and also
//   scanned as raw bytes in latin1, UTF-16LE and UTF-16BE. Entries that are
//   themselves ZIP, CFB or PDF containers (embeddings/*.xlsx, oleObject*.bin,
//   an attached .pdf) are scanned recursively. The raw archive bytes are
//   scanned too, which covers entry names, entry comments and the archive
//   comment.
// - CFB containers (.doc): every stream is scanned in all four encodings,
//   plus the raw container bytes.
// - PDF files (T214): pdf-lib parses every indirect object in the file (it
//   ignores the xref, so objects from previous revisions of an incremental
//   update are seen too, and object streams are expanded). Every stream whose
//   filters are all text codecs (Flate, LZW, ASCIIHex, ASCII85, RunLength,
//   PNG predictors undone) is decoded and scanned ("obj N stream"), every
//   literal / hex string operand found inside a decoded stream is unescaped
//   and scanned ("obj N stream string", hex strings are how most generators
//   write Tj operands), every PDFString / PDFHexString reachable from any
//   dict or array is decoded to bytes and scanned ("obj N string", these are
//   UTF-16BE with BOM for non-ASCII text), and the raw file bytes are scanned
//   ("<file>", covers regions pdf-lib cannot parse). Streams with image codecs
//   are scanned raw only. A decoded stream that is itself a ZIP, CFB or PDF
//   (embedded file) is scanned recursively under "obj N stream!inner".
// - Anything else: the raw bytes only.
//
// The helper never calls the redactor. It only looks at bytes.

import JSZip from 'jszip';
import CFB from 'cfb';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

export type PackageInput = Blob | ArrayBuffer | Uint8Array;

export type ScanEncoding = 'utf8' | 'latin1' | 'utf16le' | 'utf16be';

export interface Trace {
  /**
   * Part name inside the container ("<archive>" for the raw container bytes,
   * "<file>" for the raw bytes of a PDF). Nested containers use "outer!inner".
   * PDF parts: "obj N stream" (decoded stream), "obj N stream string" (a
   * string operand inside a decoded stream), "obj N string" (a string object
   * in a dict or array), "trailer string".
   */
  part: string;
  needle: string;
  encoding: ScanEncoding;
}

const MAX_NESTING = 3;

/** Normalise any supported input to a Uint8Array. */
export async function toBytes(input: PackageInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof (input as Blob).arrayBuffer === 'function') {
    return new Uint8Array(await (input as Blob).arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(input as Blob);
  });
}

function asUint8(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/** Encode a needle the way it would appear in bytes for the given encoding. */
export function encodeNeedle(needle: string, encoding: ScanEncoding): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(needle);
  const out: number[] = [];
  for (let i = 0; i < needle.length; i++) {
    const code = needle.charCodeAt(i);
    if (encoding === 'utf16le') {
      out.push(code & 0xff, code >> 8);
    } else if (encoding === 'utf16be') {
      out.push(code >> 8, code & 0xff);
    } else {
      // latin1: only the low byte is representable; callers pass ASCII needles
      out.push(code & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Naive byte search. Fixtures are small, so no need for anything smarter. */
export function indexOfBytes(haystack: Uint8Array, target: Uint8Array, from = 0): number {
  if (target.length === 0) return -1;
  outer: for (let i = from; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const MAX_HITS = 64;

function allIndexes(haystack: Uint8Array, target: Uint8Array): number[] {
  const out: number[] = [];
  let at = indexOfBytes(haystack, target);
  while (at !== -1 && out.length < MAX_HITS) {
    out.push(at);
    at = indexOfBytes(haystack, target, at + 1);
  }
  return out;
}

/**
 * True when `needle` occurs in `buffer` as latin1 bytes (utf16 = false) or as
 * UTF-16LE bytes (utf16 = true). Kept with its original signature from
 * tests/doc.test.ts so existing call sites keep working.
 */
export function bytesContain(buffer: ArrayBuffer | Uint8Array, needle: string, utf16: boolean): boolean {
  return indexOfBytes(asUint8(buffer), encodeNeedle(needle, utf16 ? 'utf16le' : 'latin1')) !== -1;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isCfb(bytes: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

/** The spec tolerates junk before the header; readers look in the first 1 KB. */
export function isPdf(bytes: Uint8Array): boolean {
  const at = indexOfBytes(bytes.subarray(0, 1024 + PDF_MAGIC.length), PDF_MAGIC);
  return at !== -1;
}

/**
 * UTF-16LE and UTF-16BE encodings of an ASCII needle are the same bytes
 * shifted by one: a BE hit at p and an LE hit at p + 1 are one occurrence.
 * Resolve such pairs by the buffer's BOM, else by parity (strings start at
 * even offsets in a UTF-16 buffer), so a hit is never reported twice under
 * two names, and never dropped.
 */
function resolveUtf16(bytes: Uint8Array, le: number[], be: number[]): { le: boolean; be: boolean } {
  const bomBe = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const bomLe = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const leSet = new Set(le);
  const beSet = new Set(be);
  for (const p of be) {
    if (!leSet.has(p + 1)) continue;
    const keepBe = bomBe ? true : bomLe ? false : p % 2 === 0;
    if (keepBe) leSet.delete(p + 1);
    else beSet.delete(p);
  }
  return { le: leSet.size > 0, be: beSet.size > 0 };
}

function scanBytes(part: string, bytes: Uint8Array, needles: string[], out: Trace[]): void {
  let text: string | null = null;
  for (const needle of needles) {
    if (text === null) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes(needle)) out.push({ part, needle, encoding: 'utf8' });
    if (indexOfBytes(bytes, encodeNeedle(needle, 'latin1')) !== -1) out.push({ part, needle, encoding: 'latin1' });
    const le = allIndexes(bytes, encodeNeedle(needle, 'utf16le'));
    const be = allIndexes(bytes, encodeNeedle(needle, 'utf16be'));
    if (le.length === 0 && be.length === 0) continue;
    const hit = resolveUtf16(bytes, le, be);
    if (hit.le) out.push({ part, needle, encoding: 'utf16le' });
    if (hit.be) out.push({ part, needle, encoding: 'utf16be' });
  }
}

function cfbStreams(bytes: Uint8Array): Array<{ name: string; content: Uint8Array }> {
  const container = CFB.parse(bytes, { type: 'array' });
  const streams: Array<{ name: string; content: Uint8Array }> = [];
  container.FileIndex.forEach((entry, i) => {
    if (entry.type !== 2 || !entry.content) return;
    const raw = entry.content as unknown;
    const content = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
    streams.push({ name: container.FullPaths[i] ?? entry.name, content });
  });
  return streams;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** Filters whose output is the original bytes (everything else is an image codec). */
const PDF_TEXT_FILTERS = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode']);
/** Abbreviations are only legal in inline images, but writers use them anyway; pdf-lib does not decode them. */
const PDF_FILTER_ABBREV: Record<string, string> = {
  Fl: 'FlateDecode',
  LZW: 'LZWDecode',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  RL: 'RunLengthDecode',
};

function pdfFilterNames(dict: PDFDict): string[] {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const item = filter.lookup(i);
      names.push(item instanceof PDFName ? item.decodeText() : '?');
    }
    return names;
  }
  return filter ? ['?'] : [];
}

function pdfNumber(dict: PDFDict | undefined, key: string, fallback: number): number {
  const v = dict?.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** Undo PNG predictors (Predictor >= 10). TIFF predictor 2 is left as is. */
function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array {
  const predictor = pdfNumber(parms, 'Predictor', 1);
  if (predictor < 10) return data;
  const colors = pdfNumber(parms, 'Colors', 1);
  const bpc = pdfNumber(parms, 'BitsPerComponent', 8);
  const columns = pdfNumber(parms, 'Columns', 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let x = src[i];
      switch (type) {
        case 1: x += a; break;
        case 2: x += b; break;
        case 3: x += Math.floor((a + b) / 2); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: break;
      }
      row[i] = x & 0xff;
    }
    prev = row;
  }
  return out;
}

/**
 * Decode a stream's bytes, or return undefined when a filter is an image
 * codec. Throws when a text codec fails: an undecodable stream would be a
 * silent hole in the leak check.
 */
function decodePdfStream(stream: PDFRawStream, part: string): Uint8Array | undefined {
  const names = pdfFilterNames(stream.dict);
  if (names.length === 0) return stream.contents;
  const canonical = names.map((n) => PDF_FILTER_ABBREV[n] ?? n);
  if (!canonical.every((n) => PDF_TEXT_FILTERS.has(n))) return undefined;
  // pdf-lib only knows the long names: rewrite abbreviations on a copy of the dict.
  let dict = stream.dict;
  if (canonical.some((n, i) => n !== names[i])) {
    dict = dict.clone();
    dict.set(PDFName.of('Filter'), dict.context.obj(canonical.map((n) => PDFName.of(n))));
  }
  let decoded: Uint8Array;
  try {
    decoded = decodePDFRawStream({ dict, contents: stream.contents, transform: stream.transform } as PDFRawStream).decode();
  } catch (err) {
    throw new Error(`package-scan: cannot decode ${part} (/Filter ${names.join(' ')}): ${(err as Error).message}`);
  }
  // Predictors belong to the last filter's DecodeParms.
  const parms = dict.lookup(PDFName.of('DecodeParms'));
  const last = parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms;
  return unpredict(decoded, last instanceof PDFDict ? last : undefined);
}

const MAX_STREAM_STRING = 1 << 16;

/**
 * Pull every literal "(...)" and hex "<...>" string out of decoded stream
 * bytes, unescaped to the bytes a PDF reader would see. Content streams put
 * their Tj/TJ operands here, and most generators write them as hex, which the
 * byte scan cannot see. This is a delimiter walk, not a parser: a run of
 * binary data may yield a garbage string, which is harmless.
 */
export function extractPdfStreamStrings(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const c = bytes[i];
    if (c === 0x25) {
      // % comment: skip to end of line
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      // ( literal
      const buf: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0 && buf.length < MAX_STREAM_STRING) {
        const b = bytes[i];
        if (b === 0x5c) {
          const e = bytes[i + 1];
          i += 2;
          if (e === undefined) break;
          if (e >= 0x30 && e <= 0x37) {
            let v = e - 0x30;
            for (let k = 0; k < 2 && bytes[i] >= 0x30 && bytes[i] <= 0x37; k++) v = v * 8 + (bytes[i++] - 0x30);
            buf.push(v & 0xff);
          } else if (e === 0x6e) buf.push(0x0a);
          else if (e === 0x72) buf.push(0x0d);
          else if (e === 0x74) buf.push(0x09);
          else if (e === 0x62) buf.push(0x08);
          else if (e === 0x66) buf.push(0x0c);
          else if (e === 0x0d) { if (bytes[i] === 0x0a) i++; }
          else if (e === 0x0a) { /* line continuation */ }
          else buf.push(e);
          continue;
        }
        if (b === 0x28) depth++;
        else if (b === 0x29) { depth--; if (depth === 0) { i++; break; } }
        buf.push(b);
        i++;
      }
      if (buf.length > 0) out.push(Uint8Array.from(buf));
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { i += 2; continue; } // << dict
      const buf: number[] = [];
      let hi = -1;
      let j = i + 1;
      let ok = false;
      while (j < n && buf.length < MAX_STREAM_STRING) {
        const b = bytes[j++];
        if (b === 0x3e) { ok = true; break; }
        let d: number;
        if (b >= 0x30 && b <= 0x39) d = b - 0x30;
        else if (b >= 0x41 && b <= 0x46) d = b - 0x37;
        else if (b >= 0x61 && b <= 0x66) d = b - 0x57;
        else if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00) continue;
        else break; // not a hex string (e.g. a '<' inside binary data)
        if (hi < 0) hi = d;
        else { buf.push(hi * 16 + d); hi = -1; }
      }
      if (ok) {
        if (hi >= 0) buf.push(hi * 16);
        if (buf.length > 0) out.push(Uint8Array.from(buf));
        i = j;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

function walkPdfStrings(obj: PDFObject, visit: (s: PDFString | PDFHexString) => void, seen: Set<PDFObject>, depth = 0): void {
  if (depth > 64 || seen.has(obj)) return;
  seen.add(obj);
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    visit(obj);
  } else if (obj instanceof PDFDict) {
    for (const [, v] of obj.entries()) walkPdfStrings(v, visit, seen, depth + 1);
  } else if (obj instanceof PDFArray) {
    for (const v of obj.asArray()) walkPdfStrings(v, visit, seen, depth + 1);
  } else if (obj instanceof PDFStream) {
    walkPdfStrings(obj.dict, visit, seen, depth + 1);
  }
}

async function scanPdf(prefix: string, bytes: Uint8Array, needles: string[], out: Trace[], depth: number): Promise<void> {
  const name = (part: string): string => (prefix ? `${prefix}!${part}` : part);
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    throw new Error(`package-scan: cannot parse PDF ${name('<file>')}: ${(err as Error).message}`);
  }
  if (doc.isEncrypted) {
    throw new Error(`package-scan: ${name('<file>')} is encrypted; strings and streams cannot be scanned`);
  }
  const seen = new Set<PDFObject>();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const num = ref.objectNumber;
    if (obj instanceof PDFRawStream) {
      const part = name(`obj ${num} stream`);
      const decoded = decodePdfStream(obj, part);
      if (decoded === undefined) {
        scanBytes(part, obj.contents, needles, out);
      } else if ((isZip(decoded) || isCfb(decoded) || isPdf(decoded)) && depth < MAX_NESTING) {
        await scanContainer(part, decoded, needles, out, depth + 1);
      } else {
        scanBytes(part, decoded, needles, out);
        const strings = extractPdfStreamStrings(decoded);
        if (strings.length > 0) {
          const strPart = name(`obj ${num} stream string`);
          for (const s of strings) scanBytes(strPart, s, needles, out);
        }
      }
    }
    const strPart = name(`obj ${num} string`);
    walkPdfStrings(obj, (s) => scanBytes(strPart, s.asBytes(), needles, out), seen);
  }
  const id = doc.context.trailerInfo.ID;
  if (id instanceof PDFArray || id instanceof PDFString || id instanceof PDFHexString) {
    walkPdfStrings(id, (s) => scanBytes(name('trailer string'), s.asBytes(), needles, out), seen);
  }
}

async function scanContainer(prefix: string, bytes: Uint8Array, needles: string[], out: Trace[], depth: number): Promise<void> {
  const pdf = isPdf(bytes);
  const archiveName = prefix ? prefix : pdf ? '<file>' : '<archive>';
  scanBytes(archiveName, bytes, needles, out);
  if (depth >= MAX_NESTING) return;

  if (pdf) {
    await scanPdf(prefix, bytes, needles, out, depth);
    return;
  }

  if (isZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    for (const path of Object.keys(zip.files)) {
      const file = zip.file(path);
      if (!file) continue;
      const part = prefix ? `${prefix}!${path}` : path;
      const content = await file.async('uint8array');
      if (isZip(content) || isCfb(content) || isPdf(content)) {
        await scanContainer(part, content, needles, out, depth + 1);
      } else {
        scanBytes(part, content, needles, out);
      }
    }
    return;
  }

  if (isCfb(bytes)) {
    for (const stream of cfbStreams(bytes)) {
      const part = prefix ? `${prefix}!${stream.name}` : stream.name;
      if (isZip(stream.content) || isCfb(stream.content) || isPdf(stream.content)) {
        await scanContainer(part, stream.content, needles, out, depth + 1);
      } else {
        scanBytes(part, stream.content, needles, out);
      }
    }
  }
}

/**
 * Return every (part, needle, encoding) hit without throwing. Useful for
 * tests that want to assert a fixture DOES contain something.
 */
export async function findTraces(input: PackageInput, needles: string[]): Promise<Trace[]> {
  const bytes = await toBytes(input);
  const out: Trace[] = [];
  await scanContainer('', bytes, needles.filter((n) => n.length > 0), out, 0);
  return out;
}

/**
 * Throw when any needle survives anywhere in the package: every zip entry or
 * CFB stream (UTF-8, latin1, UTF-16LE, UTF-16BE), every decoded PDF stream
 * and string, nested containers, and the raw bytes.
 */
export interface NoTraceOptions {
  /**
   * Parts the writer copies verbatim under informed consent (T177: embedded
   * objects, macros, OLE ObjectPool streams). A trace inside such a part,
   * or inside a container nested in it (`part!inner`), is not a failure;
   * the suite asserts separately that the part was reported to the user.
   */
  exclude?: (part: string) => boolean;
}

export async function assertNoTrace(input: PackageInput, needles: string[], options: NoTraceOptions = {}): Promise<void> {
  const all = await findTraces(input, needles);
  const traces = options.exclude ? all.filter((t) => !options.exclude!(t.part)) : all;
  if (traces.length === 0) return;
  const lines = traces.map((t) => `  ${JSON.stringify(t.needle)} in ${JSON.stringify(t.part)} as ${t.encoding}`);
  throw new Error(`assertNoTrace: ${traces.length} trace(s) of the original survived:\n${lines.join('\n')}`);
}

/**
 * True when the needle is present somewhere in the package. Used by the
 * fixture self-tests to prove a generator really seeded what it claims.
 */
export async function packageContains(input: PackageInput, needle: string): Promise<boolean> {
  return (await findTraces(input, [needle])).length > 0;
}

/**
 * Env var contract for the LibreOffice CI job: when DOCCLOAK_WRITE_OUTPUTS is
 * set to a directory, tests can drop the files they produced there so the
 * 'office-open' workflow job can run `soffice --headless --convert-to pdf`
 * over them. When the variable is unset this is a no-op and returns undefined.
 * Returns the absolute path written.
 */
export async function writeOutput(name: string, bytes: PackageInput): Promise<string | undefined> {
  const dir = typeof process !== 'undefined' ? process.env?.DOCCLOAK_WRITE_OUTPUTS : undefined;
  if (!dir) return undefined;
  const safe = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, safe);
  writeFileSync(target, await toBytes(bytes));
  return target;
}
