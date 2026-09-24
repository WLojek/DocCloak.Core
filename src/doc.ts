import CFB from 'cfb';
import { normalizeReplacements, type ValueReplacement } from './docx.ts';
import { UnsupportedDocumentError } from './dom/errors.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DocPiece {
  cpStart: number;
  cpEnd: number;
  fc: number;          // raw 4-byte PCD fc value (includes compression flag)
  isCompressed: boolean;
}

interface ParsedDoc {
  container: CFB.CFB$Container;
  wordDocEntry: CFB.CFB$Entry;
  tableEntry: CFB.CFB$Entry;
  wordDoc: Uint8Array;
  wordView: DataView;
  tableDoc: Uint8Array;
  ccpText: number;
  pieces: DocPiece[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUint8Array(content: CFB.CFB$Blob): Uint8Array {
  return content instanceof Uint8Array
    ? content
    : new Uint8Array(content);
}

function align512(n: number): number {
  return Math.ceil(n / 512) * 512;
}

// ─── Piece table parsing ─────────────────────────────────────────────────────

function parsePieces(
  tableStream: Uint8Array,
  fcClx: number,
  lcbClx: number,
): DocPiece[] {
  const view = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  let offset = fcClx;
  const end = fcClx + lcbClx;

  // Skip Prc (type 0x01) entries
  while (offset < end && view.getUint8(offset) !== 0x02) {
    if (view.getUint8(offset) === 0x01) {
      const cb = view.getInt16(offset + 1, true);
      offset += 3 + cb;
    } else {
      throw new Error('Invalid CLX');
    }
  }
  if (offset >= end || view.getUint8(offset) !== 0x02) {
    throw new Error('Missing piece table');
  }
  offset++; // type byte
  const lcbPcd = view.getUint32(offset, true);
  offset += 4;

  const nPieces = (lcbPcd - 4) / 12;
  if (nPieces !== Math.floor(nPieces) || nPieces <= 0) {
    throw new Error('Bad piece table');
  }

  const cps: number[] = [];
  for (let i = 0; i <= nPieces; i++) {
    cps.push(view.getInt32(offset + i * 4, true));
  }
  const pcdOff = offset + (nPieces + 1) * 4;
  const pieces: DocPiece[] = [];
  for (let i = 0; i < nPieces; i++) {
    const fc = view.getUint32(pcdOff + i * 8 + 2, true);
    pieces.push({
      cpStart: cps[i],
      cpEnd: cps[i + 1],
      fc,
      isCompressed: (fc & 0x40000000) !== 0,
    });
  }
  return pieces;
}

// ─── Build new piece entries from original pieces for a CP range ─────────────

function extractOriginalPieces(
  originalPieces: DocPiece[],
  cpStart: number,
  cpEnd: number,
  newCpStart: number,
): DocPiece[] {
  const result: DocPiece[] = [];
  for (const piece of originalPieces) {
    const oStart = Math.max(cpStart, piece.cpStart);
    const oEnd = Math.min(cpEnd, piece.cpEnd);
    if (oStart >= oEnd) continue;

    const cpDelta = oStart - piece.cpStart;
    // FC formula: (original_raw_fc & 0x3FFFFFFF) + 2*cpDelta, preserving compression flag
    const rawBase = piece.fc & 0x3fffffff;
    const fc = (rawBase + 2 * cpDelta) | (piece.isCompressed ? 0x40000000 : 0);

    result.push({
      cpStart: newCpStart + (oStart - cpStart),
      cpEnd: newCpStart + (oEnd - cpStart),
      fc,
      isCompressed: piece.isCompressed,
    });
  }
  return result;
}

// ─── Build CLX binary from pieces ────────────────────────────────────────────

function buildClx(pieces: DocPiece[]): Uint8Array {
  const n = pieces.length;
  const plcPcdSize = (n + 1) * 4 + n * 8;
  const buf = new Uint8Array(1 + 4 + plcPcdSize);
  const v = new DataView(buf.buffer);

  buf[0] = 0x02; // Pcdt type
  v.setUint32(1, plcPcdSize, true);

  let off = 5;
  // CPs
  for (let i = 0; i <= n; i++) {
    v.setInt32(off, i < n ? pieces[i].cpStart : pieces[n - 1].cpEnd, true);
    off += 4;
  }
  // PCDs: 2 bytes flags + 4 bytes fc + 2 bytes prm
  for (let i = 0; i < n; i++) {
    v.setUint16(off, 0, true); off += 2;       // flags
    v.setUint32(off, pieces[i].fc, true); off += 4; // fc
    v.setUint16(off, 0, true); off += 2;       // prm
  }
  return buf;
}

// ─── Build default FKP pages for replacement text ────────────────────────────

function buildDefaultChpxFkp(fcStart: number, fcEnd: number): Uint8Array {
  const page = new Uint8Array(512);
  const v = new DataView(page.buffer);
  v.setUint32(0, fcStart, true);
  v.setUint32(4, fcEnd, true);
  page[8] = 0;    // rgb[0] = 0 → no CHPX, default formatting
  page[511] = 1;  // crun = 1
  return page;
}

function buildDefaultPapxFkp(fcStart: number, fcEnd: number): Uint8Array {
  const page = new Uint8Array(512);
  const v = new DataView(page.buffer);
  v.setUint32(0, fcStart, true);
  v.setUint32(4, fcEnd, true);
  // rgbx[0]: bOffset=253 (byte pos 506), + 12 bytes PHE (zeros)
  page[8] = 253;
  // PAPX at byte 506: cb2=1 (2 bytes of data = istd only), istd=0 (Normal)
  page[506] = 1;
  page[507] = 0;
  page[508] = 0;
  page[511] = 1;  // cpara = 1
  return page;
}

// ─── Extend PlcBte (chpx or papx) with a new FKP page entry ─────────────────

function extendPlcBte(
  original: Uint8Array,
  newFcStart: number,
  newFcEnd: number,
  newPageNum: number,
): Uint8Array {
  const origLen = original.length;
  const n = (origLen - 4) / 8; // number of original ranges
  const ov = new DataView(original.buffer, original.byteOffset, original.byteLength);

  // New: n+1 ranges → (n+2) FCs + (n+1) page numbers
  const newLen = origLen + 8;
  const buf = new Uint8Array(newLen);
  const bv = new DataView(buf.buffer);

  // Copy original FCs [0..n-1], replace sentinel [n] with newFcStart, add newFcEnd
  for (let i = 0; i < n; i++) {
    bv.setUint32(i * 4, ov.getUint32(i * 4, true), true);
  }
  bv.setUint32(n * 4, newFcStart, true);
  bv.setUint32((n + 1) * 4, newFcEnd, true);

  // Copy original page numbers, add new one
  const origPgOff = (n + 1) * 4;
  const newPgOff = (n + 2) * 4;
  for (let i = 0; i < n; i++) {
    bv.setUint32(newPgOff + i * 4, ov.getUint32(origPgOff + i * 4, true), true);
  }
  bv.setUint32(newPgOff + n * 4, newPageNum, true);

  return buf;
}

// ─── Adjust CPs in a generic PLC structure ───────────────────────────────────

function adjustPlcCPs(
  original: Uint8Array,
  entrySize: number,
  ccpText: number,
  sortedRepls: Array<{ start: number; end: number; replacement: string }>,
  totalDelta: number,
): Uint8Array {
  if (original.length === 0) return original;

  const n = (original.length - 4) / (4 + entrySize);
  if (n !== Math.floor(n) || n <= 0) return original;

  const result = new Uint8Array(original);
  const v = new DataView(result.buffer, result.byteOffset, result.byteLength);

  for (let i = 0; i <= n; i++) {
    const cp = v.getInt32(i * 4, true);
    if (cp >= ccpText) {
      v.setInt32(i * 4, cp + totalDelta, true);
    } else {
      // Adjust by cumulative delta of replacements before this CP
      let delta = 0;
      for (const repl of sortedRepls) {
        if (repl.start >= cp) break;
        if (repl.end <= cp) {
          delta += repl.replacement.length - (repl.end - repl.start);
        }
      }
      if (delta !== 0) {
        v.setInt32(i * 4, cp + delta, true);
      }
    }
  }
  return result;
}

// ─── Read a PLC blob from the table stream ───────────────────────────────────

function readPlcBlob(tableStream: Uint8Array, fc: number, lcb: number): Uint8Array {
  if (lcb <= 0 || fc < 0) return new Uint8Array(0);
  return tableStream.slice(fc, fc + lcb);
}

// ─── FIB base flags (MS-DOC 2.5.1 FibBase) ───────────────────────────────────

/** FibBase.nFib (offset 0x02): file format version; superseded by nFibNew. */
const FIB_NFIB = 0x0002;
/** FibBase flags word A (offset 0x0A). Bit layout, low to high:
 *  fDot 0x0001, fGlsy 0x0002, fComplex 0x0004, fHasPic 0x0008,
 *  cQuickSaves 0x00F0, fEncrypted 0x0100, fWhichTblStm 0x0200,
 *  fReadOnlyRecommended 0x0400, fWriteReservation 0x0800, fExtChar 0x1000,
 *  fLoadOverride 0x2000, fFarEast 0x4000, fObfuscated 0x8000. */
const FIB_FLAGS = 0x000a;
const FIB_F_COMPLEX = 0x0004;
const FIB_CQUICKSAVES_MASK = 0x00f0;
const FIB_CQUICKSAVES_SHIFT = 4;
const FIB_F_ENCRYPTED = 0x0100;
const FIB_F_WHICH_TBL_STM = 0x0200;
/** fObfuscated: XOR obfuscation (only meaningful when fEncrypted is set, but
 *  a file with either bit set is unreadable for us). */
const FIB_F_OBFUSCATED = 0x8000;
/** FibRgFcLcbBlob length prefix cbRgFcLcb (offset 0x98), in 8-byte units.
 *  FibRgCswNew follows it: cswNew (2 bytes) then nFibNew (2 bytes). */
const FIB_CB_RG_FC_LCB = 0x0098;
const FIB_RG_FC_LCB = 0x009a;
/** nFib of Word 2000. From this version on, cQuickSaves MUST be 0xF and no
 *  longer counts incremental saves (MS-DOC 2.5.1). */
const NFIB_WORD_2000 = 0x00d9;

interface FibBase {
  flags: number;
  /** Effective format version: FibRgCswNew.nFibNew when present, else FibBase.nFib. */
  nFib: number;
  whichTable: 0 | 1;
  encrypted: boolean;
  fastSaved: boolean;
}

function readFibBase(view: DataView): FibBase {
  const flags = view.getUint16(FIB_FLAGS, true);
  let nFib = view.getUint16(FIB_NFIB, true);
  // nFibNew supersedes nFib when FibRgCswNew is present.
  if (view.byteLength >= FIB_RG_FC_LCB) {
    const cbRgFcLcb = view.getUint16(FIB_CB_RG_FC_LCB, true);
    const cswNewOff = FIB_RG_FC_LCB + cbRgFcLcb * 8;
    if (cswNewOff + 4 <= view.byteLength && view.getUint16(cswNewOff, true) > 0) {
      nFib = view.getUint16(cswNewOff + 2, true);
    }
  }
  const cQuickSaves = (flags & FIB_CQUICKSAVES_MASK) >> FIB_CQUICKSAVES_SHIFT;
  // fComplex: the last save was incremental. cQuickSaves counts those saves
  // only for Word 97 files; Word 2000+ always writes 0xF there.
  const fastSaved = (flags & FIB_F_COMPLEX) !== 0
    || (nFib < NFIB_WORD_2000 && cQuickSaves > 0);
  const encrypted = (flags & (FIB_F_ENCRYPTED | FIB_F_OBFUSCATED)) !== 0;
  return {
    flags,
    nFib,
    whichTable: (flags & FIB_F_WHICH_TBL_STM) ? 1 : 0,
    encrypted,
    fastSaved,
  };
}

/**
 * Fail closed on files this module cannot redact completely:
 * - encrypted / XOR-obfuscated: the text is ciphertext, detection sees noise
 *   and the export would be the untouched ciphertext (L2);
 * - fast-saved (incremental save): deleted text lives in WordDocument regions
 *   outside the piece table, so it never reaches the detector and cannot be
 *   located for scrubbing (H5). The user has to resave the file in Word.
 */
function assertSupportedFib(fib: FibBase): void {
  if (fib.encrypted) {
    throw new UnsupportedDocumentError(
      'encrypted',
      'This .doc file is encrypted or obfuscated. Remove the password in Word and save it again, or save as .docx.',
    );
  }
  if (fib.fastSaved) {
    throw new UnsupportedDocumentError(
      'fast-saved',
      'This .doc file was fast-saved (incremental save) and may hold deleted text outside the visible document. Open it in Word and Save As, or save as .docx.',
    );
  }
}

/** Result of inspectDoc. */
export interface DocInspection {
  /** fEncrypted or fObfuscated is set: readDocText / writeAnonymizedDoc refuse the file. */
  encrypted: boolean;
  /** fComplex is set (or Word 97 cQuickSaves > 0): readDocText / writeAnonymizedDoc refuse the file. */
  fastSaved: boolean;
  /** Streams that are copied through the export without being redacted. */
  streams: {
    /** Data stream (field data such as hyperlinks, pictures, OLE previews). Scanned and scrubbed in UTF-16LE only. */
    data: boolean;
    /** ObjectPool storage (embedded OLE documents). Not scrubbed. */
    objectPool: boolean;
    /** Macros storage (VBA project). Not scrubbed. */
    macros: boolean;
  };
}

function containerHasPath(container: CFB.CFB$Container, name: string): boolean {
  const needle = name.toLowerCase();
  return container.FullPaths.some((p) => {
    const rel = p.replace(/^Root Entry\//i, '').replace(/\/$/, '').toLowerCase();
    return rel === needle || rel.startsWith(needle + '/');
  });
}

/**
 * Cheap look at a legacy .doc without parsing the piece table: which refusal
 * flags are set and which non-text streams the file carries. Hosts use it to
 * show a warning next to the export (ObjectPool / Macros are copied through
 * unchanged, see writeAnonymizedDoc) or to explain a refusal up front.
 * Throws only when the file is not a .doc at all.
 */
export function inspectDoc(buffer: ArrayBuffer | Uint8Array): DocInspection {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const container = CFB.parse(data);
  const wordDocEntry = CFB.find(container, '/WordDocument') ?? CFB.find(container, 'WordDocument');
  if (!wordDocEntry?.content) throw new Error('Invalid .doc file: missing WordDocument stream');
  const wordDoc = toUint8Array(wordDocEntry.content);
  const view = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
  if (view.byteLength < 0x20 || view.getUint16(0, true) !== 0xa5ec) {
    throw new Error('Invalid .doc file: bad magic number');
  }
  const fib = readFibBase(view);
  return {
    encrypted: fib.encrypted,
    fastSaved: fib.fastSaved,
    streams: {
      data: containerHasPath(container, 'Data'),
      objectPool: containerHasPath(container, 'ObjectPool'),
      macros: containerHasPath(container, 'Macros'),
    },
  };
}

// ─── Shared parsing ──────────────────────────────────────────────────────────

function parseDocStreams(buffer: ArrayBuffer): ParsedDoc {
  const data = new Uint8Array(buffer);
  const container = CFB.parse(data);

  const wordDocEntry = CFB.find(container, '/WordDocument') ?? CFB.find(container, 'WordDocument');
  if (!wordDocEntry?.content) throw new Error('Invalid .doc file: missing WordDocument stream');
  const wordDoc = toUint8Array(wordDocEntry.content);
  const wordView = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);

  const wIdent = wordView.getUint16(0, true);
  if (wIdent !== 0xa5ec) {
    throw new Error('Invalid .doc file: bad magic number');
  }

  const fib = readFibBase(wordView);
  assertSupportedFib(fib);
  const tblName = fib.whichTable ? '1Table' : '0Table';
  const tableEntry = CFB.find(container, '/' + tblName) ?? CFB.find(container, tblName);
  if (!tableEntry?.content) throw new Error(`Invalid .doc file: missing ${tblName} stream`);
  const tableDoc = toUint8Array(tableEntry.content);

  const ccpText = wordView.getInt32(0x004c, true);
  const fcClx = wordView.getInt32(0x01a2, true);
  const lcbClx = wordView.getInt32(0x01a6, true);
  if (lcbClx <= 0 || fcClx < 0) {
    throw new Error('Invalid .doc file: missing CLX data');
  }

  const pieces = parsePieces(tableDoc, fcClx, lcbClx);
  return { container, wordDocEntry, tableEntry, wordDoc, wordView, tableDoc, ccpText, pieces };
}

// ─── Text extraction with CP mapping ─────────────────────────────────────────

interface DocExtraction {
  /** Normalized plain text (whole document: main text plus footnotes, headers, comments) */
  text: string;
  /** For each character of `text`, the CP (character position) it came from */
  cpMap: number[];
}

/**
 * Decode every piece in the piece table (main text and all subdocuments:
 * footnotes, headers/footers, comments, endnotes, text boxes) and normalize
 * Word's structural control characters, keeping a map from each normalized
 * character back to its CP so replacements can be located exactly.
 */
function extractDocContent(parsed: ParsedDoc): DocExtraction {
  const { wordDoc, wordView, pieces } = parsed;

  // Pass 1: decode raw characters with their CPs
  const chars: string[] = [];
  const cps: number[] = [];
  for (const piece of pieces) {
    const charCount = piece.cpEnd - piece.cpStart;
    if (charCount <= 0) continue;
    const rawOffset = piece.fc & 0x3fffffff;

    if (piece.isCompressed) {
      const byteOffset = rawOffset / 2;
      for (let j = 0; j < charCount; j++) {
        const bytePos = byteOffset + j;
        if (bytePos >= wordDoc.length) break;
        const ch = cp1252ToChar(wordDoc[bytePos]);
        if (ch) {
          chars.push(ch);
          cps.push(piece.cpStart + j);
        }
      }
    } else {
      const byteOffset = rawOffset;
      for (let j = 0; j < charCount; j++) {
        const pos = byteOffset + j * 2;
        if (pos + 1 >= wordDoc.length) break;
        chars.push(String.fromCharCode(wordView.getUint16(pos, true)));
        cps.push(piece.cpStart + j);
      }
    }
  }

  // Pass 2: normalize control characters. Word's binary format uses them as
  // structural markers (cell mark, line break, page break, field chars).
  // Every kept character records the CP it represents.
  let text = '';
  const cpMap: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.charCodeAt(0);
    if (ch === '\r') {
      text += '\n';
      cpMap.push(cps[i]);
      if (i + 1 < chars.length && chars[i + 1] === '\n') i++; // collapse \r\n
    } else if (code === 0x07) {
      text += '\t';
      cpMap.push(cps[i]);
    } else if (code === 0x0b || code === 0x0c) {
      text += '\n';
      cpMap.push(cps[i]);
    } else if (code <= 0x06 || code === 0x08 || (code >= 0x0e && code <= 0x1f)) {
      // structural marker: dropped from the normalized text
    } else {
      text += ch;
      cpMap.push(cps[i]);
    }
  }

  return { text, cpMap };
}

// ─── Main: write anonymized .doc ─────────────────────────────────────────────

/**
 * Write a redacted copy of a legacy .doc.
 *
 * `replacements` are offsets into the text returned by readDocText. Main-text
 * ranges are swapped for the replacement string through a rewritten piece
 * table; ranges in subdocuments (footnotes, headers, comments) are overwritten
 * in place. `valueReplacements` (same shape as writeAnonymizedDocx) add
 * original values that were not located by offset, e.g. session entries.
 *
 * Every original value (from both sources) is then destroyed wherever else it
 * still occurs as bytes, without moving any structure (see scrubStreamBytes).
 *
 * Refuses (UnsupportedDocumentError) fast-saved and encrypted files, see
 * assertSupportedFib.
 *
 * Copied through untouched: ObjectPool (embedded OLE objects), Macros (VBA)
 * and \x01CompObj. TODO(T196, T199): delete them with CFB.utils.cfb_del once
 * the open-in-Word / LibreOffice experiment proves the result still opens.
 * Until then hosts should call inspectDoc and warn when they are present.
 */
export async function writeAnonymizedDoc(
  buffer: ArrayBuffer,
  replacements: Array<{ start: number; end: number; replacement: string }>,
  valueReplacements: ValueReplacement[] = [],
): Promise<Blob> {
  const parsed = parseDocStreams(buffer);
  const { container, wordDocEntry, tableEntry, wordDoc: origWordDoc, wordView: wv, tableDoc: origTable, ccpText, pieces } = parsed;

  // Author/title/company metadata lives outside the text streams; scrub it always
  scrubOleMetadataStreams(container);

  // ── Map replacement offsets (normalized text space) to CP space ──
  // The offsets the caller passes are positions in the text produced by
  // readDocText. Normalization drops/collapses control characters, so those
  // offsets shift against CPs; apply the recorded map to land exactly.
  const { text, cpMap } = extractDocContent(parsed);
  const cpReplacements: Array<{ start: number; end: number; replacement: string }> = [];
  const originals: string[] = valueReplacements.map((v) => v.value);
  for (const repl of normalizeReplacements(replacements)) {
    if (repl.start < 0 || repl.end > text.length || repl.start >= repl.end) {
      // Offsets that do not match the extracted text indicate a caller bug.
      // Fail closed: never export a file whose redaction we cannot place.
      throw new Error('Replacement offsets do not match the document text');
    }
    originals.push(text.slice(repl.start, repl.end));
    cpReplacements.push({
      start: cpMap[repl.start],
      end: cpMap[repl.end - 1] + 1,
      replacement: repl.replacement,
    });
  }
  const needles = buildScrubNeedles(originals, [
    ...valueReplacements.map((v) => v.replacement),
    ...replacements.map((r) => r.replacement),
  ]);

  if (replacements.length === 0) {
    // No structural rewrite: scrub the string tables and remnant bytes in place
    finalizeDocStreams(container, origWordDoc, origWordDoc.length, origTable, wv, needles);
    wordDocEntry.content = origWordDoc;
    tableEntry.content = origTable;
    const bytes = CFB.write(container, { type: 'array' }) as number[];
    return new Blob([new Uint8Array(bytes)], { type: 'application/msword' });
  }

  // ── Read remaining FIB pointers ──
  const fcPlcfBteChpx = wv.getInt32(0x00fa, true);
  const lcbPlcfBteChpx = wv.getInt32(0x00fe, true);
  const fcPlcfBtePapx = wv.getInt32(0x0102, true);
  const lcbPlcfBtePapx = wv.getInt32(0x0106, true);
  const fcPlcfSed = wv.getInt32(0x00ca, true);
  const lcbPlcfSed = wv.getInt32(0x00ce, true);

  // Main-text replacements go through the piece table (labeled placeholders).
  // Replacements in subdocuments (footnotes, headers, comments) are redacted
  // in place with length-preserving overwrites: shifting CPs there would
  // require rewriting every subdocument PLC, so we destroy the characters
  // instead of substituting placeholders.
  const sorted = cpReplacements.filter((r) => r.end <= ccpText);
  const subDocReplacements = cpReplacements.filter((r) => r.end > ccpText);

  // ── Build new pieces ──
  const appendStart = align512(origWordDoc.length);
  let appendPos = appendStart;
  const newPieces: DocPiece[] = [];
  let newCp = 0;
  let prevEnd = 0;
  const appendedBytes: number[] = [];

  for (const repl of sorted) {
    // Unchanged text before replacement
    if (repl.start > prevEnd) {
      const unchanged = extractOriginalPieces(pieces, prevEnd, repl.start, newCp);
      newPieces.push(...unchanged);
      newCp += repl.start - prevEnd;
    }

    // Replacement text (appended as UTF-16LE, no compression flag)
    const replText = repl.replacement;
    if (replText.length > 0) {
      newPieces.push({
        cpStart: newCp,
        cpEnd: newCp + replText.length,
        fc: appendPos, // Unicode: fc = byte offset directly
        isCompressed: false,
      });
      for (let i = 0; i < replText.length; i++) {
        const code = replText.charCodeAt(i);
        appendedBytes.push(code & 0xff, (code >> 8) & 0xff);
      }
      appendPos += replText.length * 2;
      newCp += replText.length;
    }
    prevEnd = repl.end;
  }

  // Remaining unchanged main text
  if (prevEnd < ccpText) {
    const unchanged = extractOriginalPieces(pieces, prevEnd, ccpText, newCp);
    newPieces.push(...unchanged);
    newCp += ccpText - prevEnd;
  }

  const newCcpText = newCp;
  const totalDelta = newCcpText - ccpText;

  // Non-main-text pieces (footnotes, headers, etc.) - keep original FCs, shift CPs
  for (const piece of pieces) {
    if (piece.cpEnd <= ccpText) continue;
    const clampStart = Math.max(piece.cpStart, ccpText);
    const cpDelta = clampStart - piece.cpStart;
    const rawBase = piece.fc & 0x3fffffff;
    const fc = (rawBase + 2 * cpDelta) | (piece.isCompressed ? 0x40000000 : 0);

    newPieces.push({
      cpStart: clampStart + totalDelta,
      cpEnd: piece.cpEnd + totalDelta,
      fc,
      isCompressed: piece.isCompressed,
    });
  }

  // ── Build new CLX ──
  const newClx = buildClx(newPieces);

  // ── Build extended WordDocument stream ──
  const hasAppendedText = appendedBytes.length > 0;
  const appendedData = new Uint8Array(appendedBytes);
  const fkpStart = align512(appendStart + appendedData.length);
  const chpxPageOff = fkpStart;
  const papxPageOff = fkpStart + 512;
  const newWordDocLen = hasAppendedText ? papxPageOff + 512 : origWordDoc.length;

  const newWordDoc = new Uint8Array(newWordDocLen);
  newWordDoc.set(origWordDoc);
  if (hasAppendedText) {
    newWordDoc.set(appendedData, appendStart);
    newWordDoc.set(buildDefaultChpxFkp(appendStart, appendStart + appendedData.length), chpxPageOff);
    newWordDoc.set(buildDefaultPapxFkp(appendStart, appendStart + appendedData.length), papxPageOff);
  }

  // ── Destroy replaced characters in the copied stream ──
  // The new piece table stops referencing replaced ranges, but the bytes were
  // copied above and would remain recoverable (data remanence). Overwrite them.
  for (const repl of sorted) {
    overwritePieceBytes(newWordDoc, pieces, repl.start, repl.end, 0x20);
  }
  // Subdocument ranges stay referenced by the piece table, so the overwrite
  // itself is the redaction: the characters render as 'X'.
  for (const repl of subDocReplacements) {
    overwritePieceBytes(newWordDoc, pieces, repl.start, repl.end, 0x58);
  }

  // ── Build extended PlcBteChpx / PlcBtePapx ──
  const origPlcChpx = readPlcBlob(origTable, fcPlcfBteChpx, lcbPlcfBteChpx);
  const origPlcPapx = readPlcBlob(origTable, fcPlcfBtePapx, lcbPlcfBtePapx);

  let newPlcChpx: Uint8Array;
  let newPlcPapx: Uint8Array;
  if (hasAppendedText) {
    const chpxPageNum = chpxPageOff / 512;
    const papxPageNum = papxPageOff / 512;
    newPlcChpx = extendPlcBte(origPlcChpx, appendStart, appendStart + appendedData.length, chpxPageNum);
    newPlcPapx = extendPlcBte(origPlcPapx, appendStart, appendStart + appendedData.length, papxPageNum);
  } else {
    newPlcChpx = origPlcChpx;
    newPlcPapx = origPlcPapx;
  }

  // ── Adjust PlcfSed CPs ──
  let newPlcfSed = readPlcBlob(origTable, fcPlcfSed, lcbPlcfSed);
  if (newPlcfSed.length > 0 && totalDelta !== 0) {
    newPlcfSed = adjustPlcCPs(newPlcfSed, 12, ccpText, sorted, totalDelta);
  }

  // ── Build new Table stream ──
  // Append modified structures at the end; update FIB pointers
  const newTableLen = origTable.length + newClx.length + newPlcChpx.length + newPlcPapx.length + newPlcfSed.length;
  const newTable = new Uint8Array(newTableLen);
  newTable.set(origTable);

  let tblOff = origTable.length;
  const newFcClx = tblOff;
  newTable.set(newClx, tblOff); tblOff += newClx.length;

  const newFcPlcChpx = tblOff;
  newTable.set(newPlcChpx, tblOff); tblOff += newPlcChpx.length;

  const newFcPlcPapx = tblOff;
  newTable.set(newPlcPapx, tblOff); tblOff += newPlcPapx.length;

  const newFcPlcfSed = tblOff;
  newTable.set(newPlcfSed, tblOff); tblOff += newPlcfSed.length;

  // ── Update FIB in the new WordDocument stream ──
  const fv = new DataView(newWordDoc.buffer, newWordDoc.byteOffset, newWordDoc.byteLength);
  fv.setInt32(0x004c, newCcpText, true);
  fv.setInt32(0x01a2, newFcClx, true);
  fv.setInt32(0x01a6, newClx.length, true);
  fv.setInt32(0x00fa, newFcPlcChpx, true);
  fv.setInt32(0x00fe, newPlcChpx.length, true);
  fv.setInt32(0x0102, newFcPlcPapx, true);
  fv.setInt32(0x0106, newPlcPapx.length, true);
  if (newPlcfSed.length > 0) {
    fv.setInt32(0x00ca, newFcPlcfSed, true);
    fv.setInt32(0x00ce, newPlcfSed.length, true);
  }

  // ── String tables, Data stream and remnant bytes ──
  // The appended region of newWordDoc holds only replacement text and the
  // FKPs built above, so the byte scrub covers the copied original part.
  finalizeDocStreams(container, newWordDoc, origWordDoc.length, newTable, fv, needles);

  // ── Write back to OLE2 container ──
  // CFB.write sizes streams from entry.size, not content length; keep in sync
  wordDocEntry.content = newWordDoc;
  wordDocEntry.size = newWordDoc.length;
  tableEntry.content = newTable;
  tableEntry.size = newTable.length;

  const output = CFB.write(container, { type: 'array' }) as number[];
  return new Blob([new Uint8Array(output)], { type: 'application/msword' });
}

// ─── Text extraction (read-only) ────────────────────────────────────────────

/**
 * Extract plain text from a legacy .doc (OLE2/Compound File Binary) file.
 * Parses the FIB and piece table to correctly extract text from both
 * compressed (CP1252) and Unicode pieces. The result covers the whole
 * document: main text plus footnotes, headers/footers, and comments, so PII
 * in those regions is visible to detection.
 */
export function readDocText(buffer: ArrayBuffer): string {
  return extractDocContent(parseDocStreams(buffer)).text;
}

// ─── In-place byte redaction ─────────────────────────────────────────────────

/**
 * Overwrite the bytes backing a CP range with a fill character, following the
 * piece table (handles both CP1252 and UTF-16 pieces). Used to destroy
 * original text that would otherwise remain recoverable in the output stream.
 */
function overwritePieceBytes(
  target: Uint8Array,
  pieces: DocPiece[],
  cpStart: number,
  cpEnd: number,
  fillChar: number,
): void {
  for (const piece of pieces) {
    const overlapStart = Math.max(cpStart, piece.cpStart);
    const overlapEnd = Math.min(cpEnd, piece.cpEnd);
    if (overlapStart >= overlapEnd) continue;

    const rawOffset = piece.fc & 0x3fffffff;
    const cpDelta = overlapStart - piece.cpStart;
    const count = overlapEnd - overlapStart;

    if (piece.isCompressed) {
      const byteStart = rawOffset / 2 + cpDelta;
      for (let j = 0; j < count; j++) {
        if (byteStart + j < target.length) target[byteStart + j] = fillChar;
      }
    } else {
      const byteStart = rawOffset + 2 * cpDelta;
      for (let j = 0; j < count; j++) {
        const pos = byteStart + j * 2;
        if (pos + 1 < target.length) {
          target[pos] = fillChar;
          target[pos + 1] = 0;
        }
      }
    }
  }
}

// ─── Metadata scrubbing ──────────────────────────────────────────────────────

// FibRgFcLcb97 (MS-DOC 2.5.5): the fc/lcb pairs start at 0x9A, 8 bytes each,
// so entry i has fc at 0x9A + 8*i and lcb at 0x9E + 8*i.
/** Entry 21: SttbfBkmk, bookmark names. */
const FC_STTBF_BKMK = 0x0142;
const LCB_STTBF_BKMK = 0x0146;
/** Entry 32: SttbfAssoc, author, last-saved-by, template and data-source paths. */
const FC_STTBF_ASSOC = 0x019a;
const LCB_STTBF_ASSOC = 0x019e;
/** Entry 35: AutosaveSource. MS-DOC says lcb MUST be 0; older Word versions
 *  wrote the autosave path here (an Xst). */
const FC_AUTOSAVE_SOURCE = 0x01b2;
const LCB_AUTOSAVE_SOURCE = 0x01b6;
/** Entry 36: GrpXstAtnOwners, comment author names (array of Xst). */
const FC_GRP_XST_ATN_OWNERS = 0x01ba;
const LCB_GRP_XST_ATN_OWNERS = 0x01be;
/** Entry 51: SttbfRMark, revision (tracked change) author names. */
const FC_STTBF_RMARK = 0x0232;
const LCB_STTBF_RMARK = 0x0236;
/** Entry 71: SttbSavedBy, alternating user names and file paths of past saves. */
const FC_STTB_SAVED_BY = 0x02d2;
const LCB_STTB_SAVED_BY = 0x02d6;

/**
 * Space-fill every string of an STTB (MS-DOC 2.9.271) in place. Handles the
 * extended (0xFFFF marker, UTF-16) and the 8-bit layouts; cbExtra bytes after
 * each string are kept. Throws when the layout does not add up so the caller
 * can blank the region wholesale instead of trusting it.
 */
function scrubSttb(table: Uint8Array, fc: number, lcb: number): void {
  const v = new DataView(table.buffer, table.byteOffset + fc, lcb);
  let offset = 0;
  const extended = v.getUint16(0, true) === 0xffff;
  if (extended) offset = 2;
  const count = v.getUint16(offset, true);
  const cbExtra = v.getUint16(offset + 2, true);
  offset += 4;
  if (count > 4096) throw new Error('bad sttb');

  for (let i = 0; i < count; i++) {
    let cch: number;
    if (extended) {
      cch = v.getUint16(offset, true);
      offset += 2;
      if (offset + cch * 2 > lcb) throw new Error('bad sttb');
      for (let j = 0; j < cch; j++) {
        v.setUint16(offset + j * 2, 0x0020, true);
      }
      offset += cch * 2 + cbExtra;
    } else {
      cch = v.getUint8(offset);
      offset += 1;
      if (offset + cch > lcb) throw new Error('bad sttb');
      for (let j = 0; j < cch; j++) {
        v.setUint8(offset + j, 0x20);
      }
      offset += cch + cbExtra;
    }
    if (offset > lcb) throw new Error('bad sttb');
  }
}

/**
 * Space-fill every Xst (cch + UTF-16 chars, MS-DOC 2.9.352) of a packed group
 * such as GrpXstAtnOwners. Throws on a layout mismatch.
 */
function scrubXstGroup(table: Uint8Array, fc: number, lcb: number): void {
  const v = new DataView(table.buffer, table.byteOffset + fc, lcb);
  let offset = 0;
  while (offset + 2 <= lcb) {
    const cch = v.getUint16(offset, true);
    offset += 2;
    if (offset + cch * 2 > lcb) throw new Error('bad xst group');
    for (let j = 0; j < cch; j++) v.setUint16(offset + j * 2, 0x0020, true);
    offset += cch * 2;
  }
  if (offset !== lcb) throw new Error('bad xst group');
}

/**
 * Read the fc/lcb pair, run `scrub` over the region and, if the structure
 * cannot be parsed, zero the region and disconnect it via the FIB. Offsets
 * of everything else in the Table stream are untouched either way.
 */
function scrubTableRegion(
  table: Uint8Array,
  fibView: DataView,
  fcOffset: number,
  lcbOffset: number,
  scrub: (table: Uint8Array, fc: number, lcb: number) => void,
): void {
  if (lcbOffset + 4 > fibView.byteLength) return;
  const fc = fibView.getInt32(fcOffset, true);
  const lcb = fibView.getInt32(lcbOffset, true);
  if (lcb <= 0 || fc < 0 || fc + lcb > table.length) return;
  try {
    scrub(table, fc, lcb);
  } catch {
    table.fill(0, fc, fc + lcb);
    fibView.setInt32(lcbOffset, 0, true);
  }
}

/**
 * Zero the region and set its lcb to 0. Used for AutosaveSource, whose lcb
 * MS-DOC requires to be 0 anyway; nothing references the bytes afterwards.
 */
function blankTableRegion(table: Uint8Array, fibView: DataView, fcOffset: number, lcbOffset: number): void {
  if (lcbOffset + 4 > fibView.byteLength) return;
  const fc = fibView.getInt32(fcOffset, true);
  const lcb = fibView.getInt32(lcbOffset, true);
  if (lcb <= 0 || fc < 0 || fc + lcb > table.length) return;
  table.fill(0, fc, fc + lcb);
  fibView.setInt32(lcbOffset, 0, true);
}

/**
 * Scrub every Table-stream string table that carries people or paths:
 * SttbfAssoc (author, last-saved-by, template), SttbfRMark (revision
 * authors), GrpXstAtnOwners (comment authors), SttbfBkmk (bookmark names),
 * SttbSavedBy (save history) and the AutosaveSource path. Strings are
 * space-filled in place so indices referenced from CHPX / PLCs stay valid.
 */
function scrubTableStringTables(table: Uint8Array, fibView: DataView): void {
  scrubTableRegion(table, fibView, FC_STTBF_ASSOC, LCB_STTBF_ASSOC, scrubSttb);
  scrubTableRegion(table, fibView, FC_STTBF_RMARK, LCB_STTBF_RMARK, scrubSttb);
  scrubTableRegion(table, fibView, FC_STTBF_BKMK, LCB_STTBF_BKMK, scrubSttb);
  scrubTableRegion(table, fibView, FC_STTB_SAVED_BY, LCB_STTB_SAVED_BY, scrubSttb);
  scrubTableRegion(table, fibView, FC_GRP_XST_ATN_OWNERS, LCB_GRP_XST_ATN_OWNERS, scrubXstGroup);
  blankTableRegion(table, fibView, FC_AUTOSAVE_SOURCE, LCB_AUTOSAVE_SOURCE);
}

// ─── Length-preserving byte scrub ────────────────────────────────────────────

/** Values shorter than this are not searched for: too many accidental hits. */
const MIN_SCRUB_NEEDLE = 4;

/**
 * Derive the byte-scrub needles from the original values: each value itself,
 * each whitespace-separated token and each token stripped of surrounding
 * punctuation, keeping those of at least MIN_SCRUB_NEEDLE characters.
 * Matching is case-insensitive (see scrubStreamBytes), which covers every
 * case variant (as written, lower, UPPER, Capitalised) in one pass.
 *
 * A needle that occurs (case-insensitively) inside one of the `replacements`
 * is dropped: a token such as "Person" from "Leaky Person" would otherwise
 * blank the "[PERSON_1]" placeholder, and a surrogate that keeps a word of
 * the original ("Smith & Co" -> "Nowak & Co") would lose it. The full
 * original value is never dropped.
 */
export function buildScrubNeedles(originals: string[], replacements: string[] = []): string[] {
  const protectedText = replacements.filter((r) => typeof r === 'string').map((r) => r.toLowerCase());
  const values = new Set<string>();
  const out = new Set<string>();
  const add = (s: string, isValue: boolean): void => {
    const t = s.trim();
    if (t.length < MIN_SCRUB_NEEDLE) return;
    if (isValue) values.add(t);
    else if (values.has(t)) return;
    else {
      const lower = t.toLowerCase();
      if (protectedText.some((r) => r.includes(lower))) return;
    }
    out.add(t);
  };
  for (const original of originals) {
    if (typeof original !== 'string') continue;
    add(original, true);
  }
  for (const original of originals) {
    if (typeof original !== 'string') continue;
    for (const token of original.split(/\s+/)) {
      add(token, false);
      add(token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), false);
    }
  }
  // Longest first so a full value is blanked before its tokens are considered
  return [...out].sort((a, b) => b.length - a.length);
}

let cp1252Reverse: Map<number, number> | undefined;
/** Reverse of CP1252_MAP (declared below), built on first use. */
function cp1252ReverseMap(): Map<number, number> {
  if (!cp1252Reverse) {
    cp1252Reverse = new Map(Object.entries(CP1252_MAP).map(([byte, code]) => [code, Number(byte)]));
  }
  return cp1252Reverse;
}

/** Encode to cp1252 bytes, or null when a character has no cp1252 form. */
function encodeCp1252(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      out[i] = code;
    } else {
      const mapped = cp1252ReverseMap().get(code);
      if (mapped === undefined) return null;
      out[i] = mapped;
    }
  }
  return out;
}

function foldCodeUnit(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code + 0x20;
  if (code < 0x80) return code;
  return String.fromCharCode(code).toLowerCase().charCodeAt(0);
}

function foldCp1252Byte(byte: number): number {
  if (byte >= 0x41 && byte <= 0x5a) return byte + 0x20;
  if (byte < 0x80) return byte;
  return foldCodeUnit(cp1252ToChar(byte).charCodeAt(0) || byte);
}

/**
 * Overwrite every case-insensitive occurrence of `needle` in `bytes` with
 * spaces of the same encoding. UTF-16LE: units are read at every byte
 * offset (strings in the Table stream are not always 2-byte aligned) and
 * replaced by 0x20 0x00; cp1252: bytes replaced by 0x20. Returns the number
 * of hits. Stream length never changes.
 */
export function scrubStreamBytes(bytes: Uint8Array, needle: string, encoding: 'utf16le' | 'cp1252'): number {
  const folded: number[] = [];
  if (encoding === 'cp1252') {
    const encoded = encodeCp1252(needle);
    if (!encoded) return 0;
    for (const b of encoded) folded.push(foldCp1252Byte(b));
  } else {
    for (let i = 0; i < needle.length; i++) folded.push(foldCodeUnit(needle.charCodeAt(i)));
  }
  const n = folded.length;
  if (n === 0) return 0;
  const unit = encoding === 'utf16le' ? 2 : 1;
  const span = n * unit;
  const first = folded[0];
  let hits = 0;

  for (let i = 0; i + span <= bytes.length; i++) {
    // Fast reject on the first unit before folding the rest
    const u0 = unit === 2 ? bytes[i] | (bytes[i + 1] << 8) : bytes[i];
    if ((unit === 2 ? foldCodeUnit(u0) : foldCp1252Byte(u0)) !== first) continue;
    let match = true;
    for (let j = 1; j < n; j++) {
      const pos = i + j * unit;
      const u = unit === 2 ? bytes[pos] | (bytes[pos + 1] << 8) : bytes[pos];
      if ((unit === 2 ? foldCodeUnit(u) : foldCp1252Byte(u)) !== folded[j]) { match = false; break; }
    }
    if (!match) continue;
    for (let j = 0; j < n; j++) {
      bytes[i + j * unit] = 0x20;
      if (unit === 2) bytes[i + j * unit + 1] = 0x00;
    }
    hits++;
    i += span - 1;
  }
  return hits;
}

/**
 * Last pass over the three streams before the container is written:
 * 1. string tables in Table (scrubTableStringTables);
 * 2. remnant bytes of every original value (buildScrubNeedles):
 *    - WordDocument, first `wordDocScanLength` bytes (the copied original;
 *      the appended replacement text is excluded), UTF-16LE only;
 *    - Table, UTF-16LE and cp1252 (STTB remnants, 8-bit layouts);
 *    - Data (hyperlink field data, OLE previews), UTF-16LE only.
 * cp1252 is deliberately NOT searched in Data or WordDocument: a 4-letter
 * name has a real chance (about 2e-4 per name per MB) of matching bytes
 * inside embedded JPEG/PNG data, and overwriting those would corrupt the
 * picture. UTF-16 patterns (letter, 0x00, letter, 0x00) do not occur in
 * compressed image data. Every overwrite is length-preserving.
 */
function finalizeDocStreams(
  container: CFB.CFB$Container,
  wordDoc: Uint8Array,
  wordDocScanLength: number,
  table: Uint8Array,
  fibView: DataView,
  needles: string[],
): void {
  scrubTableStringTables(table, fibView);
  if (needles.length === 0) return;

  const wordDocOriginal = wordDoc.subarray(0, Math.min(wordDocScanLength, wordDoc.length));
  for (const needle of needles) {
    scrubStreamBytes(wordDocOriginal, needle, 'utf16le');
    scrubStreamBytes(table, needle, 'utf16le');
    scrubStreamBytes(table, needle, 'cp1252');
  }

  const dataEntry = CFB.find(container, '/Data') ?? CFB.find(container, 'Data');
  if (dataEntry?.content) {
    const data = toUint8Array(dataEntry.content);
    for (const needle of needles) scrubStreamBytes(data, needle, 'utf16le');
    dataEntry.content = data;
    dataEntry.size = data.length;
  }
}

const OLE_META_STREAMS = ['SummaryInformation', 'DocumentSummaryInformation'];

/**
 * Scrub the OLE property-set streams (author, title, company, manager, ...).
 * String values are space-filled in place, preserving the structure exactly.
 * If a stream cannot be parsed, it is deleted from the container instead of
 * being passed through with unknown content.
 */
function scrubOleMetadataStreams(container: CFB.CFB$Container): void {
  for (const name of OLE_META_STREAMS) {
    let path = '/' + name;
    let entry = CFB.find(container, path);
    if (!entry) {
      path = name;
      entry = CFB.find(container, path);
    }
    if (!entry?.content) continue;

    const bytes = toUint8Array(entry.content);
    try {
      scrubPropertySetStrings(bytes);
      entry.content = bytes;
      entry.size = bytes.length;
    } catch {
      CFB.utils.cfb_del(container, path);
    }
  }
}

const VT_LPSTR = 0x001e;
const VT_LPWSTR = 0x001f;
const VT_VECTOR = 0x1000;

/** Space-fill every string-typed property value in an OLE property set stream. */
function scrubPropertySetStrings(bytes: Uint8Array): void {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint16(0, true) !== 0xfffe) throw new Error('bad property set');
  const sectionCount = v.getUint32(24, true);
  if (sectionCount < 1 || sectionCount > 4) throw new Error('bad section count');

  for (let s = 0; s < sectionCount; s++) {
    const sectionOffset = v.getUint32(28 + s * 20 + 16, true);
    const propCount = v.getUint32(sectionOffset + 4, true);
    if (propCount > 4096) throw new Error('bad property count');

    for (let p = 0; p < propCount; p++) {
      const propId = v.getUint32(sectionOffset + 8 + p * 8, true);
      const propOffset = v.getUint32(sectionOffset + 8 + p * 8 + 4, true);
      if (propId === 0 || propId === 1) continue; // dictionary / codepage
      scrubPropertyValue(bytes, v, sectionOffset + propOffset);
    }
  }
}

function scrubPropertyValue(bytes: Uint8Array, v: DataView, offset: number): void {
  const type = v.getUint32(offset, true) & 0xffff;
  if (type === VT_LPSTR || type === VT_LPWSTR) {
    scrubPropertyString(bytes, v, offset + 4, type === VT_LPWSTR);
  } else if (type === (VT_VECTOR | VT_LPSTR) || type === (VT_VECTOR | VT_LPWSTR)) {
    const count = v.getUint32(offset + 4, true);
    if (count > 4096) throw new Error('bad vector');
    let cursor = offset + 8;
    for (let i = 0; i < count; i++) {
      cursor = scrubPropertyString(bytes, v, cursor, type === (VT_VECTOR | VT_LPWSTR));
    }
  }
}

/**
 * Space-fill one length-prefixed property string, keeping the terminator.
 * Returns the offset just past the string (padded to 4 bytes, as vector
 * elements are).
 */
function scrubPropertyString(bytes: Uint8Array, v: DataView, offset: number, wide: boolean): number {
  const cch = v.getUint32(offset, true);
  const dataStart = offset + 4;
  const byteLength = wide ? cch * 2 : cch;
  if (cch > 0x100000 || dataStart + byteLength > bytes.length) throw new Error('bad string');

  if (wide) {
    for (let i = 0; i + 1 < cch; i++) {
      bytes[dataStart + i * 2] = 0x20;
      bytes[dataStart + i * 2 + 1] = 0;
    }
  } else {
    for (let i = 0; i + 1 < cch; i++) {
      bytes[dataStart + i] = 0x20;
    }
  }
  return dataStart + Math.ceil(byteLength / 4) * 4;
}

// ─── CP1252 decoding ─────────────────────────────────────────────────────────

const CP1252_MAP: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e,
  0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
  0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152,
  0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
  0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function cp1252ToChar(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) {
    const mapped = CP1252_MAP[byte];
    return mapped ? String.fromCharCode(mapped) : '';
  }
  return String.fromCharCode(byte);
}
