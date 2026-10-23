/**
 * @doccloak/core/pdf - writer (T213).
 *
 * writeAnonymizedPdfWithReport takes an extraction plus flat-text
 * replacements and produces a redacted PDF:
 *
 * 1. re-extract the input bytes (deterministic) and confirm the flat text is
 *    unchanged, so offsets are trustworthy (StaleAnalysisError otherwise);
 * 2. layer zero: every other occurrence of a session value in the text
 *    becomes a replacement too (as the docx writer scrubs all XML parts);
 * 3. plan placeholders (font choice, fit) and rewrite the content streams;
 * 4. scrub ToUnicode CMaps of edited fonts down to the codes still used,
 *    strip ActualText/Alt properties, drop annotations and page actions;
 * 5. rebuild the output as a FRESH document (pdf-lib copyPages): only objects
 *    reachable from the kept pages survive; Info, XMP, outlines, forms,
 *    attachments, JavaScript, named destinations, structure tree and the
 *    incremental-update history of the input never reach the output;
 * 6. pages that cannot be edited safely are rendered by pdf.js and replaced
 *    by an image with the redacted regions blacked out in the pixels; scan
 *    pages whose OCR text layer holds a redacted value are rendered at the
 *    scan's resolution with each value covered and its placeholder painted in;
 * 7. verify the output with both extractors and a byte scan; refuse on any trace.
 */

import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from '@cantoo/pdf-lib';
import { PDFRef } from '@cantoo/pdf-lib';
import { UnsupportedDocumentError } from '../dom/errors.ts';
import type { ValueReplacement } from '../docx.ts';
import { normalizeReplacements } from '../docx.ts';
import { extractPdf } from './extract.ts';
import type { ExtractionResult, PageRecord, PdfModel, StreamRecord } from './extract.ts';
import { FallbackFontEmbedder, FallbackFontProvider, faceFor } from './fallback-fonts.ts';
import type { LoadedFont } from './fonts.ts';
import { getDict, getStream, refOf, resolve } from './objects.ts';
import type { PDFObject } from './objects.ts';
import { findOccurrences, openWithOracle, searchIndex } from './oracle.ts';
import type { CanvasFactory, OracleDocument } from './oracle.ts';
import { rasterizePage, rasterizeScanPage } from './raster.ts';
import type { PaintMark } from './raster.ts';
import { helveticaWidth } from './standard-metrics.ts';
import { serializeToUnicode } from './cmap.ts';
import type { ToUnicodeEntry } from './cmap.ts';
import { planEdits, rewriteStream, segmentsFor } from './surgery.ts';
import type { PlaceholderResolver, Segment } from './surgery.ts';
import type { GlyphRun, PdfWriteOptions, PdfWriteResult, Rect } from './types.ts';
import { PdfVerifyError, verifyPdf } from './verify.ts';
import type { PdfExtraction } from './read.ts';
import { lexContent } from './lexer.ts';
import { mul } from './textstate.ts';
import type { Matrix } from './types.ts';

/** Scan pages render at the scan's own resolution, up to this. */
const MAX_SCAN_DPI = 300;
/** Pixel budget of one rendered scan page (a 300 dpi A3 page fits; larger pages render coarser). */
const MAX_SCAN_PIXELS = 40_000_000;

/** Same normalised date the docx writer stamps. */
export const NORMALISED_PDF_DATE = new Date('2000-01-01T00:00:00Z');

export class StalePdfExtractionError extends Error {
  constructor() {
    super('The PDF bytes no longer produce the analysed text; re-run readPdf on this file.');
    this.name = 'StalePdfExtractionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PdfWriteOptionsInternal extends PdfWriteOptions {
  /** Node/tests: canvas factory for rasterization. Browsers use OffscreenCanvas. */
  canvasFactory?: CanvasFactory;
}

interface Replacement { start: number; end: number; replacement: string }

export async function writeAnonymizedPdfWithReport(
  extraction: PdfExtraction,
  replacements: Replacement[],
  valueReplacements: ValueReplacement[] = [],
  options: PdfWriteOptionsInternal = {},
): Promise<PdfWriteResult> {
  const warnings: string[] = [];
  const assets = options.assets ?? extraction.assets ?? {};
  validateReplacements(extraction.plainText, replacements, valueReplacements);

  if (extraction.unredactable.length > 0 && !options.allowUnredactable) {
    throw new UnsupportedDocumentError(
      'unredactable-parts',
      `PDF holds parts DocCloak cannot redact: ${extraction.unredactable.map((u) => u.part).join(', ')}`,
      extraction.unredactable.map((u) => u.part),
    );
  }
  for (const u of extraction.unredactable) warnings.push(`${u.label} (exported as is)`);

  // Steps 1-6 run in their own scope so the glyph model of the input (three copies of every
  // glyph would otherwise live until the verifier is done) can be collected before verification.
  const produced = await (async () => {
    // 1. Fresh, deterministic re-extraction (the input bytes are the source of truth).
    const oracle = await openWithOracle(extraction.bytes, assets, extraction.password);
    let fresh: ExtractionResult;
    try {
      fresh = await extractPdf(extraction.bytes, { oracle, password: extraction.password, maxBytes: Number.MAX_SAFE_INTEGER, maxPages: Number.MAX_SAFE_INTEGER, extraOcr: extraction.extraOcr });
    } catch (err) {
      await oracle.close();
      throw err;
    }
    if (fresh.plainText !== extraction.plainText) {
      await oracle.close();
      throw new StalePdfExtractionError();
    }
    const model = fresh.model;

    try {
      // 2. Layer zero: every occurrence of every value.
      const all = normalizeReplacements(withLayerZero(fresh.plainText, replacements, valueReplacements));
      const needles = new Set<string>();
      for (const r of all) needles.add(fresh.plainText.slice(r.start, r.end));
      for (const v of valueReplacements) if (v.value.trim().length >= 2) needles.add(v.value);

      // 3. Segments and plan.
      const segments = segmentsFor(fresh.runs, all);
      const provider = new FallbackFontProvider(assets);
      const outDoc = await PDFDocument.create({ updateMetadata: false });
      const embedder = new FallbackFontEmbedder(outDoc, provider, 'DCFb');
      const usedResourceNames = collectResourceNames(model);
      const resolver: PlaceholderResolver = async (font: LoadedFont, text: string) => {
        const own = font.encode(text);
        if (own) {
          return { bytes: own.bytes, widthPerEm: own.width, resourceName: '', originalFont: true, codes: own.codes };
        }
        const face = faceFor(font.style);
        const embedded = await embedder.ensure(face);
        if (!embedded.canShow(text)) {
          warnings.push(`placeholder "${text}" holds characters the replacement font cannot show (for example CJK or emoji); they are written as '?'. Use Latin letters and digits in placeholders`);
          text = [...text].map((ch) => (embedded.canShow(ch) ? ch : '?')).join('');
        }
        const bytes = embedded.encode(text);
        const widthPerEm = embedded.measure(text, 1) * 1000;
        const resourceName = uniqueResourceName(embedded.resourceName, usedResourceNames);
        return { bytes, widthPerEm, resourceName, originalFont: false, codes: [] };
      };
      const plan = await planEdits(model, fresh.runs, segments, all, resolver, options.fit);
      warnings.push(...plan.warnings);

      // Which pages must be rasterized: unsafe pages that carry an edit.
      const editedPages = new Set<number>();
      for (const s of segments) editedPages.add(s.run.page);
      const rasterPages = new Set<number>();
      for (const page of model.pages) {
        if (!editedPages.has(page.index)) continue;
        if (page.issues.length > 0 || page.oracleText) rasterPages.add(page.index);
      }
      // Scan pages: an edit in an OCR text layer would leave the value in the picture under it, so the
      // page is rendered and the value painted over where the layer says it is.
      const scanPages = new Set<number>();
      for (const s of segments) if (s.run.ocr && !rasterPages.has(s.run.page)) scanPages.add(s.run.page);
      const paintedPages = new Set([...rasterPages, ...scanPages]);
      // Text in a pattern cell or soft-mask group cannot be blacked out in a raster (the cell is tiled
      // over its fill area, the group sits behind a mask): such a page must be edited in place or not at all.
      const hostile = [...paintedPages].filter((p) => model.pages[p]?.hostile);
    if (hostile.length > 0) {
      throw new UnsupportedDocumentError(
        'unredactable-parts',
        `pages ${hostile.map((p) => p + 1).join(', ')} hold content a viewer cannot render safely (rasterization refused)`,
        hostile.map((p) => `page ${p + 1}`),
      );
    }
    const rasterWithAux = [...paintedPages].filter((p) => segments.some((sg) => sg.run.page === p && sg.run.space));
      if (rasterWithAux.length > 0) {
        throw new UnsupportedDocumentError(
          'unredactable-parts',
          `pages ${rasterWithAux.map((p) => p + 1).join(', ')} hold redacted text inside a pattern or soft mask and cannot be rasterized safely`,
          rasterWithAux.map((p) => `page ${p + 1}`),
        );
      }
      if (rasterPages.size > 0 && options.rasterizeUnsafePages === false) {
        throw new UnsupportedDocumentError(
          'unredactable-parts',
          `pages ${[...rasterPages].map((p) => p + 1).join(', ')} cannot be redacted without rasterization`,
          [...rasterPages].map((p) => `page ${p + 1}`),
        );
      }

      // 4. Rewrite streams (skip streams that only belong to raster pages).
      const rewrittenFor = new Map<string, Set<string>>(); // page -> resource names to add
      const usedCodes = new Map<string, Set<number>>();
      const removedSequences: Array<{ fontKey: string; bytes: Uint8Array; codeLength: number }> = [];
      const editedFonts = new Set<string>();
      const runsByStreamOp = indexRuns(fresh.runs);
      const streamsToRewrite = new Set<string>();
      for (const key of plan.byStream.keys()) streamsToRewrite.add(key);
      for (const [key, stream] of model.streams) {
        if (streamNeedsScrub(stream) || [...plan.shiftedRuns.keys()].some((k) => k.startsWith(`${key}#`))) streamsToRewrite.add(key);
      }
      for (const key of streamsToRewrite) {
        const stream = model.streams.get(key);
        if (!stream) continue;
        if ([...stream.pages].every((p) => paintedPages.has(p))) continue;
        const segs = (plan.byStream.get(key) ?? []).filter((s) => !paintedPages.has(s.run.page));
        const result = rewriteStream(model, stream, runsByStreamOp.get(key) ?? new Map(), segs, plan.shiftedRuns);
        for (const [k, codes] of result.usedCodes) mergeCodes(usedCodes, k, codes);
        removedSequences.push(...result.removedSequences);
        for (const f of result.editedFonts) editedFonts.add(f);
        replaceStreamBytes(model, stream, result.bytes);
        const names = plan.resourcesNeeded.get(key);
        if (names) rewrittenFor.set(key, names);
      }
      // Codes of untouched streams still count as used.
      for (const [key, stream] of model.streams) {
        if (streamsToRewrite.has(key)) continue;
        for (const run of runsByStreamOp.get(key)?.values() ?? []) mergeCodes(usedCodes, run.fontKey, run.glyphs.map((g) => g.code));
        void stream;
      }
      scrubToUnicode(model, editedFonts, usedCodes, warnings);
      scrubSourceSideChannels(model);

      // 5. Rebuild into the fresh document.
      const keptIndexes = model.pages.map((p) => p.index).filter((i) => !paintedPages.has(i));
      const copied = keptIndexes.length > 0 ? await outDoc.copyPages(model.doc, keptIndexes) : [];
      const copiedByIndex = new Map<number, (typeof copied)[number]>();
      keptIndexes.forEach((idx, k) => copiedByIndex.set(idx, copied[k]));

      const rasterized: number[] = [];
      const scanned: number[] = [];
      const sortedReplacements = [...all].sort((a, b) => a.start - b.start || a.end - b.end); // segmentsFor's order
      for (const page of model.pages) {
        if (scanPages.has(page.index)) {
          const marks = withTextColumn(paintMarksForPage(segments, page.index, sortedReplacements), extraction.runs, page.index);
          let raster: Awaited<ReturnType<typeof rasterizeScanPage>>;
          try {
            raster = await rasterizeScanPage(oracle, page.index, marks, { dpi: scanDpi(page, options.rasterDpi), canvasFactory: options.canvasFactory });
          } catch (err) {
            throw new UnsupportedDocumentError('unredactable-parts', `page ${page.index + 1} cannot be rendered: ${(err as Error).message ?? String(err)}`, [`page ${page.index + 1}`]);
          }
          // Raw pixels in a Flate image (gray for a gray scan): lossless, and far smaller than an RGBA PNG.
          const image = outDoc.context.register(outDoc.context.flateStream(raster.pixels, {
            Type: 'XObject',
            Subtype: 'Image',
            Width: raster.widthPx,
            Height: raster.heightPx,
            ColorSpace: raster.channels === 1 ? 'DeviceGray' : 'DeviceRGB',
            BitsPerComponent: 8,
          }));
          const newPage = outDoc.addPage([raster.widthPt, raster.heightPt]);
          const name = newPage.node.newXObject('Scan', image);
          newPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(raster.widthPt, 0, 0, raster.heightPt, 0, 0), drawObject(name), popGraphicsState());
          // The page stays searchable: its text, values replaced by their placeholders, as an
          // invisible layer over the picture (as the scan's own OCR layer was).
          // Source user space -> picture pixels (the render) -> the picture page's user space.
          const [ta, tb, tc, td, te, tf] = raster.transform;
          const sx = raster.widthPt / raster.widthPx;
          const sy = raster.heightPt / raster.heightPx;
          const toPage: Matrix = [sx * ta, -sy * tb, sx * tc, -sy * td, sx * te, raster.heightPt - sy * tf];
          const layer = await searchableTextLayer(fresh.runs, segments, page.index, sortedReplacements, embedder, toPage);
          if (layer) {
            newPage.node.setFontDictionary(PDFName.of(layer.fontName), layer.fontRef);
            newPage.node.addContentStream(outDoc.context.register(outDoc.context.flateStream(layer.content)));
          }
          scanned.push(page.index);
          warnings.push(`page ${page.index + 1}: scan with an OCR text layer; the values are painted over in the picture with their placeholders and the page is exported as an image, with its text (placeholders in place of the values) as an invisible layer`);
          continue;
        }
        if (rasterPages.has(page.index)) {
          const boxes = boxesForPage(segments, page.index, fresh.runs, page, [...needles]);
          const dpi = options.rasterDpi ?? 150;
          let raster: Awaited<ReturnType<typeof rasterizePage>>;
          try {
            raster = await rasterizePage(oracle, page.index, boxes, { dpi, canvasFactory: options.canvasFactory });
          } catch (err) {
            // pdf.js (or the canvas) could not render the page: nothing safe can be exported for it.
            throw new UnsupportedDocumentError('unredactable-parts', `page ${page.index + 1} cannot be rasterized: ${(err as Error).message ?? String(err)}`, [`page ${page.index + 1}`]);
          }
          const img = await outDoc.embedPng(raster.png);
          const newPage = outDoc.addPage([raster.widthPt, raster.heightPt]);
          newPage.drawImage(img, { x: 0, y: 0, width: raster.widthPt, height: raster.heightPt });
          rasterized.push(page.index);
          warnings.push(`page ${page.index + 1}: rasterized (${page.issues[0] ?? 'unsafe to edit'}); its text layer is gone`);
          continue;
        }
        const cp = copiedByIndex.get(page.index);
        if (!cp) continue;
        outDoc.addPage(cp);
        // Fallback font resources for this page's streams.
        for (const key of page.streams) {
          const names = rewrittenFor.get(key);
          if (!names) continue;
          const stream = model.streams.get(key);
          if (!stream) continue;
          for (const name of names) {
            const font = embedder.fonts().find((f) => name === f.resourceName || name.startsWith(`${f.resourceName}x`));
            if (!font) continue;
            addFontResource(outDoc, cp.node, stream, name, font.pdfFont.ref, model);
          }
        }
      }
      // Optional-content (layer) configuration is not carried over: pdf-lib's page copier would duplicate
      // the OCG dictionaries, leaving the configuration pointing at orphans. Hidden layers become visible,
      // which is the safe direction for a redaction (nothing stays hidden); reported as 'optional-content'.
      scrubOutputObjects(outDoc);
      stampMetadata(outDoc);

      const bytes = await outDoc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
      return { bytes, needles: [...needles], removedSequences, rasterized, scanned, shiftedLines: plan.shiftedLines, removed: fresh.removed, placeholders: [...new Set(all.map((r) => r.replacement))] };
    } finally {
      await oracle.close();
    }
  })();

  // 7. Verify.
  if (!options.skipVerify) {
    const outOracle = await openWithOracle(produced.bytes, assets);
    let findings;
    try {
      findings = await verifyPdf({ bytes: produced.bytes, needles: produced.needles, removedSequences: produced.removedSequences, oracle: outOracle, placeholders: produced.placeholders });
    } finally {
      await outOracle.close();
    }
    if (findings.length > 0) throw new PdfVerifyError(findings);
  }

  return {
    blob: new Blob([produced.bytes], { type: 'application/pdf' }),
    warnings: [...new Set(warnings)],
    removed: produced.removed,
    rasterizedPages: produced.rasterized,
    scanPages: produced.scanned,
    shiftedLines: produced.shiftedLines,
  };
}

/* ------------------------------------------------------------------ */

function withLayerZero(text: string, replacements: Replacement[], values: ValueReplacement[]): Replacement[] {
  const out = [...replacements];
  const mark = new Uint8Array(text.length + 1);
  for (const r of replacements) mark.fill(1, Math.max(0, r.start), Math.min(text.length, r.end));
  const covered = (a: number, b: number): boolean => {
    for (let i = a; i < b; i++) if (mark[i]) return true;
    return false;
  };
  // Every other occurrence of a value (found the way the verifier looks for it: whitespace, hyphens
  // and ligatures ignored, case folded, at token boundaries) becomes a replacement too, so a value
  // wrapped over a line end, spaced differently by the layout or set with a ligature never survives.
  const index = searchIndex(text);
  // Longest value first: "Zielinski Kowalski" must win over "Zielinski", or the surname would stay.
  const ordered = [...values].sort((a, b) => b.value.length - a.value.length);
  for (const v of ordered) {
    for (const [start, end] of findOccurrences(index, v.value)) {
      if (covered(start, end)) continue;
      out.push({ start, end, replacement: v.replacement });
      mark.fill(1, start, end);
    }
  }
  return out;
}

/**
 * Offsets that do not belong to this text are a stale or foreign analysis: refuse rather than
 * clamp (a range clamped to the whole document would redact everything, silently).
 */
function validateReplacements(text: string, replacements: Replacement[], values: ValueReplacement[]): void {
  for (const r of replacements) {
    if (typeof r.replacement !== 'string') throw new TypeError('replacement text must be a string');
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end > text.length || r.start > r.end) {
      throw new StalePdfExtractionError();
    }
  }
  for (const v of values) {
    if (typeof v.value !== 'string' || typeof v.replacement !== 'string') throw new TypeError('value replacements must be strings');
  }
}

function indexRuns(runs: GlyphRun[]): Map<string, Map<number, GlyphRun>> {
  const out = new Map<string, Map<number, GlyphRun>>();
  for (const run of runs) {
    if (run.oracle) continue;
    let m = out.get(run.streamKey);
    if (!m) { m = new Map(); out.set(run.streamKey, m); }
    if (!m.has(run.opIndex)) m.set(run.opIndex, run);
  }
  return out;
}

function mergeCodes(target: Map<string, Set<number>>, key: string, codes: Iterable<number>): void {
  let set = target.get(key);
  if (!set) { set = new Set(); target.set(key, set); }
  for (const c of codes) set.add(c);
}

function streamNeedsScrub(stream: StreamRecord): boolean {
  return stream.ops.some((op) => op.op === 'BDC' && op.operands[1]?.kind === 'dict'
    && ['ActualText', 'Alt', 'E'].some((k) => (op.operands[1] as { entries: Map<string, unknown> }).entries.has(k)));
}

function collectResourceNames(model: PdfModel): Set<string> {
  const names = new Set<string>();
  for (const stream of model.streams.values()) {
    const fonts = getDict(model.ctx, stream.resources, 'Font');
    if (fonts) for (const [k] of fonts.entries()) names.add(k.decodeText());
  }
  return names;
}

function uniqueResourceName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}x${i}`)) i++;
  return `${base}x${i}`;
}

/** Replace a stream's bytes in the source document (page contents or form XObject). */
function replaceStreamBytes(model: PdfModel, stream: StreamRecord, bytes: Uint8Array): void {
  const { ctx } = model;
  if (stream.kind === 'page') {
    const page = model.pages[stream.page];
    const ref = ctx.register(ctx.flateStream(bytes));
    page.dict.set(PDFName.of('Contents'), ref);
    return;
  }
  if (stream.ref && stream.stream) {
    const dict: Record<string, unknown> = {};
    for (const [k, v] of stream.stream.dict.entries()) {
      const key = k.decodeText();
      if (key === 'Length' || key === 'Filter' || key === 'DecodeParms') continue;
      dict[key] = v;
    }
    const fresh = ctx.flateStream(bytes, dict as Parameters<typeof ctx.flateStream>[1]);
    ctx.assign(stream.ref, fresh);
    stream.stream = fresh;
  }
}

/** Rewrite the ToUnicode CMap of every edited font so only codes still shown remain. */
function scrubToUnicode(model: PdfModel, editedFonts: Set<string>, usedCodes: Map<string, Set<number>>, warnings: string[]): void {
  const { ctx } = model;
  for (const key of editedFonts) {
    const font = model.fonts.get(key);
    if (!font) continue;
    const tuRef = refOf(font.dict, 'ToUnicode');
    const tu = getStream(ctx, font.dict, 'ToUnicode');
    if (!tu) continue;
    if (!font.toUnicode?.unicodeMap) {
      // Unparsable map on an edited font: drop it rather than ship a CMap we could not read.
      font.dict.delete(PDFName.of('ToUnicode'));
      warnings.push(`font ${font.baseFont}: unreadable ToUnicode map removed`);
      continue;
    }
    const used = usedCodes.get(key) ?? new Set<number>();
    const entries: ToUnicodeEntry[] = [];
    for (const [code, unicode] of font.toUnicode.unicodeMap) {
      if (!used.has(code)) continue;
      entries.push({ code, length: font.codeLength(code), unicode });
    }
    const bytes = serializeToUnicode(entries, { name: 'DocCloak-ToUnicode', codespace: font.toUnicode.codespace });
    // Always a new object: several font dicts may share one ToUnicode stream, and each edited font
    // keeps a different code set.
    font.dict.set(PDFName.of('ToUnicode'), ctx.register(ctx.flateStream(bytes)));
    void tuRef;
  }
}


/** Remove per-page side channels and named marked-content properties in the source before copying. */
function scrubSourceSideChannels(model: PdfModel): void {
  const { ctx } = model;
  const pageKeys = ['Annots', 'AA', 'Metadata', 'Thumb', 'StructParents', 'PieceInfo', 'B', 'Dur', 'Trans', 'PZ', 'SeparationInfo', 'VP', 'AF', 'OutputIntents'];
  for (const page of model.pages) {
    for (const k of pageKeys) page.dict.delete(PDFName.of(k));
  }
  const seen = new Set<PDFDict>();
  for (const stream of model.streams.values()) {
    const props = getDict(ctx, stream.resources, 'Properties');
    if (!props) continue;
    for (const [, v] of props.entries()) {
      const d = resolve(ctx, v);
      if (d && typeof (d as PDFDict).delete === 'function' && !seen.has(d as PDFDict)) {
        seen.add(d as PDFDict);
        for (const k of ['ActualText', 'Alt', 'E']) (d as PDFDict).delete(PDFName.of(k));
      }
    }
    // Resource-level XObjects/Fonts keep their dicts; ToUnicode handled above.
  }
}

/** Add a fallback font under `name` to the resources of the (copied) stream: page resources or the form's own. */
function addFontResource(outDoc: PDFDocument, pageNode: PDFDict, stream: StreamRecord, name: string, ref: PDFRef, model: PdfModel): void {
  const ctx = outDoc.context;
  if (stream.kind === 'page' || !stream.ownResources) {
    // A form without /Resources of its own resolves names through the page's resources (pdf.js and
    // Acrobat both fall back to the parent), so that is where its fallback font must live.
    (pageNode as unknown as { setFontDictionary: (n: PDFName, r: PDFRef) => void }).setFontDictionary(PDFName.of(name), ref);
    return;
  }
  // Form XObject: every copied stream with the same bytes (duplicated forms share the edit).
  for (const target of findCopiedXObjects(outDoc, pageNode, stream, model)) {
    let res = getDict(ctx, target, 'Resources');
    if (!res) {
      res = ctx.obj({});
      target.set(PDFName.of('Resources'), res);
    }
    let fonts = getDict(ctx, res, 'Font');
    if (!fonts) {
      fonts = ctx.obj({});
      res.set(PDFName.of('Font'), fonts);
    }
    fonts.set(PDFName.of(name), ref);
  }
}

function findCopiedXObjects(outDoc: PDFDocument, pageNode: PDFDict, stream: StreamRecord, model: PdfModel): PDFDict[] {
  // Match by BBox + Matrix + decoded length is fragile; instead walk every XObject reachable from the copied
  // page and compare the (already rewritten) stream bytes with the source stream's bytes.
  const ctx = outDoc.context;
  const wanted = stream.stream instanceof PDFRawStream ? stream.stream.contents : undefined;
  const wantedLen = wanted?.length ?? -1;
  const visited = new Set<PDFDict>();
  const queue: PDFDict[] = [];
  const found: PDFDict[] = [];
  const pageRes = getDict(ctx, pageNode, 'Resources');
  if (pageRes) queue.push(pageRes);
  while (queue.length) {
    const res = queue.shift()!;
    if (visited.has(res)) continue;
    visited.add(res);
    const candidates: PDFObject[] = [];
    const xobjs = getDict(ctx, res, 'XObject');
    if (xobjs) for (const [, v] of xobjs.entries()) candidates.push(v);
    const patterns = getDict(ctx, res, 'Pattern');
    if (patterns) for (const [, v] of patterns.entries()) candidates.push(v);
    const states = getDict(ctx, res, 'ExtGState');
    if (states) {
      for (const [, v] of states.entries()) {
        const d = resolve(ctx, v);
        const mask = d instanceof PDFDict ? getDict(ctx, d, 'SMask') : undefined;
        const g = mask?.get(PDFName.of('G'));
        if (g) candidates.push(g);
      }
    }
    for (const v of candidates) {
      const s = resolve(ctx, v);
      if (!(s instanceof PDFRawStream)) continue;
      if (s.contents.length === wantedLen && wanted && sameBytes(s.contents, wanted)) {
        if (!found.includes(s.dict)) found.push(s.dict);
        continue;
      }
      const inner = getDict(ctx, s.dict, 'Resources');
      if (inner) queue.push(inner);
    }
  }
  void model;
  return found;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Side channels that pdf-lib's page copier carries along with the objects a page references:
 * XMP streams on XObjects, fonts or anything else (/Metadata), optional-content group names
 * (/Name of an OCG or OCMD), font descriptor strings (/FontFamily, /CharSet) and /PieceInfo.
 * None of them is needed to render the page; all of them can carry text.
 */
function scrubOutputObjects(outDoc: PDFDocument): void {
  const ctx = outDoc.context;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    scrubDict(ctx, dict, new Set());
  }
}

function scrubDict(ctx: PDFDocument['context'], dict: PDFDict, seen: Set<PDFDict>): void {
  if (seen.has(dict)) return;
  seen.add(dict);
  const type = dict.get(PDFName.of('Type'));
  const typeName = type instanceof PDFName ? type.decodeText() : '';
  // pdf-lib writes every indirect object of the context, reachable or not: an object dropped
  // here must also leave the context, or its bytes would still ship.
  for (const key of ['Metadata', 'PieceInfo']) {
    const v = dict.get(PDFName.of(key));
    if (v === undefined) continue;
    dict.delete(PDFName.of(key));
    if (v instanceof PDFRef) ctx.delete(v);
  }
  if (typeName === 'OCG' || typeName === 'OCMD') dict.set(PDFName.of('Name'), PDFString.of('Layer'));
  if (typeName === 'FontDescriptor') {
    dict.delete(PDFName.of('FontFamily'));
    dict.delete(PDFName.of('CharSet'));
  }
  for (const [, v] of dict.entries()) {
    const inner = v instanceof PDFDict ? v : undefined; // direct dictionaries only; indirect ones are enumerated
    if (inner) scrubDict(ctx, inner, seen);
  }
}

function stampMetadata(outDoc: PDFDocument): void {
  outDoc.setTitle('');
  outDoc.setAuthor('');
  outDoc.setSubject('');
  outDoc.setKeywords([]);
  outDoc.setProducer('DocCloak');
  outDoc.setCreator('DocCloak');
  outDoc.setCreationDate(NORMALISED_PDF_DATE);
  outDoc.setModificationDate(NORMALISED_PDF_DATE);
}

/**
 * Along-baseline [start, end] of every letter of a one-word OCR show whose letters all have the same
 * width (Tesseract's invisible font), from Helvetica proportions spread over the whole show (Tesseract
 * stretches the word and its trailing space over the printed word). Offsets are from the show's
 * first glyph. Null for any other run.
 */
function proportionalLetters(run: GlyphRun, ux: number, uy: number, scale: number): Array<[number, number]> | null {
  const g = run.glyphs;
  if (!run.ocr || g.length < 2) return null;
  let k = g.length;
  while (k > 0 && g[k - 1].unicode.trim() === '') k--;
  if (k < 2 || g.slice(0, k).some((x) => x.unicode.trim() === '')) return null;
  const a0 = g[0].advance;
  if (!(a0 > 0) || g.slice(0, k).some((x) => Math.abs(x.advance - a0) > 0.01 * a0)) return null;
  const last = g[g.length - 1];
  const showEnd = (last.x - g[0].x) * ux + (last.y - g[0].y) * uy + last.advance * scale;
  const widths = g.slice(0, k).map((x) => [...x.unicode].reduce((sum, ch) => sum + helveticaWidth(ch), 0) || 556);
  const total = widths.reduce((a, b) => a + b, 0);
  const spans: Array<[number, number]> = [];
  let at = 0;
  for (const w of widths) {
    const next = at + (w / total) * showEnd;
    spans.push([at, next]);
    at = next;
  }
  for (let i = k; i < g.length; i++) spans.push([showEnd, showEnd]);
  return spans;
}

/** True when every glyph of the run has the same advance: an invisible OCR font (Tesseract's GlyphLessFont). */
function equalAdvances(run: GlyphRun): boolean {
  const a0 = run.glyphs[0]?.advance ?? 0;
  return a0 > 0 && run.glyphs.length >= 2 && run.glyphs.every((g) => Math.abs(g.advance - a0) <= 0.01 * a0);
}

/** Punctuation and symbols that can stick to a value inside one OCR word ("616," "(+48" "12/4."). */
const GLUED_PUNCTUATION = /^[\p{P}\p{S}]+$/u;

/** Text shows have no business holding more than this horizontal stretch (Tz %); beyond it a run is left out. */
const MAX_LAYER_STRETCH = 1000;

/**
 * Invisible text layer for a painted scan page: every text run of the page, with each redacted
 * value replaced by its placeholder (on the value's first piece, nothing on the pieces it wraps
 * onto), shown in render mode 3 in the Liberation Sans fallback face on the run's own baseline and
 * stretched (Tz) over the run's width, so a reader can search and select the page as before and
 * the selection sits over the picture. `toPage` maps the source page's user space to the picture
 * page's (rotation and crop box included).
 */
async function searchableTextLayer(
  runs: GlyphRun[], segments: Segment[], page: number, replacements: Replacement[], embedder: FallbackFontEmbedder, toPage: Matrix,
): Promise<{ content: Uint8Array; fontName: string; fontRef: PDFRef } | null> {
  const pageRuns = runs.filter((r) => r.page === page && !r.space && r.glyphs.length > 0);
  if (pageRuns.length === 0) return null;
  const font = await embedder.ensure(faceFor({ family: 'sans', bold: false, italic: false }));
  const segsByRun = new Map<GlyphRun, Segment[]>();
  const labelled = new Set<number>();
  for (const s of segments) {
    if (s.run.page !== page) continue;
    const list = segsByRun.get(s.run) ?? [];
    list.push(s);
    segsByRun.set(s.run, list);
  }
  // Where each glyph ends along its run's baseline, in user space.
  const glyphEnd = (run: GlyphRun, i: number): { x: number; y: number } => {
    const len = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const k = len / (run.local.fontSize * run.local.hscale || 1);
    const g = run.glyphs[i];
    return { x: g.x + (run.emX[0] / len) * g.advance * k, y: g.y + (run.emX[1] / len) * g.advance * k };
  };
  const ops: string[] = ['q BT 3 Tr'];
  for (const run of pageRuns) {
    const segs = segsByRun.get(run) ?? [];
    let text = '';
    // The show starts at the first glyph that puts text in it: after the end of a value that began
    // in an earlier show (Tesseract writes one show per word), the rest sits where it is printed.
    let first = -1;
    let labelAtEnd: Segment | null = null;
    for (let i = 0; i < run.glyphs.length; i++) {
      const seg = segs.find((s) => i >= s.from && i < s.to);
      if (!seg) {
        if (first < 0) first = i;
        text += run.glyphs[i].unicode;
        if (run.glyphs[i].unicode.trim() !== '') labelAtEnd = null;
        continue;
      }
      if (i === seg.from && !labelled.has(seg.replacementIndex)) {
        labelled.add(seg.replacementIndex);
        if (first < 0) first = i;
        text += replacements[seg.replacementIndex]?.replacement ?? '';
        labelAtEnd = seg;
      }
    }
    text = [...text.replace(/\s+/g, ' ')].map((ch) => (font.canShow(ch) ? ch : '?')).join('');
    if (first < 0 || text.trim() === '') continue;
    const exLen = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const eyLen = Math.hypot(run.emY[0], run.emY[1]) || 1;
    const ux = run.emX[0] / exLen;
    const uy = run.emX[1] / exLen;
    const vx = run.emY[0] / eyLen;
    const vy = run.emY[1] / eyLen;
    const g0 = run.glyphs[first];
    const along = (p: { x: number; y: number }): number => (p.x - g0.x) * ux + (p.y - g0.y) * uy;
    const size = Math.max(...run.glyphs.map((g) => g.fontSize));
    let width = along(glyphEnd(run, run.glyphs.length - 1));
    // A placeholder that ends the show while its value runs on into the next shows of the line
    // spans the whole value, so it selects as one word with whatever follows it.
    if (labelAtEnd) {
      for (const s of segments) {
        if (s.replacementIndex !== labelAtEnd.replacementIndex || s.run === run || s.run.page !== page || s.to <= s.from) continue;
        const end = glyphEnd(s.run, s.to - 1);
        const across = (end.x - g0.x) * vx + (end.y - g0.y) * vy;
        if (Math.abs(across) < 0.4 * size) width = Math.max(width, along(end));
      }
    }
    const natural = font.measure(text, size);
    if (!(width > 0) || !(natural > 0) || !(size > 0)) continue;
    const tz = (100 * width) / natural;
    if (tz > MAX_LAYER_STRETCH) continue;
    const hex = [...font.encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const n = (v: number): string => (Math.abs(v) < 1e-6 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));
    // The run's text matrix, carried into the picture page's user space.
    const tm = mul([ux * size, uy * size, vx * size, vy * size, g0.x, g0.y], toPage);
    ops.push(`/${font.resourceName} 1 Tf ${n(tz)} Tz ${tm.map(n).join(' ')} Tm <${hex}> Tj`);
  }
  if (ops.length === 1) return null;
  ops.push('ET Q');
  return { content: new TextEncoder().encode(ops.join('\n')), fontName: font.resourceName, fontRef: font.pdfFont.ref };
}

/**
 * Resolution for a scan page: the scan's own (at least `base`, at most 300 dpi), within the pixel
 * budget. A text page painted for a value inside one of its images is rendered at 300 dpi: its
 * text is sharp at any size, the image's resolution says nothing about it.
 */
function scanDpi(page: PageRecord, base = 150): number {
  const dpi = page.info.imageOnly ? Math.max(base, Math.min(MAX_SCAN_DPI, Math.round(page.imageDpi))) : MAX_SCAN_DPI;
  const squareInches = Math.max(1e-6, (page.info.width / 72) * (page.info.height / 72));
  return Math.max(36, Math.min(dpi, Math.floor(Math.sqrt(MAX_SCAN_PIXELS / squareInches))));
}

/**
 * Where each redacted value sits on a scan page, for painting: one mark per line a value
 * occupies (the pieces of a value on one line, split across operators, join into one), the
 * placeholder on the value's first line and a blank cover on the lines it wraps onto.
 * Whitespace glyphs at either end of a piece are left out.
 */
export function paintMarksForPage(segments: Segment[], page: number, replacements: Replacement[]): PaintMark[] {
  const marks: PaintMark[] = [];
  let lastIndex = -1;
  for (const s of segments) {
    const run = s.run;
    if (run.page !== page || run.space) continue;
    let from = s.from;
    let to = s.to;
    while (from < to && run.glyphs[from].unicode.trim() === '') from++;
    while (to > from && run.glyphs[to - 1].unicode.trim() === '') to--;
    if (from >= to) continue;
    // An OCR layer knows where its words end, not where their letters do (Tesseract gives every
    // glyph of its invisible font the same width): a value that stops at punctuation glued to it
    // ("616," "12/4,") would end at a guessed point inside its last letter. Such punctuation is
    // covered with the value, so the cover ends where the word does, and painted again as part of
    // the label ("[PHONE_1],"), so the picture reads like the redacted text.
    let after = to;
    let trail = '';
    while (after < run.glyphs.length && run.glyphs[after].unicode.trim() !== '') after++;
    if (after > to && run.glyphs.slice(to, after).every((g) => GLUED_PUNCTUATION.test(g.unicode))) {
      trail = run.glyphs.slice(to, after).map((g) => g.unicode).join('');
      to = after;
    }
    let before = from;
    let lead = '';
    while (before > 0 && run.glyphs[before - 1].unicode.trim() !== '') before--;
    if (before < from && run.glyphs.slice(before, from).every((g) => GLUED_PUNCTUATION.test(g.unicode))) {
      lead = run.glyphs.slice(before, from).map((g) => g.unicode).join('');
      from = before;
    }
    // Tesseract writes each word with its trailing space in an invisible font whose letters all have
    // the same width, and stretches both over the word's box: the letters may reach the end of the
    // show, past the last letter's own advance. When only whitespace follows the value in such a show,
    // the end of the show is where its ink may still be (`reach`). A layer set in a real font is not
    // stretched: its trailing space is the gap before the next word and never belongs to the value.
    let measureTo = to;
    if (run.ocr && to < run.glyphs.length && run.glyphs.slice(to).every((g) => g.unicode.trim() === '') && equalAdvances(run)) measureTo = run.glyphs.length;
    const exLen = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const eyLen = Math.hypot(run.emY[0], run.emY[1]) || 1;
    const ux = run.emX[0] / exLen;
    const uy = run.emX[1] / exLen;
    const vx = run.emY[0] / eyLen;
    const vy = run.emY[1] / eyLen;
    const scale = exLen / (run.local.fontSize * run.local.hscale || 1);
    const first = run.glyphs[from];
    let lo = 0;
    let hi = 0;
    let hiReach = 0;
    let size = 0;
    for (let i = from; i < measureTo; i++) {
      const g = run.glyphs[i];
      const along = (g.x - first.x) * ux + (g.y - first.y) * uy;
      hiReach = Math.max(hiReach, along + g.advance * scale);
      if (i >= to) continue;
      lo = Math.min(lo, along);
      hi = Math.max(hi, along + g.advance * scale);
      size = Math.max(size, g.fontSize);
    }
    const startsInWord = from > 0 && run.glyphs[from - 1].unicode.trim() !== '';
    const endsInWord = to < run.glyphs.length && run.glyphs[to].unicode.trim() !== '';
    // Inside a Tesseract word every letter has the same width: a value that is only part of the word
    // ("2026" of "2026/03/017") is placed by real letter proportions over the printed word instead.
    const spans = (startsInWord || endsInWord) ? proportionalLetters(run, ux, uy, scale) : null;
    if (spans) {
      // Offsets stay relative to the value's first glyph origin, as above.
      const firstAlong = (first.x - run.glyphs[0].x) * ux + (first.y - run.glyphs[0].y) * uy;
      lo = spans[from][0] - firstAlong;
      hi = spans[to - 1][1] - firstAlong;
      hiReach = hi;
    }
    const x = first.x + ux * lo;
    const y = first.y + uy * lo;
    const prev = marks[marks.length - 1];
    if (prev && s.replacementIndex === lastIndex) {
      // Same value: join when this piece continues the previous one's line.
      const across = (x - prev.x) * prev.vx + (y - prev.y) * prev.vy;
      const along = (x - prev.x) * prev.ux + (y - prev.y) * prev.uy;
      const lineSize = Math.max(prev.size, size);
      if (Math.abs(across) < 0.4 * lineSize && along > -0.5 * lineSize && along < prev.length + 2 * lineSize) {
        prev.length = Math.max(prev.length, along + (hi - lo));
        prev.reach = Math.max(prev.reach ?? prev.length, along + (hiReach - lo));
        prev.size = lineSize;
        if (endsInWord) prev.endsInWord = true;
        else delete prev.endsInWord;
        if (prev.labelEnd !== undefined) prev.labelEnd += trail;
        else prev.label += trail;
        continue;
      }
    }
    // The rest of a value wrapped onto the next line shows only the punctuation glued to it, each
    // side where it was printed.
    const rest = s.replacementIndex === lastIndex;
    const label = rest ? lead : lead + (replacements[s.replacementIndex]?.replacement ?? '') + trail;
    marks.push({
      x, y, ux, uy, vx, vy, length: hi - lo, ...(hiReach > hi ? { reach: hiReach - lo } : {}), size, label,
      ...(rest ? { labelEnd: trail } : {}),
      ...(startsInWord ? { startsInWord } : {}), ...(endsInWord ? { endsInWord } : {}),
    });
    lastIndex = s.replacementIndex;
  }
  return marks;
}

/**
 * Share of a page's words that may start before / end after the text column: a margin note runs to
 * a few percent of a page's words; on the right, past ragged line ends, only a page number or a
 * stamp, so the end takes in nearly every line.
 */
const COLUMN_START_OUTLIERS = 0.05;
const COLUMN_END_OUTLIERS = 0.02;

/**
 * The text column each mark's line sits in, along its baseline (`columnStart`, `columnEnd`, user
 * units from the mark's start): where the page's words start and end, without the outlying
 * COLUMN_START_OUTLIERS / COLUMN_END_OUTLIERS, over the words running the same way. A label growing into blank
 * paper beside a short value stays inside it: never into the margin.
 */
export function withTextColumn(marks: PaintMark[], runs: GlyphRun[], page: number): PaintMark[] {
  const words: Array<{ x0: number; y0: number; x1: number; y1: number; ux: number; uy: number }> = [];
  for (const run of runs) {
    if (run.page !== page || run.space || run.glyphs.length === 0) continue;
    const len = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const k = len / (run.local.fontSize * run.local.hscale || 1);
    const ux = run.emX[0] / len;
    const uy = run.emX[1] / len;
    let first = -1;
    for (let i = 0; i <= run.glyphs.length; i++) {
      const blank = i === run.glyphs.length || run.glyphs[i].unicode.trim() === '';
      if (!blank && first < 0) first = i;
      if (blank && first >= 0) {
        const a = run.glyphs[first];
        const b = run.glyphs[i - 1];
        words.push({ x0: a.x, y0: a.y, x1: b.x + ux * b.advance * k, y1: b.y + uy * b.advance * k, ux, uy });
        first = -1;
      }
    }
  }
  const quantile = (values: number[], q: number): number => {
    const sorted = [...values].sort((p, r) => p - r);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  };
  return marks.map((m) => {
    const same = words.filter((w) => w.ux * m.ux + w.uy * m.uy > 0.99);
    if (same.length === 0) return m;
    const starts = same.map((w) => (w.x0 - m.x) * m.ux + (w.y0 - m.y) * m.uy);
    const ends = same.map((w) => (w.x1 - m.x) * m.ux + (w.y1 - m.y) * m.uy);
    return { ...m, columnStart: quantile(starts, COLUMN_START_OUTLIERS), columnEnd: quantile(ends, 1 - COLUMN_END_OUTLIERS) };
  });
}

/**
 * Axis-aligned user-space boxes of every covered glyph on a page (for rasterization). On a page
 * whose text came from pdf.js, our own decoder's glyphs that spell a value are blacked out as
 * well (pdf.js item widths can be wrong for fonts it misreads), and each pdf.js item box is
 * padded by half an em along the baseline.
 */
export function boxesForPage(segments: Segment[], page: number, runs: GlyphRun[], record?: PageRecord, needles: string[] = []): Rect[] {
  void runs;
  const boxes: Rect[] = [];
  const covered: Array<{ run: GlyphRun; from: number; to: number }> = [];
  for (const s of segments) {
    if (s.run.page !== page || s.run.space) continue;
    // Oracle runs (raster-only pages) only know the item's total width, not per-glyph widths: black
    // out one glyph more on each side (plus the half-em pad below) so proportional-width errors
    // cannot leave a fragment; a vertical item is covered whole.
    if (s.run.oracle && s.run.vertical) covered.push({ run: s.run, from: 0, to: s.run.glyphs.length });
    else if (s.run.oracle) covered.push({ run: s.run, from: Math.max(0, s.from - 1), to: Math.min(s.run.glyphs.length, s.to + 1) });
    else covered.push({ run: s.run, from: s.from, to: s.to });
  }
  if (record?.ownRuns && record.ownText !== undefined && needles.length > 0) {
    const index = searchIndex(record.ownText);
    for (const needle of needles) {
      for (const [start, end] of findOccurrences(index, needle)) {
        for (const run of record.ownRuns) {
          if (run.space || run.textEnd <= start || run.textStart >= end) continue;
          let from = -1;
          let to = -1;
          run.textOffsets.forEach((o, gi) => {
            const len = run.glyphs[gi].unicode.length;
            if (len > 0 && o < end && o + len > start) {
              if (from < 0) from = gi;
              to = gi + 1;
            }
          });
          if (from >= 0) covered.push({ run, from, to });
        }
      }
    }
  }
  for (const { run, from, to } of covered) {
    if (run.oracle && run.vertical) {
      // pdf.js vertical item: origin (e, f), width along (a, b), height along (c, d); cover the
      // whole rectangle in both directions of each axis (the origin corner is not specified).
      const g = run.glyphs[0];
      const w = run.local.advances[0] === undefined ? g.advance : (run as unknown as { itemWidth?: number }).itemWidth ?? g.advance;
      const h = run.glyphs.length * g.advance;
      const ax = run.emY[0], ay = run.emY[1];
      const al = Math.hypot(ax, ay) || 1;
      const bx = run.emX[0], by = run.emX[1];
      const bl = Math.hypot(bx, by) || 1;
      const xs = [g.x - (ax / al) * w - (bx / bl) * h, g.x + (ax / al) * w + (bx / bl) * h];
      const ys = [g.y - (ay / al) * w - (by / bl) * h, g.y + (ay / al) * w + (by / bl) * h];
      boxes.push({ x0: Math.min(...xs) - 1, y0: Math.min(...ys) - 1, x1: Math.max(...xs) + 1, y1: Math.max(...ys) + 1 });
      continue;
    }
    const exLen = Math.hypot(run.emX[0], run.emX[1]) || 1;
    const ux = run.emX[0] / exLen;
    const uy = run.emX[1] / exLen;
    const eyLen = Math.hypot(run.emY[0], run.emY[1]) || 1;
    const vx = run.emY[0] / eyLen;
    const vy = run.emY[1] / eyLen;
    for (let i = from; i < to; i++) {
      const g = run.glyphs[i];
      const w = run.oracle ? g.advance : g.advance * (exLen / (run.local.fontSize * run.local.hscale || 1));
      const asc = 0.9 * g.fontSize;
      const desc = 0.3 * g.fontSize;
      const pad = run.oracle ? 0.5 * g.fontSize : 0.5;
      const corners = [
        [g.x - ux * pad - vx * desc, g.y - uy * pad - vy * desc],
        [g.x + ux * (w + pad) - vx * desc, g.y + uy * (w + pad) - vy * desc],
        [g.x - ux * pad + vx * asc, g.y - uy * pad + vy * asc],
        [g.x + ux * (w + pad) + vx * asc, g.y + uy * (w + pad) + vy * asc],
      ];
      boxes.push({
        x0: Math.min(...corners.map((c) => c[0])),
        y0: Math.min(...corners.map((c) => c[1])),
        x1: Math.max(...corners.map((c) => c[0])),
        y1: Math.max(...corners.map((c) => c[1])),
      });
    }
  }
  return boxes;
}

// Re-exported for tests that build synthetic streams.
export { lexContent };
export type { OracleDocument };
