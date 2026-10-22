// Synthetic "scanned" PDFs for the scan-page tests (T235): each page is a picture of text
// drawn with @napi-rs/canvas (redacted values in red, so a leftover pixel of a value is easy to
// find), plus an OCR text layer the way scanners write one:
//   'alpha' - text in a form XObject under an ExtGState with /ca 0 (Lutecia / 3-Heights, the
//             file of DocCloak.Core#1),
//   'tr3'   - text in render mode 3 (Tesseract, ocrmypdf, Acrobat),
//   'under' - visible text painted first and the picture over it ("text under the page image"),
//   'none'  - the picture only (a scan without OCR).
// `ocrScale` narrows the OCR layer's letters (Tz), as OCR layers set in their own font do.
// Returns undefined when the native canvas module is not available (tests then skip).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from '@cantoo/pdf-lib';

export type OcrLayer = 'alpha' | 'tr3' | 'under' | 'none';

export interface ScanPageSpec {
  kind: 'scan';
  /** Lines of words; a word in `values` is painted red. */
  lines: string[][];
  values: string[];
  layer: OcrLayer;
  /** Horizontal scale of the OCR layer's text relative to the picture (default 1). */
  ocrScale?: number;
}

export interface TextPageSpec {
  kind: 'text';
  lines: string[];
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

export async function buildScanPdf(pages: Array<ScanPageSpec | TextPageSpec>): Promise<ScanPdf | undefined> {
  const mod = await canvasModule();
  if (!mod) return undefined;
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const widthPx = Math.round((PAGE_PT[0] / 72) * SCAN_DPI);
  const heightPx = Math.round((PAGE_PT[1] / 72) * SCAN_DPI);
  const fontPx = (FONT_PT / 72) * SCAN_DPI;
  const toPt = (px: number): number => (px * 72) / SCAN_DPI;
  const words: PaintedWord[] = [];

  pages.forEach((spec, pageIndex) => {
    const page = doc.addPage(PAGE_PT);
    page.node.setFontDictionary(PDFName.of('F1'), helvetica.ref);
    if (spec.kind === 'text') {
      const ops = spec.lines.map((line, i) => `BT /F1 ${FONT_PT} Tf 72 ${700 - i * 18} Td ${pdfString(line)} Tj ET`).join('\n');
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
        const value = spec.values.includes(word);
        ctx.fillStyle = value ? '#d01010' : '#111111';
        ctx.fillText(word, x, baseline);
        const w = ctx.measureText(word).width;
        words.push({ page: pageIndex, text: word, value, x0: x, y0: baseline - fontPx, x1: x + w, y1: baseline + fontPx * 0.3 });
        layer.push(`1 0 0 1 ${toPt(x).toFixed(2)} ${(PAGE_PT[1] - toPt(baseline)).toFixed(2)} Tm ${pdfString(`${word} `)} Tj`);
        x += w + space;
      }
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
    } else if (spec.layer === 'tr3') {
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
