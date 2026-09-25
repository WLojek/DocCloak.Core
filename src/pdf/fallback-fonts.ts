/**
 * @doccloak/core/pdf - fallback fonts (T211).
 *
 * When the document's own font cannot show a placeholder such as
 * "[PERSON_1]", the writer draws it in the closest Liberation face.
 * Liberation Sans / Serif / Mono are metric-compatible with Arial /
 * Times New Roman / Courier New, so a placeholder set in the fallback keeps
 * the line geometry of the original text in the common case.
 *
 * Three pieces:
 * - `styleFromFontName` + `faceFor` turn a font dictionary (BaseFont name,
 *   /Flags, /ItalicAngle, /StemV, /FontWeight) into one of the 12 faces.
 * - `FallbackFontProvider` loads a face's TTF bytes through the host
 *   (`PdfAssetPaths.loadFont` or `fontsUrl` + fetch), parses it with fontkit
 *   and offers kerning-free width measurement and glyph coverage checks.
 * - `FallbackFontEmbedder` embeds a face once per output `PDFDocument` as a
 *   subset Type0 / Identity-H font and encodes placeholder text into the
 *   2-byte glyph ids the content stream needs.
 *
 * No `fs` here: this file runs in browsers and Node alike.
 */

import fontkit from '@cantoo/fontkit';
import type { Font as FontkitFont, FontCollection as FontkitCollection } from '@cantoo/fontkit';
import type { PDFDocument, PDFFont, PDFRef } from '@cantoo/pdf-lib';
import type { FontStyle, FontFamilyClass, PdfAssetPaths } from './types.ts';

// ---------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------

export type FallbackFace =
  | 'LiberationSans-Regular'
  | 'LiberationSans-Bold'
  | 'LiberationSans-Italic'
  | 'LiberationSans-BoldItalic'
  | 'LiberationSerif-Regular'
  | 'LiberationSerif-Bold'
  | 'LiberationSerif-Italic'
  | 'LiberationSerif-BoldItalic'
  | 'LiberationMono-Regular'
  | 'LiberationMono-Bold'
  | 'LiberationMono-Italic'
  | 'LiberationMono-BoldItalic';

/** Every face, in a stable order (used for subset tags). */
export const FALLBACK_FACES: readonly FallbackFace[] = [
  'LiberationSans-Regular',
  'LiberationSans-Bold',
  'LiberationSans-Italic',
  'LiberationSans-BoldItalic',
  'LiberationSerif-Regular',
  'LiberationSerif-Bold',
  'LiberationSerif-Italic',
  'LiberationSerif-BoldItalic',
  'LiberationMono-Regular',
  'LiberationMono-Bold',
  'LiberationMono-Italic',
  'LiberationMono-BoldItalic',
];

const FAMILY_NAME: Record<FontFamilyClass, string> = {
  sans: 'LiberationSans',
  serif: 'LiberationSerif',
  mono: 'LiberationMono',
};

/** Picks the Liberation face matching a style descriptor. */
export function faceFor(style: FontStyle): FallbackFace {
  const weight = style.bold ? 'Bold' : '';
  const slant = style.italic ? 'Italic' : '';
  const suffix = weight + slant || 'Regular';
  return `${FAMILY_NAME[style.family]}-${suffix}` as FallbackFace;
}

/** File name of a face inside the fonts directory (`${fontsUrl}${fileName}`). */
export function faceFileName(face: FallbackFace): string {
  return `${face}.ttf`;
}

// ---------------------------------------------------------------------------
// Style detection
// ---------------------------------------------------------------------------

/** PDF font descriptor /Flags bits (ISO 32000-1 table 123), as bit masks. */
export const FONT_FLAG_FIXED_PITCH = 1 << 0;
export const FONT_FLAG_SERIF = 1 << 1;
export const FONT_FLAG_ITALIC = 1 << 6;
export const FONT_FLAG_FORCE_BOLD = 1 << 18;

const MONO_HINTS = /courier|mono|consolas|menlo|monaco|lucidaconsole|inconsolata|sourcecodepro|firacode|couriernew|ocr[ab]|cascadiacode|cascadiamono|^cmtt|^cmsltt|nimbusmon|^lmmono|^lmtt/;
// Sans hints win over serif hints: "DejaVu Sans Serif"-style names do not exist, but
// "Sans" inside a name is a stronger signal than the family words below.
const SANS_HINTS = /arial|helvetica|calibri|verdana|segoe|tahoma|dejavusans|liberationsans|opensans|roboto|sans|gothic|futura|univers|frutiger|myriad|lato|montserrat|ubuntu|trebuchet|geneva|optima|avenir|gillsans|franklin|candara|corbel|noto(?!serif)|^cmss|nimbussan|^lmsans/;
const SERIF_HINTS = /times|georgia|garamond|cambria|book|serif|roman|minion|palatino|century|baskerville|charter|constantia|bodoni|didot|caslon|goudy|perpetua|plantin|sabon|utopia|notoserif|liberationserif|dejavuserif|merriweather|lora|playfair|^cm(?:r|bx|ti|b|sl|csc)\d|nimbusrom|^lmroman|charter|termes|pagella|bonum|schola/;
// Weight and slant words must start a "word" of the name: after a separator, at the start,
// or at a camel-case boundary (the normalized name has no separators, so "Bold" is looked for
// in the original name below). Inside a word ("Kobold", "Digital", "Hospital") they mean nothing.
const BOLD_HINTS = /(?:^|[^a-z])(?:bold|black|heavy|semibold|demibold|demi|extrabold|ultrabold)(?![a-z])|(?:^|[-,_ ])(?:bd|hv|blk)(?:it|mt|ps)*$|^cmbx|^cmb\d|^cmssbx|^lm\w*bold/;
const LIGHT_HINTS = /(?:^|[^a-z])(?:regular|light|thin|medium|normal|book|roman|extralight|ultralight|hairline)(?![a-z])/;
const ITALIC_HINTS = /(?:^|[^a-z])(?:italic|oblique|ital|kursiv|slanted)(?![a-z])|(?:^|[-,_ ])(?:bold)?it(?:mt)?$|(?:^|[-,_ ])(?:bd|hv|blk)it(?:mt)?$|^cmti|^cmsl|^cmssi|^cmbxti|^lm\w*(?:italic|oblique|slanted)/;

/** Name with separators replaced by one space and camel-case boundaries split ("BoldItalicMT" -> "Bold Italic MT"), lower-cased. */
function wordsOfFontName(baseFont: string): string {
  const stripped = baseFont.replace(/^\/?[A-Z]{6}\+/, '').replace(/^\//, '');
  return stripped
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[\s_,\-.]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Strips a subset tag ("AAAAAA+") and returns the name lower-cased without separators. */
function normalizeFontName(baseFont: string): string {
  const stripped = baseFont.replace(/^\/?[A-Z]{6}\+/, '').replace(/^\//, '');
  return stripped.toLowerCase().replace(/[\s_]+/g, '');
}

/**
 * Derives family / bold / italic from a font's BaseFont name and, when the
 * name is silent, its font descriptor facts.
 *
 * - family: mono when the name says so or /Flags has FixedPitch; sans when the
 *   name is a known sans face; serif when the name says so, else the /Flags
 *   Serif bit decides; sans by default.
 * - bold: name says so (Bold/Black/Heavy/Semibold/Demi), else /FontWeight >= 600,
 *   /StemV >= 120 or the ForceBold flag when the name gives no weight at all.
 * - italic: name says so (Italic/Oblique/-It), /Flags Italic bit, or /ItalicAngle != 0.
 */
export function styleFromFontName(
  baseFont: string,
  flags = 0,
  italicAngle = 0,
  stemV = 0,
  fontWeight = 0,
): FontStyle {
  const name = normalizeFontName(baseFont ?? '');
  // Names carry the style after a comma / hyphen ("Calibri,BoldItalic", "Arial-BoldMT") or at a
  // camel-case boundary; `words` splits those so a weight word is matched only as a whole word.
  const words = wordsOfFontName(baseFont ?? '');
  const family = detectFamily(name, flags);

  let bold: boolean;
  if (BOLD_HINTS.test(words) || BOLD_HINTS.test(name.replace(/^[a-z]{6}\+/, ''))) {
    bold = BOLD_HINTS.test(words);
  } else if (LIGHT_HINTS.test(words)) {
    bold = false;
  } else {
    // /StemV is not a weight: Chrome/Skia writes 130+ for regular Georgia and 250+ for its italic.
    bold = fontWeight >= 600 || (flags & FONT_FLAG_FORCE_BOLD) !== 0;
  }
  void stemV;

  const italic =
    ITALIC_HINTS.test(words) || (flags & FONT_FLAG_ITALIC) !== 0 || (Number.isFinite(italicAngle) && italicAngle !== 0);

  return { family, bold, italic };
}

function detectFamily(name: string, flags: number): FontFamilyClass {
  if (MONO_HINTS.test(name) || (flags & FONT_FLAG_FIXED_PITCH) !== 0) return 'mono';
  if (SANS_HINTS.test(name)) return 'sans';
  if (SERIF_HINTS.test(name)) return 'serif';
  if ((flags & FONT_FLAG_SERIF) !== 0) return 'serif';
  return 'sans';
}

// ---------------------------------------------------------------------------
// Loading and measuring
// ---------------------------------------------------------------------------

/**
 * OpenType features used for every layout call, in the provider and in the
 * embedder alike: kerning and ligatures off, so a placeholder is one glyph per
 * character and its width is the plain sum of glyph advances - exactly what a
 * Tj with Identity-H encoding renders from the embedded /W array.
 */
export const FALLBACK_LAYOUT_FEATURES: Record<string, boolean> = {
  kern: false,
  liga: false,
  clig: false,
  dlig: false,
  calt: false,
  rlig: false,
};

export interface LoadedFallbackFont {
  face: FallbackFace;
  /** The complete TTF as loaded (what the embedder subsets). */
  bytes: Uint8Array;
  /** Advance width of `text` at `fontSize`, in text space units (points at Tz 100). Kerning is not applied. */
  measure(text: string, fontSize: number): number;
  /** True when every code point of `text` has a glyph in this face. */
  canShow(text: string): boolean;
  /** Typographic ascent, in 1/1000 em. */
  ascent: number;
  /** Typographic descent (negative), in 1/1000 em. */
  descent: number;
  /** Cap height, in 1/1000 em. */
  capHeight: number;
  /** x-height, in 1/1000 em. */
  xHeight: number;
  /** Font units per em of the TTF (2048 for Liberation). */
  unitsPerEm: number;
}

function parseFont(bytes: Uint8Array, face: FallbackFace): FontkitFont {
  const parsed: FontkitFont | FontkitCollection = fontkit.create(bytes);
  if ('fonts' in parsed) {
    throw new Error(`Fallback font ${face} is a font collection, expected a single TrueType face`);
  }
  return parsed;
}

/** Width helper shared by the provider and the embedder: sum of glyph advances at `size`. */
export function measureWithFont(font: FontkitFont, text: string, fontSize: number): number {
  if (text.length === 0) return 0;
  const { glyphs } = font.layout(text, FALLBACK_LAYOUT_FEATURES);
  let units = 0;
  for (const glyph of glyphs) units += glyph.advanceWidth;
  return (units * fontSize) / font.unitsPerEm;
}

function canShowWithFont(font: FontkitFont, text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (!font.hasGlyphForCodePoint(cp)) return false;
  }
  return true;
}

function toLoadedFont(face: FallbackFace, bytes: Uint8Array): LoadedFallbackFont {
  const font = parseFont(bytes, face);
  const k = 1000 / font.unitsPerEm;
  return {
    face,
    bytes,
    measure: (text, fontSize) => measureWithFont(font, text, fontSize),
    canShow: (text) => canShowWithFont(font, text),
    ascent: font.ascent * k,
    descent: font.descent * k,
    capHeight: font.capHeight * k,
    xHeight: font.xHeight * k,
    unitsPerEm: font.unitsPerEm,
  };
}

/**
 * Loads and caches the Liberation faces. Bytes come from `assets.loadFont`
 * when the host provides it (Node tests, Electron), else from
 * `${assets.fontsUrl}${face}.ttf` through the global `fetch`.
 */
export class FallbackFontProvider {
  private readonly assets: PdfAssetPaths;
  private readonly cache = new Map<FallbackFace, Promise<LoadedFallbackFont>>();

  constructor(assets: PdfAssetPaths = {}) {
    this.assets = assets;
  }

  /** Loads (once) and returns the face; concurrent calls share the same promise. */
  load(face: FallbackFace): Promise<LoadedFallbackFont> {
    let pending = this.cache.get(face);
    if (!pending) {
      pending = this.fetchBytes(face).then((bytes) => toLoadedFont(face, bytes));
      // Drop a failed load so a later call can retry (e.g. after the host fixed its asset path).
      pending.catch(() => this.cache.delete(face));
      this.cache.set(face, pending);
    }
    return pending;
  }

  /** True when the face has already been loaded successfully or is loading. */
  has(face: FallbackFace): boolean {
    return this.cache.has(face);
  }

  private async fetchBytes(face: FallbackFace): Promise<Uint8Array> {
    const fileName = faceFileName(face);
    const { loadFont, fontsUrl } = this.assets;
    if (loadFont) {
      const bytes = await loadFont(fileName);
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new Error(`loadFont(${fileName}) returned no bytes`);
      }
      return bytes;
    }
    if (fontsUrl) {
      if (typeof fetch !== 'function') {
        throw new Error(`Cannot load fallback font ${fileName}: no global fetch; pass PdfAssetPaths.loadFont instead`);
      }
      const url = `${fontsUrl}${fileName}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Cannot load fallback font ${fileName}: ${res.status} ${res.statusText} from ${url}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }
    throw new Error(
      `Cannot load fallback font ${fileName}: PdfAssetPaths.fontsUrl or PdfAssetPaths.loadFont is required to write placeholders in a fallback font`,
    );
  }
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface EmbeddedFallbackFont {
  face: FallbackFace;
  /** The pdf-lib font object; `pdfFont.ref` is the indirect reference of its Type0 dictionary. */
  pdfFont: PDFFont;
  /** Name to use in the page's /Resources /Font dictionary and in Tf ('DCFb1', 'DCFb2', ...). */
  resourceName: string;
  /**
   * Encodes text into the bytes of a Tj hex string: two bytes per glyph
   * (Identity-H CIDs = subset glyph ids). Every shown placeholder must pass
   * through this call, because pdf-lib builds the subset from what was encoded.
   */
  encode(text: string): Uint8Array;
  /** Same measurement as `LoadedFallbackFont.measure`, from the same glyph set that gets embedded. */
  measure(text: string, fontSize: number): number;
  /** Glyph coverage of the face. */
  canShow(text: string): boolean;
  /** Metrics of the face, in 1/1000 em. */
  ascent: number;
  descent: number;
  capHeight: number;
}

/** Six-letter subset tag for a face ("DCAAAB+LiberationSans-Bold"), stable per face. */
function subsetTag(face: FallbackFace): string {
  const index = Math.max(0, FALLBACK_FACES.indexOf(face));
  const a = String.fromCharCode(65 + Math.floor(index / 26));
  const b = String.fromCharCode(65 + (index % 26));
  return `DCAA${a}${b}`;
}

/**
 * Embeds fallback faces into one output document, once per face, and hands the
 * writer the resource name, the encoder and the measurer for each.
 *
 * pdf-lib subsets lazily: the glyphs written into the file at `save()` are the
 * ones that went through `encode()`. Measuring never adds glyphs.
 */
export class FallbackFontEmbedder {
  private readonly doc: PDFDocument;
  private readonly provider: FallbackFontProvider;
  private readonly resourcePrefix: string;
  private readonly embedded = new Map<FallbackFace, Promise<EmbeddedFallbackFont>>();
  /** Resolved fonts in embedding order (resource numbers follow this order). */
  private readonly ready: EmbeddedFallbackFont[] = [];

  /**
   * @param doc Output document. fontkit is registered on it here; calling
   *   `registerFontkit` again on the caller's side is harmless.
   * @param provider Source of the TTF bytes (shared across documents so each face is parsed once).
   * @param resourcePrefix Prefix of the generated resource names; the writer must make sure it
   *   does not collide with the page's own font resource names.
   */
  constructor(doc: PDFDocument, provider: FallbackFontProvider, resourcePrefix = 'DCFb') {
    this.doc = doc;
    this.provider = provider;
    this.resourcePrefix = resourcePrefix;
    doc.registerFontkit(fontkit);
  }

  /** Embeds the face into the document on first call; later calls return the same font. */
  ensure(face: FallbackFace): Promise<EmbeddedFallbackFont> {
    let pending = this.embedded.get(face);
    if (!pending) {
      pending = this.embed(face);
      pending.catch(() => this.embedded.delete(face));
      this.embedded.set(face, pending);
    }
    return pending;
  }

  private async embed(face: FallbackFace): Promise<EmbeddedFallbackFont> {
    const loaded = await this.provider.load(face);
    const pdfFont = await this.doc.embedFont(loaded.bytes, {
      subset: true,
      customName: `${subsetTag(face)}+${face}`,
      features: FALLBACK_LAYOUT_FEATURES,
    });
    const resourceName = `${this.resourcePrefix}${this.ready.length + 1}`;
    const font: EmbeddedFallbackFont = {
      face,
      pdfFont,
      resourceName,
      encode: (text) => pdfFont.encodeText(text).asBytes(),
      measure: loaded.measure,
      canShow: loaded.canShow,
      ascent: loaded.ascent,
      descent: loaded.descent,
      capHeight: loaded.capHeight,
    };
    this.ready.push(font);
    return font;
  }

  /** Fonts embedded so far (resolved `ensure()` calls), in embedding order. */
  fonts(): readonly EmbeddedFallbackFont[] {
    return this.ready;
  }

  /**
   * `[resourceName, ref]` for every embedded face, for the writer to merge
   * into each page's /Resources /Font dictionary. Only faces whose `ensure()`
   * has resolved are listed, so call it after the placeholders are encoded.
   */
  resourceEntries(): Array<[string, PDFRef]> {
    return this.ready.map((font) => [font.resourceName, font.pdfFont.ref]);
  }
}
