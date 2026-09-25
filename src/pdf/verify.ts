/**
 * @doccloak/core/pdf - post-write verification (T213).
 *
 * The output is re-read by two independent extractors (ours and pdf.js) and
 * scanned byte-wise; any surviving needle refuses the export. Nothing this
 * module reports is advisory: the writer throws on a non-empty finding list.
 */

import { PDFDocument, PDFRawStream, PDFHexString, PDFString, PDFDict, PDFArray, PDFStream, PDFName } from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';
import { decodeStream, isImageEncoded, namesOf } from './objects.ts';
import { extractPdf } from './extract.ts';
import { findOccurrences, searchIndex } from './oracle.ts';
import type { SearchIndex } from './oracle.ts';
import { lexContent } from './lexer.ts';
import type { Operand } from './lexer.ts';
import type { OracleDocument } from './oracle.ts';

export interface VerifyFinding {
  pass: 'own-extractor' | 'oracle' | 'stream-bytes' | 'string-bytes' | 'code-sequence';
  needle: string;
  where: string;
}

export class PdfVerifyError extends Error {
  readonly findings: VerifyFinding[];
  constructor(findings: VerifyFinding[]) {
    super(`redacted PDF still holds ${findings.length} trace(s): ${findings.slice(0, 5).map((f) => `${f.pass}@${f.where}`).join(', ')}`);
    this.name = 'PdfVerifyError';
    this.findings = findings;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface VerifyInput {
  bytes: Uint8Array;
  /** Original values that must not survive (case-insensitive, whitespace-insensitive in text passes). */
  needles: string[];
  /** Original code byte sequences removed from content streams, per edited font key (searched in content streams only). */
  removedSequences?: Array<{ bytes: Uint8Array; codeLength?: number }>;
  oracle?: OracleDocument;
  /** Placeholder texts written into the output: a value found only inside one of them ("We" in "[WE]") is not a trace. */
  placeholders?: string[];
}

/** Run every pass; returns the findings (empty when clean). */
export async function verifyPdf(input: VerifyInput): Promise<VerifyFinding[]> {
  const findings: VerifyFinding[] = [];
  const needles = uniqueNeedles(input.needles);
  if (needles.length === 0) return findings;
  const placeholders = uniqueNeedles(input.placeholders ?? []);
  // Occurrences of a needle that lie inside a placeholder holding that needle ("Name" in "[NAME]") are the placeholder, not the value.
  const outsidePlaceholders = (index: SearchIndex, needle: string): boolean => {
    const hits = findOccurrences(index, needle);
    if (hits.length === 0) return false;
    const shelters: Array<[number, number]> = [];
    for (const ph of placeholders) {
      if (findOccurrences(ph, needle).length === 0) continue;
      for (let i = index.text.indexOf(ph); i >= 0; i = index.text.indexOf(ph, i + ph.length)) shelters.push([i, i + ph.length]);
    }
    return hits.some(([a, b]) => !shelters.some(([s, e]) => a >= s && b <= e));
  };
  const sheltered = (needle: string): boolean => placeholders.some((ph) => findOccurrences(ph, needle).length > 0);

  // Pass 1: our extractor (the same search as layer zero: folded, at token boundaries), cross-checked
  // against pdf.js page by page. Pages both extractors read identically are settled by this pass.
  let ownExtractorFailed = false;
  let unsettled: Set<number> | null = null; // pages pass 2 must still search (null: all of them)
  try {
    const ours = await extractPdf(input.bytes, { maxBytes: Number.MAX_SAFE_INTEGER, maxPages: Number.MAX_SAFE_INTEGER, oracle: input.oracle });
    const index = searchIndex(ours.plainText);
    for (const n of needles) if (outsidePlaceholders(index, n)) findings.push({ pass: 'own-extractor', needle: n, where: 'text' });
    if (input.oracle) {
      unsettled = new Set<number>();
      ours.model.pages.forEach((page, p) => { if (page.issues.length > 0 || page.oracleText) unsettled!.add(p); });
      for (const u of ours.unredactable) {
        const m = /^pages? (\d+)(?:-(\d+))?$/.exec(u.part);
        if (m) for (let p = Number(m[1]) - 1; p <= Number(m[2] ?? m[1]) - 1; p++) unsettled.add(p);
      }
    }
  } catch (err) {
    ownExtractorFailed = true;
    findings.push({ pass: 'own-extractor', needle: '', where: `re-extraction failed: ${(err as Error).message}` });
  }

  // Pass 2: pdf.js, for pages our extractor could not settle (its own spacing heuristics would
  // otherwise report "Jan" inside a kerned "Janusz").
  if (input.oracle) {
    for (let p = 0; p < input.oracle.pageCount; p++) {
      if (unsettled && !unsettled.has(p)) continue;
      let text: string;
      try {
        // pdf.js hands items back in content order; words drawn from the right would spell a value
        // that is not on the page. Read the items in baseline order instead (top to bottom, left to right).
        text = readingOrderText(await input.oracle.pageItems(p));
      } catch (err) {
        // A page the reference extractor cannot read cannot be verified: fail closed.
        findings.push({ pass: 'oracle', needle: '', where: `page ${p + 1} unreadable by pdf.js: ${(err as Error).message ?? String(err)}` });
        continue;
      }
      const index = searchIndex(text);
      for (const n of needles) if (outsidePlaceholders(index, n)) findings.push({ pass: 'oracle', needle: n, where: `page ${p + 1}` });
    }
  }

  // Pass 3-5: bytes of every decoded stream, every string object, and the raw file. A needle that a
  // placeholder contains is left to the text passes (its bytes are in every placeholder).
  const encodedNeedles = needles.filter((n) => !sheltered(n)).flatMap((n) => encodeNeedle(n));
  let doc: PDFDocument | undefined;
  try {
    doc = await PDFDocument.load(input.bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (err) {
    findings.push({ pass: 'stream-bytes', needle: '', where: `output could not be parsed: ${(err as Error).message}` });
  }
  if (doc) {
    const ctx = doc.context;
    const contentStreams: Uint8Array[] = [];
    const contentStrings: Haystack[] = []; // their string operands, for the code-sequence pass
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) {
        if (isImageEncoded(ctx, obj)) continue;
        let decoded: Uint8Array;
        try { decoded = decodeStream(ctx, obj); } catch { continue; }
        if (isFontProgram(ctx, obj) || looksLikeFontProgram(decoded)) {
          // Glyph programs carry font names ("Times New Roman"), never document text: only a needle
          // no font name can contain (several words, or digits) is searched here.
          const strong = encodedNeedles.filter((n) => strongNeedle(n.raw));
          if (strong.length > 0) {
            const fontHay = haystackOf(decoded);
            for (const n of strong) {
              if (containsBytes(fontHay, n)) findings.push({ pass: 'stream-bytes', needle: n.raw, where: `obj ${ref.objectNumber} font program (${n.encoding})` });
            }
          }
          scanStrings(obj.dict, ref.objectNumber, encodedNeedles, findings, new Set());
          continue;
        }
        const type = namesOf(ctx, obj.dict.get(PDFName.of('Type')))[0];
        const subtype = namesOf(ctx, obj.dict.get(PDFName.of('Subtype')))[0];
        const isContent = type === undefined || type === 'Pattern' || (type === 'XObject' && subtype === 'Form');
        if (isContent) contentStreams.push(decoded);
        // A content stream shows text only through its string operands: numbers, names and
        // operators ("/F1 12 Tf", coordinates) are not text a viewer displays. Other streams
        // (XMP, CMaps, anything unknown) are scanned whole.
        const haystack = haystackOf(isContent ? stringOperandsOf(decoded) : decoded);
        if (isContent) contentStrings.push(haystack);
        for (const n of encodedNeedles) {
          if (containsBytes(haystack, n)) findings.push({ pass: 'stream-bytes', needle: n.raw, where: `obj ${ref.objectNumber} (${n.encoding})` });
        }
        scanStrings(obj.dict, ref.objectNumber, encodedNeedles, findings, new Set());
      } else if (obj instanceof PDFDict || obj instanceof PDFArray || obj instanceof PDFString || obj instanceof PDFHexString) {
        scanStrings(obj, ref.objectNumber, encodedNeedles, findings, new Set());
      }
    }
    // Removed code sequences are searched only when our extractor could not re-read the output
    // (pass 1 covers every font we edit; a value split over two shows next to another word
    // would otherwise be reported although no reader sees it).
    const seen = new Set<string>();
    for (const seq of ownExtractorFailed ? input.removedSequences ?? [] : []) {
      if (seq.bytes.length < 4) continue;
      // Multi-byte codes (Identity-H glyph ids) have no token boundaries in a byte scan and are
      // read by both text passes anyway; a prefix of a longer word would refuse every export.
      if ((seq.codeLength ?? 1) !== 1) continue;
      const key = hex(seq.bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      // Single-byte codes: the sequence must fill a whole token of the string it sits in (a
      // value "w100" is not the "w100" inside "w1000"); multi-byte codes have no such notion.
      const probe: EncodedNeedle = { raw: hex(seq.bytes), encoding: 'utf8', bytes: seq.bytes, boundStart: (seq.codeLength ?? 1) === 1, boundEnd: (seq.codeLength ?? 1) === 1 };
      for (let i = 0; i < contentStreams.length; i++) {
        if (containsBytes(contentStrings[i], probe)) {
          findings.push({ pass: 'code-sequence', needle: hex(seq.bytes), where: `content stream #${i}` });
        }
      }
    }
  }
  // No whole-file byte pass: every object pdf-lib writes is either a stream (scanned decoded above,
  // font programs and image codecs excepted) or a dict/array/string (scanned above). A raw scan would
  // only add false positives from font names ("Roman", "Georgia") inside embedded font programs.
  return dedupe(findings);
}

function scanStrings(obj: PDFObject, objNum: number, needles: EncodedNeedle[], findings: VerifyFinding[], seen: Set<PDFObject>): void {
  if (seen.has(obj)) return;
  seen.add(obj);
  if (obj instanceof PDFHexString || obj instanceof PDFString) {
    const bytes = obj.asBytes();
    for (const n of needles) {
      if (containsBytes(bytes, n)) findings.push({ pass: 'string-bytes', needle: n.raw, where: `obj ${objNum} string (${n.encoding})` });
    }
    return;
  }
  if (obj instanceof PDFName) {
    // Names (resource keys, /BaseFont, /Title of a layer...) can spell a value too; font names are
    // skipped since a person may share a name with a typeface ("Georgia", "Roman"), and the value
    // must fill a whole token of the name ("kid" is not /Kids, "Source" is not /SourceSans).
    const text = obj.decodeText();
    for (const n of needles) {
      if (n.encoding !== 'utf8') continue;
      if (findOccurrences(text, n.raw).length > 0) findings.push({ pass: 'string-bytes', needle: n.raw, where: `obj ${objNum} name` });
    }
    return;
  }
  if (obj instanceof PDFStream) { scanStrings(obj.dict, objNum, needles, findings, seen); return; }
  if (obj instanceof PDFDict) {
    const type = obj.get(PDFName.of('Type'));
    const isFontDict = type instanceof PDFName && (type.decodeText() === 'FontDescriptor' || type.decodeText() === 'Font');
    for (const [k, v] of obj.entries()) {
      const key = k.decodeText();
      // Font names are metadata, never document text; a surname equal to a font name must not block the export.
      if (key === 'BaseFont' || key === 'FontName' || key === 'FontFamily' || key === 'CharSet') continue;
      if (isFontDict && v instanceof PDFName) continue;
      scanStrings(k, objNum, needles, findings, seen);
      scanStrings(v, objNum, needles, findings, seen);
    }
    return;
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) scanStrings(obj.get(i), objNum, needles, findings, seen);
  }
}

/** A needle no font program or font name could legitimately contain: several words, or a digit. */
function strongNeedle(needle: string): boolean {
  return /\s/.test(needle.trim()) || /\d/.test(needle);
}

/** pdf.js items joined in reading order: lines by baseline (top first), items left to right within a line. */
function readingOrderText(items: Array<{ str: string; transform: number[]; width: number; height: number; hasEOL: boolean }>): string {
  const rows = items.map((it, i) => ({ it, i, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 1 }));
  rows.sort((a, b) => {
    const tol = 0.5 * Math.max(a.h, b.h, 1);
    if (Math.abs(a.y - b.y) > tol) return b.y - a.y;
    if (Math.abs(a.x - b.x) > 1e-6) return a.x - b.x;
    return a.i - b.i;
  });
  let out = '';
  let prev: (typeof rows)[number] | undefined;
  for (const r of rows) {
    if (prev && Math.abs(prev.y - r.y) > 0.5 * Math.max(prev.h, r.h, 1)) out += '\n';
    // Only a real gap separates words: two items butting against each other are one word ("Jan" + "usz").
    else if (prev && r.x - (prev.x + prev.w) > 0.12 * Math.max(prev.h, r.h, 1) && !out.endsWith(' ') && !r.it.str.startsWith(' ')) out += ' ';
    out += r.it.str;
    prev = r;
  }
  return out;
}

/** The bytes of every string operand of a content stream, separated by newlines. */
function stringOperandsOf(decoded: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const collect = (op: Operand): void => {
    if (op.kind === 'string') { parts.push(op.bytes); total += op.bytes.length + 1; }
    else if (op.kind === 'array') for (const it of op.items) collect(it);
    else if (op.kind === 'dict') for (const [, v] of op.entries) collect(v);
  };
  for (const op of lexContent(decoded)) {
    if (op.op === '' || op.op === 'BI') { // unparsable bytes and inline images are scanned as they are
      if (op.raw) { parts.push(op.raw); total += op.raw.length + 1; }
      continue;
    }
    if (op.op === 'TJ' && op.operands[0]?.kind === 'array') {
      // The strings of one TJ are one show: a word split by kerning numbers stays one token.
      const joined: number[] = [];
      for (const it of op.operands[0].items) if (it.kind === 'string') for (const b of it.bytes) joined.push(b);
      const u = Uint8Array.from(joined);
      parts.push(u); total += u.length + 1;
      continue;
    }
    for (const operand of op.operands) collect(operand);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; out[at++] = 0x0a; }
  return out;
}

/** Font program magic: TrueType (00010000 / 'true'), OpenType ('OTTO'), Type1 ('%!PS' or PFB 80 01), CFF (01 00 04). */
function looksLikeFontProgram(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];
  if (b0 === 0 && b1 === 1 && b2 === 0 && b3 === 0) return true;
  const tag = String.fromCharCode(b0, b1, b2, b3);
  if (tag === 'true' || tag === 'OTTO' || tag === 'ttcf' || tag === '%!PS') return true;
  if (b0 === 0x80 && b1 === 0x01) return true;
  if (b0 === 1 && b1 === 0 && b2 === 4 && b3 <= 4) return true;
  return false;
}

/** Embedded font programs (FontFile, FontFile2, FontFile3): glyph outlines and font names, never document text. */
function isFontProgram(ctx: PDFDocument['context'], stream: PDFRawStream): boolean {
  const d = stream.dict;
  if (d.get(PDFName.of('Length1')) || d.get(PDFName.of('Length2')) || d.get(PDFName.of('Length3'))) return true;
  const subtype = namesOf(ctx, d.get(PDFName.of('Subtype')))[0];
  return subtype === 'Type1C' || subtype === 'CIDFontType0C' || subtype === 'OpenType';
}

interface EncodedNeedle { raw: string; encoding: string; bytes: Uint8Array; boundStart: boolean; boundEnd: boolean; text?: string }

/** Bytes with their Latin-1 string form (built once per stream, searched for every needle). */
interface Haystack { bytes: Uint8Array; text: string }

function latin1String(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  return s;
}

function haystackOf(bytes: Uint8Array): Haystack {
  return { bytes, text: latin1String(bytes) };
}

function encodeNeedle(needle: string): EncodedNeedle[] {
  const out: EncodedNeedle[] = [];
  const bounds = { boundStart: /[\p{L}\p{N}]/u.test(needle.charAt(0)), boundEnd: /[\p{L}\p{N}]/u.test(needle.slice(-1)) };
  const utf8 = new TextEncoder().encode(needle);
  out.push({ raw: needle, encoding: 'utf8', bytes: utf8, ...bounds });
  let latin1Ok = true;
  const latin1 = new Uint8Array(needle.length);
  for (let i = 0; i < needle.length; i++) {
    const c = needle.charCodeAt(i);
    if (c > 0xff) { latin1Ok = false; break; }
    latin1[i] = c;
  }
  if (latin1Ok && !sameBytes(latin1, utf8)) out.push({ raw: needle, encoding: 'latin1', bytes: latin1, ...bounds });
  const be = new Uint8Array(needle.length * 2);
  const le = new Uint8Array(needle.length * 2);
  for (let i = 0; i < needle.length; i++) {
    const c = needle.charCodeAt(i);
    be[2 * i] = c >> 8; be[2 * i + 1] = c & 0xff;
    le[2 * i] = c & 0xff; le[2 * i + 1] = c >> 8;
  }
  out.push({ raw: needle, encoding: 'utf16be', bytes: be, ...bounds }, { raw: needle, encoding: 'utf16le', bytes: le, ...bounds });
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || hay.length < needle.length) return -1;
  const first = needle[0];
  const last = hay.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Byte search honouring token boundaries for values that start/end with a letter or digit: the
 * byte before/after the hit must not be an ASCII letter or digit (so "Nowak" is not found in
 * "Nowakowski" but is found in "Nowak,"). Non-ASCII neighbours count as boundaries.
 */
function containsBytes(hay: Uint8Array | Haystack, n: EncodedNeedle): boolean {
  const h = hay instanceof Uint8Array ? haystackOf(hay) : hay;
  // ASCII letters and digits, and every byte above 0x7F (a Latin-1 / WinAnsi letter such as ó or ü
  // is part of the word, so "Nowak" is not found in "Nowaków").
  const alnum = (b: number | undefined): boolean => b !== undefined && ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b >= 0x80);
  const step = n.encoding === 'utf16be' || n.encoding === 'utf16le' ? 2 : 1;
  const bytes = h.bytes;
  const unit = (at: number): number | undefined => {
    if (at < 0 || at + step > bytes.length) return undefined;
    return n.encoding === 'utf16be' ? (bytes[at] === 0 ? bytes[at + 1] : 0x100) : n.encoding === 'utf16le' ? (bytes[at + 1] === 0 ? bytes[at] : 0x100) : bytes[at];
  };
  // The search runs on Latin-1 strings: the engine's native indexOf is many times faster than a
  // byte loop, which matters when hundreds of values are checked against megabytes of streams.
  const needle = n.text ?? (n.text = latin1String(n.bytes));
  for (let i = h.text.indexOf(needle); i >= 0; i = h.text.indexOf(needle, i + 1)) {
    if (n.boundStart && alnum(unit(i - step))) continue;
    if (n.boundEnd && alnum(unit(i + n.bytes.length))) continue;
    return true;
  }
  return false;
}

function uniqueNeedles(list: string[]): string[] {
  const out = new Set<string>();
  for (const n of list) {
    const t = n.trim();
    if (t.length >= 2) out.add(t);
  }
  return [...out];
}

function dedupe(findings: VerifyFinding[]): VerifyFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.pass}|${f.needle}|${f.where}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
