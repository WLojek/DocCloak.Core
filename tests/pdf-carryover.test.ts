// What a page that is NOT copied into the output must not leave behind. A painted page (a scan
// whose values were covered in the picture, a page rasterized with black boxes) is written as a
// new picture; the output is otherwise built by copying pages, and a copied page brings along
// everything its resource dictionary lists. Where pages share one dictionary (FPDF, TCPDF and
// many scanners write files that way), the ORIGINAL of the painted page shipped inside the
// output as an object nothing draws: the scan with the value still in its pixels, the form with
// the text a raster had blacked out. These tests failed before the writer pruned those entries.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from '@cantoo/pdf-lib';
import type { PDFObject } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import { extractPdf, openWithOracle, readPdf, verifyPdf, writeAnonymizedPdfWithReport } from '../src/pdf/index.ts';
import type { PdfAssetPaths } from '../src/pdf/index.ts';
import { streamFingerprint } from '../src/pdf/carryover.ts';
import { decodeStream, getDict, getName, getNumber } from '../src/pdf/objects.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import { buildScanPdf } from './helpers/fixtures/pdf-scan.ts';

const FONTS = join(__dirname, '..', 'fonts', 'liberation');
const ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(FONTS, file))) };

/** Every stream object of a file. */
async function streamsOf(bytes: Uint8Array): Promise<{ doc: PDFDocument; streams: PDFRawStream[] }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const streams = [...doc.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFRawStream => o instanceof PDFRawStream);
  return { doc, streams };
}

/** The image objects of a file: size, colour space and fingerprint of the stored bytes. */
async function imagesOf(bytes: Uint8Array): Promise<Array<{ width: number; height: number; colours: string; fingerprint: string }>> {
  const { doc, streams } = await streamsOf(bytes);
  return streams.filter((s) => getName(doc.context, s.dict, 'Subtype') === 'Image').map((s) => ({
    width: getNumber(doc.context, s.dict, 'Width') ?? 0,
    height: getNumber(doc.context, s.dict, 'Height') ?? 0,
    colours: getName(doc.context, s.dict, 'ColorSpace') ?? '',
    fingerprint: streamFingerprint(s.contents),
  }));
}

describe('a painted scan page whose resource dictionary a copied page shares', () => {
  /** Page 1 is text, page 2 a scan with an OCR layer that holds "Kowalski"; both pages use ONE /Resources. */
  async function twoPagesOneResources(): Promise<Uint8Array | undefined> {
    const scan = await buildScanPdf([
      { kind: 'text', lines: ['Umowa najmu lokalu'] },
      { kind: 'scan', lines: [['Podpisano', 'przez', 'Kowalski', 'dnia', 'dzisiejszego.']], values: ['Kowalski'], layer: 'tr3' },
    ]);
    if (!scan) return undefined; // no native canvas here
    const doc = await PDFDocument.load(scan.bytes, { updateMetadata: false });
    const [text, picture] = doc.getPages();
    const shared = doc.context.register(picture.node.Resources()!);
    text.node.set(PDFName.of('Resources'), shared);
    picture.node.set(PDFName.of('Resources'), shared);
    return doc.save({ useObjectStreams: false });
  }

  async function redact(bytes: Uint8Array) {
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const at = extraction.plainText.indexOf('Kowalski');
    expect(at).toBeGreaterThanOrEqual(0);
    const result = await writeAnonymizedPdfWithReport(
      extraction, [{ start: at, end: at + 8, replacement: '[PERSON_1]' }], [{ value: 'Kowalski', replacement: '[PERSON_1]' }],
      { assets: ASSETS, canvasFactory: await nodeCanvasFactory() },
    );
    return { result, out: new Uint8Array(await result.blob.arrayBuffer()) };
  }

  it('the output holds no image object with the original picture: not by fingerprint, not by its dimensions', async () => {
    const bytes = await twoPagesOneResources();
    if (!bytes) return;
    const [original] = await imagesOf(bytes);
    expect(original).toMatchObject({ width: 1275, height: 1650, colours: 'DeviceRGB' });

    const { result, out } = await redact(bytes);
    expect(result.scanPages).toEqual([1]);
    expect(result.rasterizedPages).toEqual([]);
    const images = await imagesOf(out);
    // One picture: the painted page. The scan it was painted from is not in the file.
    expect(images).toHaveLength(1);
    expect(images.some((i) => i.fingerprint === original.fingerprint)).toBe(false);
    expect(images.some((i) => i.width === original.width && i.height === original.height)).toBe(false);
    expect(images.some((i) => i.colours === 'DeviceRGB')).toBe(false); // the value was printed in red; the painted page is gray
    // The copied text page lists no XObject any more, and reads as before.
    const { doc } = await streamsOf(out);
    const xobjects = getDict(doc.context, doc.getPage(0).node.Resources(), 'XObject');
    expect([...(xobjects?.entries() ?? [])]).toEqual([]);
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain('Umowa najmu lokalu');
    expect(text).toContain('Podpisano przez [PERSON_1] dnia dzisiejszego.');
    expect(text).not.toContain('Kowalski');
  });

  it('the verifier refuses a hand-built output that still holds the original picture', async () => {
    const bytes = await twoPagesOneResources();
    if (!bytes) return;
    const source = await streamsOf(bytes);
    const scanImage = source.streams.find((s) => getName(source.doc.context, s.dict, 'Subtype') === 'Image')!;
    const expected = { pageCount: 2, removedTexts: [], keptTexts: [], foreignStreams: [streamFingerprint(scanImage.contents)], picturePages: [], regions: [] };

    // The writer's own output passes.
    const { out } = await redact(bytes);
    expect(await verifyPdf({ bytes: out, needles: ['Kowalski'], placeholders: ['[PERSON_1]'], edits: expected })).toEqual([]);

    // The same output with the scan put back as the writer used to ship it: an entry of the text
    // page's resources that no content draws. Every text pass is clean; only the stream gives it away.
    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const entries: Record<string, string | number> = {};
    for (const [k, v] of scanImage.dict.entries()) entries[k.decodeText()] = v.toString().replace(/^\//, '');
    const copy = doc.context.register(PDFRawStream.of(doc.context.obj({ ...entries, Width: 1275, Height: 1650, BitsPerComponent: 8, Length: scanImage.contents.length }), scanImage.contents));
    doc.getPage(0).node.Resources()!.set(PDFName.of('XObject'), doc.context.obj({ Im0: copy }));
    const leaking = await doc.save({ useObjectStreams: false });
    expect((await imagesOf(leaking)).some((i) => i.width === 1275 && i.height === 1650)).toBe(true);
    const oracle = await openWithOracle(leaking, ASSETS);
    const findings = await verifyPdf({ bytes: leaking, needles: ['Kowalski'], placeholders: ['[PERSON_1]'], oracle, edits: expected });
    await oracle.close();
    expect(findings.map((f) => f.pass)).toEqual(['foreign-stream']);
    // Without the expectation the old checks see nothing: pixels are not searched for values.
    expect(await verifyPdf({ bytes: leaking, needles: ['Kowalski'], placeholders: ['[PERSON_1]'] })).toEqual([]);
  });

  it('a copied page whose content could not be walked to the end: nothing is taken out, and the export is refused', async () => {
    const bytes = await twoPagesOneResources();
    if (!bytes) return;
    // Bytes no lexer can read at the end of the text page's content: what they draw is not known,
    // so the scan cannot be taken out of the resources that page shares, and must not ship either.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0);
    const before = decodeStream(doc.context, doc.context.lookup(page.node.get(PDFName.of('Contents'))) as PDFRawStream);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`${Buffer.from(before).toString('latin1')}\n>> ) ]`)));
    const broken = await doc.save({ useObjectStreams: false });
    const model = (await extractPdf(broken)).model;
    expect(model.pages[0].partialWalk).toBe(true);
    await expect(redact(broken)).rejects.toMatchObject({ name: 'PdfVerifyError', findings: [expect.objectContaining({ pass: 'foreign-stream' })] });
  });

  it('a picture both pages draw stays: it is the copied page\'s own', async () => {
    const bytes = await twoPagesOneResources();
    if (!bytes) return;
    // The text page now draws the scan too (a small copy in a corner).
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0);
    const before = decodeStream(doc.context, doc.context.lookup(page.node.get(PDFName.of('Contents'))) as PDFRawStream);
    const content = `${Buffer.from(before).toString('latin1')}\nq 60 0 0 80 500 40 cm /Im0 Do Q`;
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
    const both = await doc.save({ useObjectStreams: false });
    const [original] = await imagesOf(both);
    const { out } = await redact(both);
    const images = await imagesOf(out);
    expect(images).toHaveLength(2);
    expect(images.some((i) => i.fingerprint === original.fingerprint)).toBe(true);
  });
});

describe('a rasterized page whose resource dictionary a copied page shares', () => {
  const VALUE_LINE = 'Wspolnik: Maria Wozniak';

  /**
   * Page 1 is plain text. Page 2 shows text in a font pdf.js rejects (so an edit rasterizes it)
   * and draws form Fx2, whose text is set in an embedded Identity-H font: glyph ids, which the
   * byte scan of the verifier cannot read as a value. Both pages use ONE /Resources.
   */
  async function sharedWithUnsafePage(): Promise<{ bytes: Uint8Array; form: Uint8Array }> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.registerFontkit(fontkit);
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const mono = await doc.embedFont(new Uint8Array(readFileSync(join(FONTS, 'LiberationMono-Regular.ttf'))), { subset: false });
    const ctx = doc.context;
    const broken = ctx.register(ctx.obj({ Type: 'Font', BaseFont: 'Helvetica' })); // no /Subtype
    const form = new TextEncoder().encode(`BT /F2 12 Tf 40 200 Td ${mono.encodeText(VALUE_LINE).toString()} Tj ET`);
    const fx2 = ctx.register(ctx.stream(form, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Resources: { Font: { F2: mono.ref } } }));
    const shared = ctx.register(ctx.obj({ Font: { F1: helvetica.ref, F9: broken }, XObject: { Fx2: fx2 } }));
    const contents = ['BT /F1 12 Tf 40 250 Td (Strona pierwsza: umowa najmu) Tj ET', 'BT /F9 12 Tf 40 250 Td (Strona druga, aneks) Tj ET q /Fx2 Do Q'];
    for (const content of contents) {
      const page = doc.addPage([400, 300]);
      page.node.set(PDFName.of('Resources'), shared);
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
    }
    return { bytes: await doc.save({ useObjectStreams: false }), form };
  }

  it('the form with the value\'s text is not in the output, nor the font only it uses', async () => {
    const canvasFactory = await nodeCanvasFactory();
    if (!canvasFactory) return;
    const { bytes, form } = await sharedWithUnsafePage();
    const extraction = await readPdf(bytes, { assets: ASSETS });
    const at = extraction.plainText.indexOf('Maria Wozniak');
    expect(at).toBeGreaterThanOrEqual(0);
    const result = await writeAnonymizedPdfWithReport(
      extraction, [{ start: at, end: at + 13, replacement: '[PERSON_1]' }], [{ value: 'Maria Wozniak', replacement: '[PERSON_1]' }], { assets: ASSETS, canvasFactory },
    );
    expect(result.rasterizedPages).toEqual([1]);
    const out = new Uint8Array(await result.blob.arrayBuffer());

    const { doc, streams } = await streamsOf(out);
    expect(streams.some((s) => streamFingerprint(s.contents) === streamFingerprint(form))).toBe(false);
    expect(streams.some((s) => getName(doc.context, s.dict, 'Subtype') === 'Form')).toBe(false);
    // Nor any other stream of the input but page 1's own content: the form's font program and its
    // ToUnicode map (which spells the glyph ids out) went with the form.
    const source = await streamsOf(bytes);
    const firstPage = source.doc.context.lookup(source.doc.getPage(0).node.get(PDFName.of('Contents'))) as PDFRawStream;
    const others = new Set(source.streams.filter((s) => s !== firstPage).map((s) => streamFingerprint(s.contents)));
    expect(others.size).toBeGreaterThanOrEqual(4); // page 2's content, the form, the font program, its ToUnicode map
    expect(streams.filter((s) => others.has(streamFingerprint(s.contents)))).toEqual([]);
    const xobjects = getDict(doc.context, doc.getPage(0).node.Resources(), 'XObject');
    expect([...(xobjects?.entries() ?? [])]).toEqual([]);
    expect((await extractPdf(out)).plainText).toContain('Strona pierwsza: umowa najmu');
  });
});

describe('private data under /PieceInfo of a copied XObject', () => {
  it('goes with the entry: the streams it refers to are not written as objects nothing refers to', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const ctx = doc.context;
    const flate = (text: string) => ctx.register(ctx.flateStream(new TextEncoder().encode(text.repeat(20))));
    // An application's copy of the drawing, as Illustrator keeps one: under an indirect /PieceInfo, and under a direct one.
    const first = flate('PRIVATE-APP-DATA the whole drawing as it was, Maria Wozniak ');
    const second = flate('SECOND-PRIVATE-COPY of another form, Anna Nowak ');
    const form = (content: string, pieceInfo: PDFObject) => ctx.register(ctx.stream(content, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 300], Resources: { Font: { F1: font.ref } }, PieceInfo: pieceInfo,
    }));
    const fx1 = form('BT /F1 12 Tf 40 200 Td (Klient: Jan Kowalski) Tj ET', ctx.register(ctx.obj({ Illustrator: { Private: first, LastModified: 'D:2020' } })));
    const fx2 = form('BT /F1 12 Tf 40 150 Td (Druga linia tekstu) Tj ET', ctx.obj({ App: { Private: second } }));
    const page = doc.addPage([400, 300]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fx1: fx1, Fx2: fx2 } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q /Fx1 Do Q q /Fx2 Do Q')));
    const bytes = await doc.save({ useObjectStreams: false });

    const extraction = await readPdf(bytes, { assets: ASSETS });
    const at = extraction.plainText.indexOf('Jan Kowalski');
    const result = await writeAnonymizedPdfWithReport(extraction, [{ start: at, end: at + 12, replacement: '[PERSON_1]' }], [{ value: 'Jan Kowalski', replacement: '[PERSON_1]' }], { assets: ASSETS });
    const out = new Uint8Array(await result.blob.arrayBuffer());

    const written = await streamsOf(out);
    const texts = written.streams.map((s) => { try { return Buffer.from(decodeStream(written.doc.context, s)).toString('latin1'); } catch { return ''; } });
    expect(texts.some((t) => /PRIVATE/.test(t))).toBe(false);
    expect(texts.some((t) => /Wozniak|Nowak/.test(t))).toBe(false);
    expect(Buffer.from(out).toString('latin1')).not.toContain('PieceInfo');
    // The forms themselves are there and read as before, with the value replaced.
    const text = (await extractPdf(out)).plainText;
    expect(text).toContain('Klient: [PERSON_1]');
    expect(text).toContain('Druga linia tekstu');
  });
});
