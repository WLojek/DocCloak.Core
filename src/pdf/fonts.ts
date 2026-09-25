/**
 * @doccloak/core/pdf - font model (T209).
 *
 * A LoadedFont turns the bytes of a text-showing operand into glyphs (code,
 * Unicode, advance width) and, in the other direction, tells whether a
 * placeholder can be written with the same font and how to encode it.
 *
 * Decoding order (as pdf.js and the spec, 9.10.2): ToUnicode CMap first,
 * then the encoding (base encoding + /Differences) through the Adobe Glyph
 * List, then for composite fonts the CID-to-Unicode of Identity orderings is
 * unknown, so a code with no ToUnicode entry yields '' (notdef for our
 * purposes) and the page is later cross-checked against pdf.js.
 *
 * Encodability (placeholders in the original font): a character is
 * showable when a code maps to it AND that code is known to have a glyph:
 * either the code was shown somewhere in the document with this font (the
 * subset contains it) or the font is a non-embedded standard 14 face whose
 * AFM lists the glyph. This rule never guesses about subset contents.
 */

import type { PDFContext, PDFObject } from './objects.ts';
import {
  PDFName, PDFNumber, PDFArray, PDFStream, PDFDict,
  decodeStream, getArray, getDict, getName, getNumber, getStream, itemsOf, numbersOf, refKey, refOf, resolve,
} from './objects.ts';
import {
  STANDARD_ENCODING, WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING, SYMBOL_ENCODING, ZAPF_DINGBATS_ENCODING, encodingByName,
} from './encodings.ts';
import type { EncodingTable } from './encodings.ts';
import { glyphNameToUnicode, unicodeToGlyphName } from './glyphlist.ts';
import { parseCMap, predefinedCMap, splitCodes, cidOf, unicodeOf, CMapParseError } from './cmap.ts';
import { foldGlyphText } from './oracle.ts';
import type { CMap } from './cmap.ts';
import { loadStandardMetrics, standardFontFor } from './standard-metrics.ts';
import type { StandardMetrics } from './standard-metrics.ts';
import type { FontStyle, Matrix } from './types.ts';
import { styleFromFontName } from './fallback-fonts.ts';

export type FontSubtype = 'Type1' | 'MMType1' | 'TrueType' | 'Type3' | 'Type0' | 'unknown';

export interface DecodedGlyph {
  code: number;
  /** Byte length of the code in the operand. */
  length: number;
  /** Byte offset of the code in the operand. */
  offset: number;
  /** '' when unmapped. */
  unicode: string;
  /** Advance width in 1/1000 text space units (Type3 already through FontMatrix). */
  width: number;
  /** True when the code is a single byte 32 in a simple font (word spacing applies). */
  isSpaceCode: boolean;
  /** True when the encoding names the glyph /.notdef: a viewer draws nothing there (blank by design, not unreadable). */
  notdef?: boolean;
}

export interface FontProblem {
  /** Machine code for the writer's safety decisions. */
  code: 'predefined-cmap' | 'usecmap' | 'bad-cmap' | 'vertical' | 'no-unicode' | 'unknown-subtype';
  message: string;
}

export interface LoadedFont {
  key: string;
  dict: PDFDict;
  subtype: FontSubtype;
  baseFont: string;
  composite: boolean;
  type3: boolean;
  /** Type3 glyph space to text space. */
  fontMatrix: Matrix | null;
  style: FontStyle;
  embedded: boolean;
  symbolic: boolean;
  vertical: boolean;
  /** Problems that make text of this font unsafe to edit (the page falls back to raster). */
  problems: FontProblem[];
  /** Codes shown somewhere in the document with this font (filled by the extractor). */
  usedCodes: Set<number>;
  /** Codes -> glyph name for simple fonts (after Differences); null for composite fonts. */
  encodingNames: ReadonlyArray<string | undefined> | null;
  toUnicode: CMap | null;
  /** Byte length of every code: 1 for simple fonts; for composite fonts by the CMap (may vary). */
  decode(bytes: Uint8Array): DecodedGlyph[];
  /** Width in 1/1000 units of one code. */
  widthOfCode(code: number): number;
  /** Encode a placeholder in this font, or null when any character cannot be shown safely. */
  encode(text: string): { bytes: Uint8Array; width: number; codes: number[] } | null;
  /** Byte length of a code as the font's encoding defines it (1 for simple fonts; the encoding CMap for composite ones). */
  codeLength(code: number): number;
  /** Ascent/descent hints in 1/1000 units (for fitting), best effort. */
  ascent: number;
  descent: number;
}

const STANDARD_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType', 'Type3', 'Type0']);

/** Load (and cache by ref) the font at /Resources /Font /<name>. */
export function loadFont(
  ctx: PDFContext,
  fontsDict: PDFDict | undefined,
  resourceName: string,
  cache: Map<string, LoadedFont>,
): LoadedFont | undefined {
  if (!fontsDict) return undefined;
  const ref = refOf(fontsDict, resourceName);
  const dictObj = resolve(ctx, fontsDict.get(PDFName.of(resourceName)));
  const dict = dictObj instanceof PDFStream ? dictObj.dict : dictObj;
  if (!(dict && typeof (dict as PDFDict).get === 'function')) return undefined;
  const key = ref ? refKey(ref) : `direct:${resourceName}:${(dict as PDFDict).toString()}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const font = buildFont(ctx, dict as PDFDict, key);
  cache.set(key, font);
  return font;
}

function buildFont(ctx: PDFContext, dict: PDFDict, key: string): LoadedFont {
  const subtypeName = getName(ctx, dict, 'Subtype') ?? '';
  const subtype: FontSubtype = STANDARD_SUBTYPES.has(subtypeName) ? (subtypeName as FontSubtype) : 'unknown';
  const baseFont = getName(ctx, dict, 'BaseFont') ?? '';
  const problems: FontProblem[] = [];
  if (subtype === 'unknown') problems.push({ code: 'unknown-subtype', message: `font subtype /${subtypeName || '?'} is not supported` });

  const composite = subtype === 'Type0';
  const type3 = subtype === 'Type3';
  const descendant = composite ? firstDescendant(ctx, dict) : undefined;
  const descriptor = getDict(ctx, descendant ?? dict, 'FontDescriptor');
  const flags = getNumber(ctx, descriptor, 'Flags') ?? 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  const embedded = !!(descriptor && (getStream(ctx, descriptor, 'FontFile') || getStream(ctx, descriptor, 'FontFile2') || getStream(ctx, descriptor, 'FontFile3')));
  const style = styleFromFontName(
    baseFont,
    flags,
    getNumber(ctx, descriptor, 'ItalicAngle'),
    getNumber(ctx, descriptor, 'StemV'),
    getNumber(ctx, descriptor, 'FontWeight'),
  );
  const ascent = getNumber(ctx, descriptor, 'Ascent') ?? 750;
  const descent = getNumber(ctx, descriptor, 'Descent') ?? -250;

  // ToUnicode
  let toUnicode: CMap | null = null;
  const tuStream = getStream(ctx, dict, 'ToUnicode');
  if (tuStream) {
    try {
      toUnicode = parseCMap(decodeStream(ctx, tuStream));
    } catch (err) {
      const usecmap = err instanceof CMapParseError && /usecmap/.test(err.message);
      problems.push({ code: usecmap ? 'usecmap' : 'bad-cmap', message: `ToUnicode CMap unreadable: ${(err as Error).message}` });
      toUnicode = null;
    }
  }

  // A Type3 font draws its glyphs from /CharProcs, whatever its /BaseFont says: standard-14 metrics never apply.
  const standard = !embedded && !type3 ? standardFontFor(baseFont) : undefined;
  const metrics: StandardMetrics | undefined = standard ? loadStandardMetrics(standard) : undefined;

  if (composite) {
    return buildCompositeFont(ctx, dict, descendant, key, { subtype, baseFont, problems, style, embedded, symbolic, toUnicode, ascent, descent, flags, metrics });
  }

  // ---- simple fonts (Type1, TrueType, Type3) ----
  const fontMatrix: Matrix | null = type3 ? matrixOf(numbersOf(ctx, getArray(ctx, dict, 'FontMatrix'))) : null;
  const builtin = symbolic && embedded && (subtype === 'Type1' || subtype === 'MMType1') ? type1BuiltinEncoding(ctx, descriptor) : undefined;
  const { names: encodingNames, base: baseEncodingNames } = simpleEncoding(ctx, dict, { subtype, symbolic, nonsymbolic: (flags & 32) !== 0, embedded, baseFont, metrics, type3, builtin });

  // Widths
  const firstChar = getNumber(ctx, dict, 'FirstChar');
  const widthsArr = numbersOf(ctx, getArray(ctx, dict, 'Widths'));
  const missingWidth = getNumber(ctx, descriptor, 'MissingWidth') ?? 0;
  const scale = type3 && fontMatrix ? fontMatrix[0] * 1000 : 1;
  // AFM width of the glyph at a code; a /Differences name the AFM does not know (/.notdef, /gNN)
  // advances like the base encoding's glyph at that code, as pdf.js draws it.
  const metricWidth = (code: number): number | undefined => {
    if (!metrics) return undefined;
    const g = encodingNames[code];
    const w = g ? metrics.widthOfGlyph(g) : undefined;
    if (w !== undefined) return w;
    const b = baseEncodingNames[code];
    return b ? metrics.widthOfGlyph(b) : undefined;
  };
  const widthOfCode = (code: number): number => {
    if (widthsArr.length > 0 && firstChar !== undefined) {
      const i = code - firstChar;
      if (i >= 0 && i < widthsArr.length) {
        const w = widthsArr[i];
        // Some producers write zero widths for glyphs they never use; keep zero (spec: advance 0).
        return w * scale;
      }
      if (type3) return 0;
      if (metrics) return metricWidth(code) ?? missingWidth;
      return missingWidth;
    }
    if (metrics) return metricWidth(code) ?? missingWidth;
    return missingWidth * scale || 0;
  };

  const unicodeForCode = (code: number): string => {
    if (toUnicode) {
      // An empty destination (<41> <>) is no mapping: pdf.js falls through to the encoding.
      const u = unicodeOf(toUnicode, code);
      if (u !== undefined && u !== '') return foldGlyphText(u);
    }
    const g = encodingNames[code];
    if (g) {
      const u = glyphNameToUnicode(g);
      if (u !== undefined) return foldGlyphText(u);
    }
    // Non-symbolic fonts without an entry: codes in the printable ASCII range mean themselves.
    if (!symbolic && !toUnicode && code >= 0x20 && code <= 0x7e && encodingNames[code] === undefined) {
      return String.fromCharCode(code);
    }
    return '';
  };

  const usedCodes = new Set<number>();
  const decode = (bytes: Uint8Array): DecodedGlyph[] => {
    const out: DecodedGlyph[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const code = bytes[i];
      out.push({ code, length: 1, offset: i, unicode: unicodeForCode(code), width: widthOfCode(code), isSpaceCode: code === 32, notdef: encodingNames[code] === '.notdef' });
    }
    return out;
  };

  // Reverse map for encoding placeholders: unicode -> code, lowest code wins. A viewer draws a
  // code through the ENCODING (glyph name), never through ToUnicode, so the reverse map is built
  // from the glyph names; a code whose ToUnicode entry disagrees with its glyph is never reused
  // (the placeholder would read one way in the text layer and look another way on the page).
  const consistent = (code: number, u: string): boolean => {
    if (!toUnicode) return true;
    const tu = unicodeOf(toUnicode, code);
    return tu === undefined || tu === '' || tu === u;
  };
  const reverse = new Map<string, number>();
  for (let code = 0; code < 256; code++) {
    const g = encodingNames[code];
    const u = g ? glyphNameToUnicode(g) : undefined;
    if (!u || !consistent(code, u)) continue;
    if (!reverse.has(u)) reverse.set(u, code);
  }

  const glyphKnown = (code: number): boolean => {
    if (usedCodes.has(code)) return true;
    if (metrics && !embedded) {
      const g = encodingNames[code];
      return !!g && metrics.hasGlyph(g);
    }
    return false;
  };

  const encode = (text: string): { bytes: Uint8Array; width: number; codes: number[] } | null => {
    const codes: number[] = [];
    let width = 0;
    for (const ch of text) {
      let code = reverse.get(ch);
      if (code === undefined && metrics && !embedded) {
        // Non-embedded standard font: any glyph of the AFM reachable through the encoding.
        const g = unicodeToGlyphName(ch);
        if (g) {
          const idx = encodingNames.indexOf(g);
          if (idx >= 0 && consistent(idx, ch)) code = idx;
        }
      }
      if (code === undefined || !glyphKnown(code)) return null;
      // A code the font advances by nothing (a /Widths hole) would pile the placeholder up.
      const w = widthOfCode(code);
      if (w <= 0 && !/\p{M}/u.test(ch)) return null;
      codes.push(code);
      width += w;
    }
    return { bytes: Uint8Array.from(codes), width, codes };
  };

  return {
    key, dict, subtype, baseFont, composite: false, type3, fontMatrix, style, embedded, symbolic, vertical: false,
    problems, usedCodes, encodingNames, toUnicode, decode, widthOfCode, encode, codeLength: () => 1, ascent, descent,
  };
}

interface CommonParts {
  subtype: FontSubtype; baseFont: string; problems: FontProblem[]; style: FontStyle; embedded: boolean; symbolic: boolean;
  toUnicode: CMap | null; ascent: number; descent: number; flags: number; metrics: StandardMetrics | undefined;
}

function buildCompositeFont(ctx: PDFContext, dict: PDFDict, descendant: PDFDict | undefined, key: string, c: CommonParts): LoadedFont {
  const { problems, toUnicode } = c;
  // Encoding CMap: name (predefined) or stream (embedded)
  const encObj = resolve(ctx, dict.get(PDFName.of('Encoding')));
  let cmap: CMap | null = null;
  if (encObj instanceof PDFName) {
    const name = encObj.decodeText();
    cmap = predefinedCMap(name) ?? null;
    if (!cmap) problems.push({ code: 'predefined-cmap', message: `predefined CMap /${name} is not available` });
  } else if (encObj instanceof PDFStream) {
    try {
      cmap = parseCMap(decodeStream(ctx, encObj));
    } catch (err) {
      const usecmap = err instanceof CMapParseError && /usecmap/.test(err.message);
      problems.push({ code: usecmap ? 'usecmap' : 'bad-cmap', message: `encoding CMap unreadable: ${(err as Error).message}` });
    }
  } else {
    problems.push({ code: 'bad-cmap', message: 'Type0 font without /Encoding' });
  }
  if (cmap?.vertical) problems.push({ code: 'vertical', message: 'vertical writing mode is not supported' });

  // Widths: /W [ c [w1 w2 ...] | cfirst clast w ], /DW default 1000
  const dw = getNumber(ctx, descendant, 'DW') ?? 1000;
  const widthByCid = new Map<number, number>();
  const wArr = getArray(ctx, descendant, 'W');
  if (wArr) {
    const items = itemsOf(ctx, wArr);
    let i = 0;
    while (i < items.length) {
      const a = items[i];
      if (!(a instanceof PDFNumber)) { i++; continue; }
      const b = items[i + 1];
      if (b instanceof PDFArray) {
        const ws = numbersOf(ctx, b);
        const start = a.asNumber();
        for (let k = 0; k < ws.length; k++) widthByCid.set(start + k, ws[k]);
        i += 2;
      } else if (b instanceof PDFNumber && items[i + 2] instanceof PDFNumber) {
        const first = a.asNumber();
        const last = b.asNumber();
        const w = (items[i + 2] as PDFNumber).asNumber();
        if (last - first <= 65535) for (let cid = first; cid <= last; cid++) widthByCid.set(cid, w);
        i += 3;
      } else {
        i++;
      }
    }
  }
  const widthOfCode = (code: number): number => {
    if (!cmap) return dw;
    const cid = cidOf(cmap, code);
    return widthByCid.get(cid) ?? dw;
  };

  const unicodeForCode = (code: number): string => {
    if (toUnicode) {
      const u = unicodeOf(toUnicode, code);
      if (u !== undefined && u !== '') return foldGlyphText(u);
    }
    return '';
  };
  if (!toUnicode) problems.push({ code: 'no-unicode', message: 'composite font without ToUnicode: its text cannot be read' });

  const usedCodes = new Set<number>();
  const decode = (bytes: Uint8Array): DecodedGlyph[] => {
    if (!cmap) {
      // Unknown code length: treat as 2-byte (the overwhelmingly common case) but the font is already flagged.
      const out: DecodedGlyph[] = [];
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        out.push({ code, length: 2, offset: i, unicode: unicodeForCode(code), width: dw, isSpaceCode: false });
      }
      return out;
    }
    return splitCodes(cmap, bytes).map((d) => ({
      code: d.code,
      length: d.length,
      offset: d.offset,
      unicode: unicodeForCode(d.code),
      width: widthOfCode(d.code),
      isSpaceCode: d.length === 1 && d.code === 32,
    }));
  };

  // Reverse ToUnicode: unicode -> (code, length). Lowest code wins. The byte length of a code is
  // the encoding CMap's (Identity-H: always 2), never the ToUnicode CMap's, which some producers
  // declare with a 1-byte codespace.
  const reverse = new Map<string, { code: number; length: number }>();
  if (toUnicode?.unicodeMap && cmap) {
    const entries = [...toUnicode.unicodeMap.entries()].sort((x, y) => x[0] - y[0]);
    for (const [code, u] of entries) {
      if (u && !reverse.has(u)) reverse.set(u, { code, length: codeLengthFor(cmap, code) });
    }
  }

  const encode = (text: string): { bytes: Uint8Array; width: number; codes: number[] } | null => {
    if (!cmap) return null;
    const bytes: number[] = [];
    const codes: number[] = [];
    let width = 0;
    for (const ch of text) {
      const hit = reverse.get(ch);
      if (!hit || !usedCodes.has(hit.code)) return null;
      const w = widthOfCode(hit.code);
      if (w <= 0 && !/\p{M}/u.test(ch)) return null;
      for (let k = hit.length - 1; k >= 0; k--) bytes.push((hit.code >> (8 * k)) & 0xff);
      codes.push(hit.code);
      width += w;
    }
    return { bytes: Uint8Array.from(bytes), width, codes };
  };

  return {
    key, dict, subtype: c.subtype, baseFont: c.baseFont, composite: true, type3: false, fontMatrix: null, style: c.style,
    embedded: c.embedded, symbolic: c.symbolic, vertical: !!cmap?.vertical, problems, usedCodes, encodingNames: null,
    toUnicode, decode, widthOfCode, encode, ascent: c.ascent, descent: c.descent,
    codeLength: (code) => (cmap ? codeLengthFor(cmap, code) : toUnicode ? codeLengthFor(toUnicode, code) : 2),
  };
}

function codeLengthFor(cmap: CMap, code: number): number {
  for (const r of cmap.codespace) {
    if (code >= r.low && code <= r.high) return r.numBytes;
  }
  if (cmap.codeLengths.size === 1) return [...cmap.codeLengths][0];
  return code > 0xff ? 2 : 1;
}

function firstDescendant(ctx: PDFContext, dict: PDFDict): PDFDict | undefined {
  const arr = getArray(ctx, dict, 'DescendantFonts');
  const first = arr ? resolve(ctx, arr.get(0)) : undefined;
  if (first instanceof PDFStream) return first.dict;
  return first && typeof (first as PDFDict).get === 'function' ? (first as PDFDict) : undefined;
}

function matrixOf(nums: number[]): Matrix | null {
  if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
}

interface SimpleEncodingContext {
  subtype: FontSubtype; symbolic: boolean; nonsymbolic: boolean; embedded: boolean; baseFont: string; metrics: StandardMetrics | undefined; type3: boolean;
  /** The built-in encoding of an embedded Type1 program (its cleartext /Encoding), when readable. */
  builtin?: EncodingTable;
}

/**
 * The /Encoding of a Type1 font program's cleartext part (before `eexec`): either
 * `/Encoding StandardEncoding def` or a list of `dup <code> /<name> put`. pdfTeX embeds its
 * Computer Modern fonts this way with no /Encoding in the font dictionary, so without this the
 * text of most LaTeX documents would be unreadable to us.
 */
function type1BuiltinEncoding(ctx: PDFContext, descriptor: PDFDict | undefined): EncodingTable | undefined {
  const file = getStream(ctx, descriptor, 'FontFile');
  if (!file) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = decodeStream(ctx, file);
  } catch {
    return undefined;
  }
  // PFB segment header (0x80 0x01 <len32>) before the cleartext, if the producer left it in.
  let start = 0;
  if (bytes[0] === 0x80 && bytes[1] === 0x01) start = 6;
  const limit = Math.min(bytes.length, start + 65536);
  let text = '';
  for (let i = start; i < limit; i++) text += String.fromCharCode(bytes[i]);
  const eexec = text.indexOf('eexec');
  if (eexec >= 0) text = text.slice(0, eexec);
  const encAt = text.indexOf('/Encoding');
  if (encAt < 0) return undefined;
  const section = text.slice(encAt);
  if (/^\/Encoding\s+StandardEncoding\s+def/.test(section)) return STANDARD_ENCODING;
  const table: Array<string | undefined> = new Array(256).fill(undefined);
  let any = false;
  const re = /dup\s+(\d+)\s*\/([^\s/]+)\s+put/g;
  for (let m = re.exec(section); m !== null; m = re.exec(section)) {
    const code = Number(m[1]);
    if (code >= 0 && code < 256) {
      table[code] = m[2];
      any = true;
    }
  }
  return any ? table : undefined;
}

/**
 * Code -> glyph name table for a simple font: base encoding (named, or the
 * font's built-in one, or Standard) overlaid with /Differences.
 */
function simpleEncoding(ctx: PDFContext, dict: PDFDict, c: SimpleEncodingContext): { names: ReadonlyArray<string | undefined>; base: ReadonlyArray<string | undefined> } {
  const table: Array<string | undefined> = new Array(256).fill(undefined);
  const std = c.metrics?.name;
  let base: EncodingTable | undefined;
  if (std === 'Symbol') base = SYMBOL_ENCODING;
  else if (std === 'ZapfDingbats') base = ZAPF_DINGBATS_ENCODING;

  const encObj = resolve(ctx, dict.get(PDFName.of('Encoding')));
  let differences: PDFObject[] = [];
  if (encObj instanceof PDFName) {
    base = encodingByName(encObj.decodeText()) ?? base;
  } else if (encObj && typeof (encObj as PDFDict).get === 'function') {
    const encDict = encObj as PDFDict;
    const baseName = getName(ctx, encDict, 'BaseEncoding');
    if (baseName) base = encodingByName(baseName) ?? base;
    differences = itemsOf(ctx, getArray(ctx, encDict, 'Differences'));
  }
  if (!base) {
    // No /Encoding: the defaults pdf.js applies (evaluator.js extractDataStructures). Standard;
    // TrueType without the Nonsymbolic flag: WinAnsi; Symbolic flag: MacRoman for non-embedded
    // fonts (Symbol / ZapfDingbats by name), and the font's built-in encoding, unknown to us,
    // for embedded ones (the page is then cross-checked against pdf.js).
    if (c.type3) base = [];
    else if (c.symbolic && c.embedded && c.subtype !== 'TrueType') base = c.builtin ?? []; // Type1 built-in encoding, read from the font program when it is Type1 cleartext
    else if (std === 'Symbol') base = SYMBOL_ENCODING;
    else if (std === 'ZapfDingbats') base = ZAPF_DINGBATS_ENCODING;
    else if (c.symbolic) base = MAC_ROMAN_ENCODING;
    else if (c.subtype === 'TrueType' && !c.nonsymbolic) base = WIN_ANSI_ENCODING;
    else base = STANDARD_ENCODING;
  }
  for (let i = 0; i < 256; i++) table[i] = base[i];
  const baseNames: ReadonlyArray<string | undefined> = [...table];

  let code = 0;
  for (const item of differences) {
    if (item instanceof PDFNumber) code = item.asNumber();
    else if (item instanceof PDFName) {
      if (code >= 0 && code < 256) table[code] = item.decodeText();
      code++;
    }
  }
  return { names: table, base: baseNames };
}
