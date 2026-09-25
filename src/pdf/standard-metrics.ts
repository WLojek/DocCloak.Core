/**
 * @doccloak/core/pdf - metrics of the standard 14 fonts (T209).
 *
 * Fonts that are not embedded and carry no /Widths (the standard 14 and their
 * common aliases: Arial, Times New Roman, Courier New) get their advance
 * widths from the AFM metrics vendored by @cantoo/pdf-lib.
 */

import { Font as AfmFont } from '@cantoo/pdf-lib/standard-fonts';

export type StandardFontName =
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Symbol' | 'ZapfDingbats';

const CACHE = new Map<StandardFontName, AfmFont>();

function normalizeBaseFont(baseFont: string): string {
  return baseFont.replace(/^[A-Z]{6}\+/, '').replace(/[\s_]/g, '').toLowerCase();
}

/**
 * Map a /BaseFont to a standard 14 font, or undefined. Handles the aliases
 * from the PDF 1.7 implementation notes (Arial, TimesNewRoman, CourierNew)
 * and the ",Bold" / "-BoldItalic" / "PS-BoldMT" style suffixes.
 */
export function standardFontFor(baseFont: string): StandardFontName | undefined {
  const n = normalizeBaseFont(baseFont);
  const bold = /bold|black|heavy|semibold|demibold/.test(n);
  const italic = /italic|oblique/.test(n);
  let family: 'Courier' | 'Helvetica' | 'Times' | 'Symbol' | 'ZapfDingbats' | undefined;
  if (n.startsWith('courier')) family = 'Courier';
  else if (n.startsWith('helvetica') || n.startsWith('arial')) family = 'Helvetica';
  else if (n.startsWith('times')) family = 'Times';
  else if (n === 'symbol' || n.startsWith('symbol,') || n === 'symbolmt') family = 'Symbol';
  else if (n.startsWith('zapfdingbats') || n === 'dingbats') family = 'ZapfDingbats';
  if (!family) return undefined;
  if (family === 'Symbol' || family === 'ZapfDingbats') return family;
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return `${family}${suffix}` as StandardFontName;
}

export interface StandardMetrics {
  name: StandardFontName;
  /** Advance width of a glyph by name, in 1/1000 text space units; undefined when the font has no such glyph. */
  widthOfGlyph(glyphName: string): number | undefined;
  /** Glyph names present in the AFM (for encodability of placeholders in a non-embedded font). */
  hasGlyph(glyphName: string): boolean;
  /** Built-in encoding of the AFM (code -> glyph name), for Symbol and ZapfDingbats. */
  builtinEncoding(): ReadonlyArray<string | undefined>;
  ascender: number;
  descender: number;
  capHeight: number;
}

export function loadStandardMetrics(name: StandardFontName): StandardMetrics {
  let afm = CACHE.get(name);
  if (!afm) {
    afm = AfmFont.load(name);
    CACHE.set(name, afm);
  }
  const font = afm;
  const byName = new Map<string, number>();
  const builtin: Array<string | undefined> = new Array(256).fill(undefined);
  for (const m of font.CharMetrics as Array<{ WX: number; N: string; C?: number }>) {
    byName.set(m.N, m.WX);
    if (typeof m.C === 'number' && m.C >= 0 && m.C < 256) builtin[m.C] = m.N;
  }
  return {
    name,
    widthOfGlyph: (g) => byName.get(g),
    hasGlyph: (g) => byName.has(g),
    builtinEncoding: () => builtin,
    ascender: font.Ascender ?? 718,
    descender: font.Descender ?? -207,
    capHeight: font.CapHeight ?? 718,
  };
}
