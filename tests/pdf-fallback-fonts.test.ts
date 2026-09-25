import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDocument, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream } from '@cantoo/pdf-lib';
import {
  FALLBACK_FACES,
  FONT_FLAG_FIXED_PITCH,
  FONT_FLAG_ITALIC,
  FONT_FLAG_SERIF,
  FallbackFontEmbedder,
  FallbackFontProvider,
  faceFor,
  styleFromFontName,
} from '../src/pdf/fallback-fonts.ts';
import type { FallbackFace } from '../src/pdf/fallback-fonts.ts';
import type { FontStyle } from '../src/pdf/types.ts';

const FONTS_DIR = join(__dirname, '..', 'fonts', 'liberation');

function loadFont(fileName: string): Promise<Uint8Array> {
  return Promise.resolve(new Uint8Array(readFileSync(join(FONTS_DIR, fileName))));
}

/** Arial / Helvetica AFM widths (1/1000 em) of the characters in "[PERSON_1]". */
const ARIAL_AFM: Record<string, number> = {
  '[': 278, P: 667, E: 667, R: 722, S: 667, O: 778, N: 722, _: 556, '1': 556, ']': 278,
};
const PLACEHOLDER = '[PERSON_1]';
const ARIAL_WIDTH_12PT = ([...PLACEHOLDER].reduce((sum, ch) => sum + ARIAL_AFM[ch], 0) / 1000) * 12; // 70.692

describe('styleFromFontName', () => {
  const cases: Array<[string, Parameters<typeof styleFromFontName>, FontStyle]> = [
    ['Arial-BoldMT', ['Arial-BoldMT'], { family: 'sans', bold: true, italic: false }],
    ['subset TimesNewRomanPS-ItalicMT', ['AAAAAA+TimesNewRomanPS-ItalicMT'], { family: 'serif', bold: false, italic: true }],
    ['CourierNewPSMT', ['CourierNewPSMT'], { family: 'mono', bold: false, italic: false }],
    ['Calibri,BoldItalic', ['Calibri,BoldItalic'], { family: 'sans', bold: true, italic: true }],
    ['unknown name, serif flag', ['ABCDEF+Foo', FONT_FLAG_SERIF], { family: 'serif', bold: false, italic: false }],
    ['unknown name, no flags', ['Foo'], { family: 'sans', bold: false, italic: false }],
    ['DejaVuSans-Oblique', ['DejaVuSans-Oblique'], { family: 'sans', bold: false, italic: true }],
    ['Helvetica-Bold', ['Helvetica-Bold'], { family: 'sans', bold: true, italic: false }],
    ['Times-Roman', ['Times-Roman'], { family: 'serif', bold: false, italic: false }],
    ['TimesNewRomanPS-BoldItalicMT', ['TimesNewRomanPS-BoldItalicMT'], { family: 'serif', bold: true, italic: true }],
    ['Georgia,Bold', ['Georgia,Bold'], { family: 'serif', bold: true, italic: false }],
    ['unknown name, fixed pitch flag', ['Foo', FONT_FLAG_FIXED_PITCH], { family: 'mono', bold: false, italic: false }],
    ['Consolas', ['Consolas'], { family: 'mono', bold: false, italic: false }],
    ['Verdana with italic flag', ['Verdana', FONT_FLAG_ITALIC], { family: 'sans', bold: false, italic: true }],
    ['italic angle without name hint', ['Foo', 0, -12], { family: 'sans', bold: false, italic: true }],
    ['FontWeight 700, name silent', ['Foo', 0, 0, 0, 700], { family: 'sans', bold: true, italic: false }],
    // /StemV is not a weight signal: Chrome/Skia writes 133.8 for regular Georgia, 259 for Georgia-Italic.
    ['StemV 140, name silent', ['Foo', 0, 0, 140], { family: 'sans', bold: false, italic: false }],
    ['Chrome Georgia (Flags 6, StemV 133.8)', ['CAAAAA+Georgia', 6, 0, 133.8], { family: 'serif', bold: false, italic: false }],
    ['Chrome Georgia-Italic (StemV 259)', ['DAAAAA+Georgia-Italic', 6 | FONT_FLAG_ITALIC, -13, 259], { family: 'serif', bold: false, italic: true }],
    ['Arial-BoldItalicMT', ['Arial-BoldItalicMT'], { family: 'sans', bold: true, italic: true }],
    ['Digital-7 is not italic', ['Digital-7'], { family: 'sans', bold: false, italic: false }],
    ['Hospital is not italic', ['Hospital'], { family: 'sans', bold: false, italic: false }],
    ['Kobold is not bold', ['Kobold'], { family: 'sans', bold: false, italic: false }],
    ['Blackadder is not bold', ['Blackadder'], { family: 'sans', bold: false, italic: false }],
    ['Heavyweight is not bold', ['Heavyweight'], { family: 'sans', bold: false, italic: false }],
    ['CMR10 (pdfTeX) is serif', ['CMR10', 4], { family: 'serif', bold: false, italic: false }],
    ['CMBX10 is bold serif', ['CMBX10', 4], { family: 'serif', bold: true, italic: false }],
    ['CMTI10 is italic serif', ['CMTI10', 4], { family: 'serif', bold: false, italic: true }],
    ['CMTT10 is mono', ['CMTT10', 4], { family: 'mono', bold: false, italic: false }],
    ['NimbusRomNo9L-Regu is serif', ['NimbusRomNo9L-Regu'], { family: 'serif', bold: false, italic: false }],
    ['NimbusMonL-Regu is mono', ['NimbusMonL-Regu'], { family: 'mono', bold: false, italic: false }],
    ['CascadiaCode is mono', ['CascadiaCode'], { family: 'mono', bold: false, italic: false }],
    ['StemV 140 but name says Regular', ['Foo-Regular', 0, 0, 140], { family: 'sans', bold: false, italic: false }],
    ['sans name wins over serif flag', ['Arial', FONT_FLAG_SERIF], { family: 'sans', bold: false, italic: false }],
    ['Segoe UI Semibold', ['SegoeUI-Semibold'], { family: 'sans', bold: true, italic: false }],
    ['Roboto-Black', ['Roboto-Black'], { family: 'sans', bold: true, italic: false }],
    ['Cambria-BoldItalic', ['Cambria-BoldItalic'], { family: 'serif', bold: true, italic: true }],
    ['LiberationSerif-Italic', ['LiberationSerif-Italic'], { family: 'serif', bold: false, italic: true }],
    ['MinionPro-It', ['MinionPro-It'], { family: 'serif', bold: false, italic: true }],
  ];
  for (const [label, args, expected] of cases) {
    it(label, () => {
      expect(styleFromFontName(...args)).toEqual(expected);
    });
  }
});

describe('faceFor', () => {
  const combos: Array<[FontStyle, FallbackFace]> = [
    [{ family: 'sans', bold: false, italic: false }, 'LiberationSans-Regular'],
    [{ family: 'sans', bold: true, italic: false }, 'LiberationSans-Bold'],
    [{ family: 'sans', bold: false, italic: true }, 'LiberationSans-Italic'],
    [{ family: 'sans', bold: true, italic: true }, 'LiberationSans-BoldItalic'],
    [{ family: 'serif', bold: false, italic: false }, 'LiberationSerif-Regular'],
    [{ family: 'serif', bold: true, italic: false }, 'LiberationSerif-Bold'],
    [{ family: 'serif', bold: false, italic: true }, 'LiberationSerif-Italic'],
    [{ family: 'serif', bold: true, italic: true }, 'LiberationSerif-BoldItalic'],
    [{ family: 'mono', bold: false, italic: false }, 'LiberationMono-Regular'],
    [{ family: 'mono', bold: true, italic: false }, 'LiberationMono-Bold'],
    [{ family: 'mono', bold: false, italic: true }, 'LiberationMono-Italic'],
    [{ family: 'mono', bold: true, italic: true }, 'LiberationMono-BoldItalic'],
  ];
  for (const [style, face] of combos) {
    it(`${style.family} ${style.bold ? 'bold' : ''} ${style.italic ? 'italic' : ''} -> ${face}`, () => {
      expect(faceFor(style)).toBe(face);
    });
  }

  it('every face maps back to itself through styleFromFontName', () => {
    for (const face of FALLBACK_FACES) {
      expect(faceFor(styleFromFontName(face))).toBe(face);
    }
  });
});

describe('FallbackFontProvider', () => {
  it('loads Liberation Sans through loadFont and measures like Arial', async () => {
    const spy = vi.fn(loadFont);
    const provider = new FallbackFontProvider({ loadFont: spy });
    const font = await provider.load('LiberationSans-Regular');
    expect(font.face).toBe('LiberationSans-Regular');
    expect(font.bytes.length).toBeGreaterThan(100_000);
    expect(spy).toHaveBeenCalledWith('LiberationSans-Regular.ttf');

    const width = font.measure(PLACEHOLDER, 12);
    expect(Math.abs(width - ARIAL_WIDTH_12PT) / ARIAL_WIDTH_12PT).toBeLessThan(0.01);
    expect(font.measure('', 12)).toBe(0);
    // Linear in the size
    expect(font.measure(PLACEHOLDER, 24)).toBeCloseTo(width * 2, 6);
    // Kerning must not be applied: "AV" is the plain sum of the two advances.
    expect(font.measure('AV', 10)).toBeCloseTo(font.measure('A', 10) + font.measure('V', 10), 6);

    expect(font.canShow('ąęśćżźłń')).toBe(true);
    expect(font.canShow('[PERSON_1]')).toBe(true);
    expect(font.canShow('中')).toBe(false);

    expect(font.unitsPerEm).toBe(2048);
    expect(font.ascent).toBeGreaterThan(850);
    expect(font.ascent).toBeLessThan(950);
    expect(font.descent).toBeLessThan(-150);
    expect(font.descent).toBeGreaterThan(-250);
    expect(font.capHeight).toBeGreaterThan(650);
    expect(font.capHeight).toBeLessThan(750);
  });

  it('caches per face', async () => {
    const spy = vi.fn(loadFont);
    const provider = new FallbackFontProvider({ loadFont: spy });
    const [a, b] = await Promise.all([provider.load('LiberationSerif-Bold'), provider.load('LiberationSerif-Bold')]);
    const c = await provider.load('LiberationSerif-Bold');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(spy).toHaveBeenCalledTimes(1);
    await provider.load('LiberationMono-Italic');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('fetches from fontsUrl when no loadFont is given', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = url.slice(url.lastIndexOf('/') + 1);
      const bytes = readFileSync(join(FONTS_DIR, name));
      return new Response(bytes, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new FallbackFontProvider({ fontsUrl: '/assets/fonts/' });
      const font = await provider.load('LiberationMono-Regular');
      expect(fetchMock).toHaveBeenCalledWith('/assets/fonts/LiberationMono-Regular.ttf');
      expect(font.measure('ab', 10)).toBeCloseTo(font.measure('a', 10) * 2, 6);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a failed fetch and retries on the next call', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new FallbackFontProvider({ fontsUrl: 'https://example.test/fonts/' });
      await expect(provider.load('LiberationSans-Bold')).rejects.toThrow(/404.*LiberationSans-Bold\.ttf/);
      await expect(provider.load('LiberationSans-Bold')).rejects.toThrow(/404/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws a clear error when no font source is configured', async () => {
    const provider = new FallbackFontProvider({});
    await expect(provider.load('LiberationSans-Regular')).rejects.toThrow(/fontsUrl or PdfAssetPaths.loadFont/);
  });
});

/** Every Type0 font dictionary in the document as { baseFont, subtype }. */
function type0Fonts(doc: PDFDocument): Array<{ baseFont: string; ref: PDFRef }> {
  const out: Array<{ baseFont: string; ref: PDFRef }> = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const subtype = obj.get(PDFName.of('Subtype'));
    if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Type0') continue;
    const baseFont = obj.get(PDFName.of('BaseFont'));
    out.push({ baseFont: baseFont instanceof PDFName ? baseFont.decodeText() : '', ref });
  }
  return out;
}

describe('FallbackFontEmbedder', () => {
  it('embeds a face once, encodes 2 bytes per glyph and survives a save/load round trip', async () => {
    const provider = new FallbackFontProvider({ loadFont });
    const doc = await PDFDocument.create();
    const embedder = new FallbackFontEmbedder(doc, provider);

    const first = await embedder.ensure('LiberationSans-Regular');
    const second = await embedder.ensure('LiberationSans-Regular');
    expect(second).toBe(first);
    expect(first.face).toBe('LiberationSans-Regular');
    expect(first.resourceName).toBe('DCFb1');
    expect(first.pdfFont.ref).toBeInstanceOf(PDFRef);

    const encoded = first.encode(PLACEHOLDER);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.length).toBe(PLACEHOLDER.length * 2);
    // Identity-H: the high byte is 0 for a small subset, the low byte is the subset glyph id (> 0).
    for (let i = 0; i < encoded.length; i += 2) {
      expect(encoded[i]).toBe(0);
      expect(encoded[i + 1]).toBeGreaterThan(0);
    }
    // Same character -> same glyph id
    const twice = first.encode('PP');
    expect(twice[1]).toBe(twice[3]);

    // The embedder measures with the same glyph set pdf-lib embeds.
    expect(first.measure(PLACEHOLDER, 12)).toBeCloseTo(first.pdfFont.widthOfTextAtSize(PLACEHOLDER, 12), 6);
    expect(Math.abs(first.measure(PLACEHOLDER, 12) - ARIAL_WIDTH_12PT) / ARIAL_WIDTH_12PT).toBeLessThan(0.01);
    expect(first.canShow('中')).toBe(false);

    // One entry for the writer's /Resources /Font dictionary
    const entries = embedder.resourceEntries();
    expect(entries).toEqual([['DCFb1', first.pdfFont.ref]]);
    expect(embedder.fonts()).toHaveLength(1);

    // The font must be referenced from a page for pdf-lib to keep it; add it to a page's resources.
    const page = doc.addPage([200, 100]);
    page.node.setFontDictionary(PDFName.of(first.resourceName), first.pdfFont.ref);
    const bytes = await doc.save();

    const reloaded = await PDFDocument.load(bytes);
    const fonts = type0Fonts(reloaded);
    expect(fonts).toHaveLength(1);
    expect(fonts[0].baseFont.endsWith('LiberationSans-Regular')).toBe(true);
    expect(fonts[0].baseFont).toMatch(/^[A-Z]{6}\+LiberationSans-Regular$/);

    // Descendant font is CIDFontType2 with an embedded FontFile2 much smaller than the full TTF (subset).
    const type0 = reloaded.context.lookup(fonts[0].ref, PDFDict);
    expect(String(type0.get(PDFName.of('Encoding')))).toBe('/Identity-H');
    const descendants = type0.lookup(PDFName.of('DescendantFonts'), PDFArray);
    const cidFont = descendants.lookup(0, PDFDict);
    expect(String(cidFont.get(PDFName.of('Subtype')))).toBe('/CIDFontType2');
    const descriptor = cidFont.lookup(PDFName.of('FontDescriptor'), PDFDict);
    const fontFile = descriptor.lookup(PDFName.of('FontFile2'), PDFStream);
    expect(fontFile).toBeInstanceOf(PDFRawStream);
    const subsetBytes = (fontFile as PDFRawStream).contents.length;
    expect(provider.has('LiberationSans-Regular')).toBe(true);
    const fullTtf = (await provider.load('LiberationSans-Regular')).bytes.length;
    expect(subsetBytes).toBeGreaterThan(0);
    expect(subsetBytes).toBeLessThan(fullTtf / 4);
  });

  it('numbers resource names per face and lists all embedded faces', async () => {
    const provider = new FallbackFontProvider({ loadFont });
    const doc = await PDFDocument.create();
    const embedder = new FallbackFontEmbedder(doc, provider);
    const [sans, serif] = await Promise.all([embedder.ensure('LiberationSans-Bold'), embedder.ensure('LiberationSerif-Italic')]);
    const mono = await embedder.ensure('LiberationMono-Regular');
    const again = await embedder.ensure('LiberationSerif-Italic');
    expect(again).toBe(serif);
    const names = [sans, serif, mono].map((f) => f.resourceName).sort();
    expect(names).toEqual(['DCFb1', 'DCFb2', 'DCFb3']);
    expect(embedder.resourceEntries().map(([name]) => name).sort()).toEqual(names);
    expect(new Set(embedder.resourceEntries().map(([, ref]) => ref.toString())).size).toBe(3);

    // Mono: every glyph has the same advance.
    expect(mono.measure('iW', 10)).toBeCloseTo(mono.measure('ii', 10), 6);
    // Bold sans is wider than regular sans for the same text.
    const regular = await provider.load('LiberationSans-Regular');
    expect(sans.measure(PLACEHOLDER, 12)).toBeGreaterThan(regular.measure(PLACEHOLDER, 12));
  });

  it('honours a custom resource prefix', async () => {
    const provider = new FallbackFontProvider({ loadFont });
    const doc = await PDFDocument.create();
    const embedder = new FallbackFontEmbedder(doc, provider, 'Fx');
    const font = await embedder.ensure('LiberationSerif-Regular');
    expect(font.resourceName).toBe('Fx1');
  });
});
