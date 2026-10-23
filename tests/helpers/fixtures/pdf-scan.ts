// Synthetic "scanned" PDFs for the scan-page tests (T235): each page is a picture of text
// drawn with @napi-rs/canvas (redacted values in red, so a leftover pixel of a value is easy to
// find), plus an OCR text layer the way scanners write one:
//   'alpha' - text in a form XObject under an ExtGState with /ca 0 (Lutecia / 3-Heights, the
//             file of DocCloak.Core#1),
//   'tr3'   - text in render mode 3 (Tesseract, ocrmypdf, Acrobat),
//   'under' - visible text painted first and the picture over it ("text under the page image"),
//   'tess'  - Tesseract's layout: one show per word and its trailing space in render mode 3,
//             every letter of the same width (Courier here), the whole show stretched with Tz to
//             the word's width in the picture: letter positions inside a word are guesses,
//   'none'  - the picture only (a scan without OCR).
// A word may start with a value and go on ("616," or "2026/03/017" with values "616", "2026"): the
// value's letters are painted red, the rest of the word in black.
// `ocrScale` narrows the OCR layer's letters (Tz), as OCR layers set in their own font do.
// Returns undefined when the native canvas module is not available (tests then skip).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

export type OcrLayer = 'alpha' | 'tr3' | 'under' | 'tess' | 'none';

export interface ScanPageSpec {
  kind: 'scan';
  /** Lines of words; a word in `values` is painted red. */
  lines: string[][];
  values: string[];
  layer: OcrLayer;
  /** Horizontal scale of the OCR layer's text relative to the picture (default 1). */
  ocrScale?: number;
  /** Lines printed in the picture below the others but missing from the OCR layer (text the OCR could not read). */
  unreadLines?: string[][];
  /** Lines printed after those, whose OCR layer holds this junk instead of their words (a misread table row). */
  junkLines?: Array<{ words: string[]; junk: string }>;
}

export interface TextPageSpec {
  kind: 'text';
  lines: string[];
  /**
   * An image placed below the text, showing these lines (values in red): text a text page holds
   * only in a picture (a pasted screenshot, a stamp). Its words are listed in `words` with the
   * page's picture coordinates (SCAN_DPI pixels of the whole page) and `inImage` set.
   */
  image?: { lines: string[][]; values: string[] };
}

/** Where a word was painted in the picture (pixels, top-left origin). */
export interface PaintedWord {
  page: number;
  text: string;
  value: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Where the red value part of the word ends (x1 when the whole word is the value). */
  valueEnd: number;
  /** Printed but missing from the OCR layer (an `unreadLines` word), with its line's baseline. */
  unread?: { baseline: number };
  /** Printed inside an image on a text page (TextPageSpec.image), with its line's baseline. */
  inImage?: { baseline: number };
}

export interface ScanPdf {
  bytes: Uint8Array;
  words: PaintedWord[];
  /** Picture size in pixels (every scan page has the same). */
  widthPx: number;
  heightPx: number;
}

export const SCAN_DPI = 150;
const PAGE_PT: [number, number] = [612, 792];
const FONT_PT = 11;
const LINE_PX = 38;
const LEFT_PX = 150;
const TOP_PX = 220;

interface NapiCanvas {
  createCanvas: (w: number, h: number) => {
    getContext(kind: '2d'): CanvasRenderingContext2D;
  };
  GlobalFonts: { registerFromPath(path: string, alias?: string): unknown };
}

let napi: NapiCanvas | null | undefined;

async function canvasModule(): Promise<NapiCanvas | null> {
  if (napi !== undefined) return napi;
  try {
    napi = (await import('@napi-rs/canvas')) as unknown as NapiCanvas;
    const font = join(__dirname, '..', '..', '..', 'fonts', 'liberation', 'LiberationSans-Regular.ttf');
    readFileSync(font);
    napi.GlobalFonts.registerFromPath(font, 'ScanSans');
    // The scan painter asks for "Liberation Sans" first: registered here, its labels do not depend
    // on the fonts installed on the machine running the tests.
    napi.GlobalFonts.registerFromPath(font, 'Liberation Sans');
  } catch {
    napi = null;
  }
  return napi;
}

function pdfString(text: string): string {
  return `(${text.replace(/([\\()])/g, '\\$1')})`;
}

/** A word as the layer's WinAnsi font can hold it: without diacritics, as an OCR that drops them reads it ("Żółć" -> "Zolc"). */
function layerWord(word: string): string {
  return word.replace(/ł/g, 'l').replace(/Ł/g, 'L').normalize('NFD').replace(/[^\x20-\x7e]/g, '');
}

export async function buildScanPdf(pages: Array<ScanPageSpec | TextPageSpec>): Promise<ScanPdf | undefined> {
  const mod = await canvasModule();
  if (!mod) return undefined;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const widthPx = Math.round((PAGE_PT[0] / 72) * SCAN_DPI);
  const heightPx = Math.round((PAGE_PT[1] / 72) * SCAN_DPI);
  const fontPx = (FONT_PT / 72) * SCAN_DPI;
  const toPt = (px: number): number => (px * 72) / SCAN_DPI;
  const words: PaintedWord[] = [];

  pages.forEach((spec, pageIndex) => {
    const page = doc.addPage(PAGE_PT);
    page.node.setFontDictionary(PDFName.of('F1'), helvetica.ref);
    page.node.setFontDictionary(PDFName.of('F2'), courier.ref);
    if (spec.kind === 'text') {
      let ops = spec.lines.map((line, i) => `BT /F1 ${FONT_PT} Tf 72 ${700 - i * 18} Td ${pdfString(line)} Tj ET`).join('\n');
      if (spec.image) {
        // The image: 360 x 80 pt at 72 pt from the left, its top 300 pt below the page's top.
        const [ix, itop, iw, ih] = [72, 300, 360, 80];
        const pw = Math.round((iw / 72) * SCAN_DPI);
        const ph = Math.round((ih / 72) * SCAN_DPI);
        const img = mod.createCanvas(pw, ph);
        const ictx = img.getContext('2d');
        ictx.fillStyle = '#ffffff';
        ictx.fillRect(0, 0, pw, ph);
        ictx.font = `${fontPx}px ScanSans`;
        ictx.textBaseline = 'alphabetic';
        const space = ictx.measureText(' ').width;
        const ox = (ix / 72) * SCAN_DPI;
        const oy = (itop / 72) * SCAN_DPI;
        spec.image.lines.forEach((line, li) => {
          const baseline = 50 + li * LINE_PX;
          let x = 20;
          for (const word of line) {
            const value = spec.image!.values.includes(word);
            ictx.fillStyle = value ? '#d01010' : '#111111';
            ictx.fillText(word, x, baseline);
            const w = ictx.measureText(word).width;
            words.push({ page: pageIndex, text: word, value, x0: ox + x, y0: oy + baseline - fontPx * 0.75, x1: ox + x + w, y1: oy + baseline + fontPx * 0.05, valueEnd: ox + x + w, inImage: { baseline: oy + baseline } });
            x += w + space;
          }
        });
        const rgba = ictx.getImageData(0, 0, pw, ph).data;
        const rgb = new Uint8Array(pw * ph * 3);
        for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
        const image = doc.context.register(doc.context.flateStream(rgb, { Type: 'XObject', Subtype: 'Image', Width: pw, Height: ph, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }));
        page.node.Resources()?.set(PDFName.of('XObject'), doc.context.obj({ Im1: image }));
        ops += `\nq ${iw} 0 0 ${ih} ${ix} ${PAGE_PT[1] - itop - ih} cm /Im1 Do Q`;
      }
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(ops))));
      return;
    }

    const canvas = mod.createCanvas(widthPx, heightPx);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.font = `${fontPx}px ScanSans`;
    ctx.textBaseline = 'alphabetic';
    const space = ctx.measureText(' ').width;
    const layer: string[] = [];
    const scale = spec.ocrScale ?? 1;
    spec.lines.forEach((line, li) => {
      const baseline = TOP_PX + li * LINE_PX;
      let x = LEFT_PX;
      for (const word of line) {
        // The value part of the word in red, glued punctuation after it in black.
        const valuePart = spec.values.find((v) => word.startsWith(v));
        const value = valuePart !== undefined;
        ctx.fillStyle = value ? '#d01010' : '#111111';
        ctx.fillText(valuePart ?? word, x, baseline);
        if (valuePart !== undefined && valuePart !== word) {
          ctx.fillStyle = '#111111';
          ctx.fillText(word.slice(valuePart.length), x + ctx.measureText(valuePart).width, baseline);
        }
        const w = ctx.measureText(word).width;
        const valueEnd = valuePart !== undefined ? x + ctx.measureText(valuePart).width : x + w;
        words.push({ page: pageIndex, text: word, value, x0: x, y0: baseline - fontPx, x1: x + w, y1: baseline + fontPx * 0.3, valueEnd });
        if (spec.layer === 'tess') {
          // As Tesseract's renderer: the word and its trailing space, stretched together (Tz) over the
          // word's width in the picture; Courier advances 600 units per letter.
          const tz = (toPt(w) / ((600 / 1000) * FONT_PT * (layerWord(word).length + 1))) * 100;
          layer.push(`/F2 ${FONT_PT} Tf ${tz.toFixed(2)} Tz 1 0 0 1 ${toPt(x).toFixed(2)} ${(PAGE_PT[1] - toPt(baseline)).toFixed(2)} Tm ${pdfString(`${layerWord(word)} `)} Tj`);
        } else {
          layer.push(`1 0 0 1 ${toPt(x).toFixed(2)} ${(PAGE_PT[1] - toPt(baseline)).toFixed(2)} Tm ${pdfString(`${layerWord(word)} `)} Tj`);
        }
        x += w + space;
      }
    });

    (spec.unreadLines ?? []).forEach((line, li) => {
      const baseline = TOP_PX + (spec.lines.length + 1 + li) * LINE_PX;
      let ux = LEFT_PX;
      for (const word of line) {
        const value = spec.values.includes(word);
        ctx.fillStyle = value ? '#d01010' : '#111111';
        ctx.fillText(word, ux, baseline);
        const w = ctx.measureText(word).width;
        words.push({ page: pageIndex, text: word, value, x0: ux, y0: baseline - fontPx * 0.75, x1: ux + w, y1: baseline + fontPx * 0.05, valueEnd: ux + w, unread: { baseline } });
        ux += w + space;
      }
    });
    (spec.junkLines ?? []).forEach((line, li) => {
      const baseline = TOP_PX + (spec.lines.length + 1 + (spec.unreadLines?.length ?? 0) + li) * LINE_PX;
      let jx = LEFT_PX;
      for (const word of line.words) {
        const value = spec.values.includes(word);
        ctx.fillStyle = value ? '#d01010' : '#111111';
        ctx.fillText(word, jx, baseline);
        const w = ctx.measureText(word).width;
        words.push({ page: pageIndex, text: word, value, x0: jx, y0: baseline - fontPx * 0.75, x1: jx + w, y1: baseline + fontPx * 0.05, valueEnd: jx + w, unread: { baseline } });
        jx += w + space;
      }
      // The junk is stretched over the printed line, as an OCR layer places what it misread.
      const tz = (toPt(jx - space - LEFT_PX) / ((556 / 1000) * FONT_PT * line.junk.length)) * 100;
      layer.push(`${tz.toFixed(2)} Tz 1 0 0 1 ${toPt(LEFT_PX).toFixed(2)} ${(PAGE_PT[1] - toPt(baseline)).toFixed(2)} Tm ${pdfString(line.junk)} Tj ${(scale * 100).toFixed(1)} Tz`);
    });
    const rgba = ctx.getImageData(0, 0, widthPx, heightPx).data;
    const rgb = new Uint8Array(widthPx * heightPx * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    const image = doc.context.register(doc.context.flateStream(rgb, {
      Type: 'XObject', Subtype: 'Image', Width: widthPx, Height: heightPx, ColorSpace: 'DeviceRGB', BitsPerComponent: 8,
    }));
    const text = `BT /F1 ${FONT_PT} Tf ${(scale * 100).toFixed(1)} Tz ${layer.join(' ')} ET`;
    const picture = `q ${PAGE_PT[0]} 0 0 ${PAGE_PT[1]} 0 0 cm /Im0 Do Q`;
    const xobjects: Record<string, unknown> = { Im0: image };
    let content: string;
    if (spec.layer === 'alpha') {
      const form = doc.context.register(doc.context.flateStream(new TextEncoder().encode(`q /GS1 gs ${text} Q`), {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, PAGE_PT[0], PAGE_PT[1]],
        Resources: { ExtGState: { GS1: { Type: 'ExtGState', ca: 0 } }, Font: { F1: helvetica.ref } },
      }));
      xobjects.Fm1 = form;
      content = `${picture}\nq /Fm1 Do Q`;
    } else if (spec.layer === 'tr3' || spec.layer === 'tess') {
      content = `${picture}\n${text.replace('BT ', 'BT 3 Tr ')}`;
    } else if (spec.layer === 'under') {
      content = `${text}\n${picture}`;
    } else {
      content = picture;
    }
    const resources = page.node.Resources();
    resources?.set(PDFName.of('XObject'), doc.context.obj(xobjects as Parameters<typeof doc.context.obj>[0]));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(new TextEncoder().encode(content))));
  });

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, words, widthPx, heightPx };
}
