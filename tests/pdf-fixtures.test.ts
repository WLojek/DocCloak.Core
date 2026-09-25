// Proves the PDF fixtures themselves (never calls the redactor):
// - every builder yields a PDF that pdf-lib can load, with the expected structure,
// - every documented seed is found by the package scanner in the documented
//   encoding and part kind, so a fixture can never silently stop planting PII,
// - assertNoTrace fails loudly on each seed and passes on a clean needle,
// - builders are deterministic,
// - the scanner sees inside Flate streams, object streams, hex strings, string
//   operands of content streams, previous revisions and embedded containers.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { assertNoTrace, findTraces, encodeNeedle, isPdf, extractPdfStreamStrings, writeOutput } from './helpers/package-scan.ts';
import type { Trace } from './helpers/package-scan.ts';
import { PDF_FIXTURES, PDF_SEEDS, PDF_SEED, buildPdfFixture, latin1 } from './helpers/fixtures/index.ts';
import type { PdfTraceVia } from './helpers/fixtures/index.ts';

function partKind(part: string): PdfTraceVia | 'trailer' | 'other' {
  if (part === '<file>') return 'file';
  if (/^obj \d+ stream string$/.test(part)) return 'stream string';
  if (/^obj \d+ stream$/.test(part)) return 'stream';
  if (/^obj \d+ string$/.test(part)) return 'string';
  if (part === 'trailer string') return 'trailer';
  return 'other';
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

function decoded(stream: PDFStream): string {
  const raw = stream as PDFRawStream;
  return new TextDecoder('latin1').decode(decodePDFRawStream(raw).decode());
}

function pageContent(doc: PDFDocument, index = 0): string {
  const contents = doc.getPage(index).node.Contents();
  if (contents instanceof PDFStream) return decoded(contents);
  if (contents instanceof PDFArray) {
    let out = '';
    for (let i = 0; i < contents.size(); i++) out += decoded(contents.lookup(i, PDFStream));
    return out;
  }
  throw new Error('page has no /Contents');
}

function infoText(doc: PDFDocument, key: string): string | undefined {
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof PDFDict)) return undefined;
  const v = info.lookup(PDFName.of(key));
  return v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : undefined;
}

const rawText = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('PDF fixture generators', () => {
  it('PDF_SEEDS is the PDF_FIXTURES registry with unique names', () => {
    expect(PDF_SEEDS).toBe(PDF_FIXTURES);
    expect(PDF_FIXTURES.length).toBe(15);
    const names = PDF_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const spec of PDF_FIXTURES) {
      expect(spec.ext).toBe('pdf');
      expect(spec.findings).toEqual(['PDF']);
      expect(spec.seeds.length).toBeGreaterThan(0);
      expect(spec.notes.length).toBeGreaterThan(0);
    }
  });

  it('buildPdfFixture builds by name and rejects unknown names', async () => {
    const bytes = await buildPdfFixture('pdf-standard14');
    expect(isPdf(bytes)).toBe(true);
    await expect(buildPdfFixture('pdf-nope')).rejects.toThrow(/unknown PDF fixture/);
  });

  for (const fixture of PDF_FIXTURES) {
    describe(fixture.name, () => {
      it('produces a PDF that pdf-lib loads', async () => {
        const bytes = await fixture.build();
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(rawText(bytes.subarray(0, 4))).toBe('%PDF');
        const doc = await load(bytes);
        expect(doc.getPageCount()).toBe(1);
        await writeOutput(`${fixture.name}.pdf`, bytes);
      });

      it('plants every documented seed where and how it says', async () => {
        const bytes = await fixture.build();
        for (const seed of fixture.seeds) {
          const traces = await findTraces(bytes, [seed.needle]);
          const found = traces.map((t) => `${partKind(t.part)}:${t.encoding}`);
          expect(found, `needle ${JSON.stringify(seed.needle)} (${seed.part}: ${seed.where}) missing`).not.toHaveLength(0);
          expect(found, `needle ${JSON.stringify(seed.needle)} expected as ${seed.via}:${seed.encoding}`).toContain(`${seed.via}:${seed.encoding}`);
        }
      });

      it('makes assertNoTrace fail with the needle, and pass for a clean needle', async () => {
        const bytes = await fixture.build();
        const needles = fixture.seeds.map((s) => s.needle);
        await expect(assertNoTrace(bytes, needles)).rejects.toThrow(/assertNoTrace/);
        for (const seed of fixture.seeds) {
          let message = '';
          try {
            await assertNoTrace(bytes, [seed.needle]);
          } catch (err) {
            message = (err as Error).message;
          }
          expect(message).toContain(JSON.stringify(seed.needle));
        }
        await expect(assertNoTrace(bytes, ['zzz-not-there'])).resolves.toBeUndefined();
      });

      it('is deterministic', async () => {
        const a = await fixture.build();
        const b = await fixture.build();
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      });
    });
  }
});

describe('PDF fixture structure', () => {
  it('pdf-standard14 draws with a WinAnsi Type1 Helvetica as a hex string', async () => {
    const doc = await load(await buildPdfFixture('pdf-standard14'));
    const content = pageContent(doc);
    expect(content).toMatch(/<[0-9A-Fa-f]+> Tj/);
    expect(content).not.toContain('Jan Kowalski');
    const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    const font = fonts?.lookup(fonts.keys()[0], PDFDict);
    expect(font?.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Type1'));
    expect(font?.lookup(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
  });

  it('pdf-type0-liberation embeds two Type0 / Identity-H fonts with ToUnicode and hides the text as glyph ids', async () => {
    const bytes = await buildPdfFixture('pdf-type0-liberation');
    const doc = await load(bytes);
    const fonts = doc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts?.keys()).toHaveLength(2);
    const names: string[] = [];
    for (const key of fonts!.keys()) {
      const font = fonts!.lookup(key, PDFDict);
      expect(font.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Type0'));
      expect(font.lookup(PDFName.of('Encoding'))).toBe(PDFName.of('Identity-H'));
      expect(font.lookup(PDFName.of('ToUnicode'))).toBeInstanceOf(PDFStream);
      names.push((font.lookup(PDFName.of('BaseFont')) as PDFName).decodeText());
    }
    expect(names.join(' ')).toMatch(/LiberationSans/);
    expect(names.join(' ')).toMatch(/LiberationSerif-Bold/);
    // The glyph-id text is invisible to every byte scan; only the /Subject carries it.
    const traces = await findTraces(bytes, [PDF_SEED.janPesel, PDF_SEED.anna]);
    expect(traces.every((t) => partKind(t.part) === 'string' && t.encoding === 'utf16be')).toBe(true);
    expect(infoText(doc, 'Subject')).toBe(`${PDF_SEED.janPesel}; ${PDF_SEED.anna}`);
  });

  it('pdf-tj-kerning and pdf-split-shows carry the exact operator sequences', async () => {
    expect(pageContent(await load(await buildPdfFixture('pdf-tj-kerning')))).toBe('BT /F1 12 Tf 72 700 Td [(Ja) -15 (n) -200 (Kowalski)] TJ ET');
    expect(pageContent(await load(await buildPdfFixture('pdf-split-shows')))).toBe('BT /F1 12 Tf 72 700 Td (Jan Kow) Tj (alski) Tj ET');
  });

  it('pdf-form-xobject draws only through /X1 Do', async () => {
    const doc = await load(await buildPdfFixture('pdf-form-xobject'));
    expect(pageContent(doc)).toBe('q 1 0 0 1 72 650 cm /X1 Do Q');
    const xobjects = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const x1 = xobjects?.lookup(PDFName.of('X1'), PDFStream);
    expect(x1?.dict.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Form'));
    expect(x1?.dict.lookup(PDFName.of('BBox'))).toBeInstanceOf(PDFArray);
    const fonts = x1?.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    expect(fonts?.keys().map((k) => k.decodeText()).sort()).toEqual(['F1', 'F2']);
    const content = decoded(x1!);
    expect(content).toContain('/F2 12 Tf');
    expect(content).toContain(`(${PDF_SEED.ewaMail}) Tj`);
  });

  it('pdf-hidden-text uses 3 Tr, 1 g, an off-page Td and a 0.1 pt size', async () => {
    const content = pageContent(await load(await buildPdfFixture('pdf-hidden-text')));
    expect(content).toContain(`3 Tr 72 700 Td (${PDF_SEED.hiddenTr3}) Tj`);
    expect(content).toContain(`1 g 72 680 Td (${PDF_SEED.hiddenWhite}) Tj`);
    expect(content).toContain(`-500 -500 Td (${PDF_SEED.hiddenOffPage}) Tj`);
    expect(content).toContain(`/F1 0.1 Tf 72 660 Td (${PDF_SEED.hiddenTiny}) Tj`);
  });

  it('pdf-actualtext keeps the name only in the ActualText property', async () => {
    const content = pageContent(await load(await buildPdfFixture('pdf-actualtext')));
    expect(content).toContain('/Span <</ActualText (\xfe\xff');
    expect(content).toContain('>> BDC (P. Wisniewski) Tj EMC ET');
    expect(content).not.toContain('Piotr');
    expect(content).toContain(rawText(encodeNeedle(PDF_SEED.piotr, 'utf16be')));
  });

  it('pdf-annotations has a /Text and a /Link annotation', async () => {
    const doc = await load(await buildPdfFixture('pdf-annotations'));
    const annots = doc.getPage(0).node.Annots();
    expect(annots?.size()).toBe(2);
    const text = annots!.lookup(0, PDFDict);
    expect(text.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Text'));
    expect(text.lookup(PDFName.of('Contents'), PDFString).decodeText()).toBe(PDF_SEED.noteContents);
    expect(text.lookup(PDFName.of('T'), PDFString).decodeText()).toBe(PDF_SEED.jan);
    const link = annots!.lookup(1, PDFDict);
    expect(link.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'));
    expect(link.lookup(PDFName.of('A'), PDFDict).lookup(PDFName.of('URI'), PDFString).decodeText()).toBe(PDF_SEED.linkUri);
  });

  it('pdf-acroform has the value in the field and a widget with an appearance stream', async () => {
    const doc = await load(await buildPdfFixture('pdf-acroform'));
    const field = doc.getForm().getTextField('owner');
    expect(field.getText()).toBe(PDF_SEED.maria);
    const widget = field.acroField.getWidgets()[0];
    expect(widget.getAppearances()?.normal).toBeInstanceOf(PDFStream);
  });

  it('pdf-outlines-info-xmp has Info, uncompressed XMP and an outline item', async () => {
    const bytes = await buildPdfFixture('pdf-outlines-info-xmp');
    const doc = await load(bytes);
    expect(infoText(doc, 'Author')).toBe(PDF_SEED.jan);
    expect(infoText(doc, 'Title')).toBe(PDF_SEED.title);
    const metadata = doc.catalog.lookup(PDFName.of('Metadata'), PDFStream) as PDFRawStream;
    expect(metadata.dict.lookup(PDFName.of('Filter'))).toBeUndefined();
    expect(new TextDecoder().decode(metadata.contents)).toContain(`<rdf:li>${PDF_SEED.jan}</rdf:li>`);
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'), PDFDict);
    expect(outlines.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(1);
    const first = outlines.lookup(PDFName.of('First'), PDFDict);
    expect(first.lookup(PDFName.of('Title'), PDFString).decodeText()).toBe(PDF_SEED.outline);
    expect(rawText(bytes)).toContain(PDF_SEED.outline);
  });

  it('pdf-embedded-file keeps the attachment in a Flate /EmbeddedFile stream', async () => {
    const bytes = await buildPdfFixture('pdf-embedded-file');
    expect(rawText(bytes)).not.toContain(PDF_SEED.attachment);
    const doc = await load(bytes);
    const embedded = doc.context
      .enumerateIndirectObjects()
      .map(([, obj]) => obj)
      .filter((obj): obj is PDFRawStream => obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Type')) === PDFName.of('EmbeddedFile'));
    expect(embedded).toHaveLength(1);
    expect(embedded[0].dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(decoded(embedded[0])).toBe(PDF_SEED.attachment);
    const traces = await findTraces(bytes, [PDF_SEED.attachment]);
    expect(traces.map((t) => partKind(t.part))).toContain('stream');
  });

  it('pdf-incremental-update shows Anna Nowak now and keeps Jan Kowalski in the old revision', async () => {
    const bytes = await buildPdfFixture('pdf-incremental-update');
    const text = rawText(bytes);
    expect(text.match(/%%EOF/g)).toHaveLength(2);
    expect(text.match(/startxref/g)).toHaveLength(2);
    expect(text).toMatch(/trailer\n<< \/Size \d+ \/Root \d+ 0 R \/Info \d+ 0 R \/Prev \d+ >>/);
    // /Prev points at the first startxref, the last startxref at the hand-written xref section.
    const offsets = [...text.matchAll(/startxref\n(\d+)\n%%EOF/g)].map((m) => Number(m[1]));
    expect(text.slice(offsets[0], offsets[0] + 4)).toBe('xref');
    expect(text.slice(offsets[1], offsets[1] + 4)).toBe('xref');
    expect(text).toContain(`/Prev ${offsets[0]} >>`);
    // Every xref entry offset points at "<num> 0 obj".
    for (const m of text.slice(offsets[1]).matchAll(/(\d+) 1\n(\d{10}) 00000 n/g)) {
      expect(text.slice(Number(m[2]), Number(m[2]) + `${m[1]} 0 obj`.length)).toBe(`${m[1]} 0 obj`);
    }

    const doc = await load(bytes);
    const current = pageContent(doc);
    expect(current).toContain(`(${PDF_SEED.anna}) Tj`);
    expect(current).not.toContain(PDF_SEED.jan);
    // The stale content stream is still an indirect object, Flate-compressed.
    expect(text).not.toContain(PDF_SEED.jan);
    const stale = doc.context
      .enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFRawStream && decoded(obj as PDFRawStream).includes(`(${PDF_SEED.jan}) Tj`));
    expect(stale).toHaveLength(1);
    const traces = await findTraces(bytes, [PDF_SEED.jan]);
    expect(traces.map((t) => t.part)).toContain(`obj ${stale[0][0].objectNumber} stream`);
  });

  it('pdf-objstm packs the dicts into an /ObjStm that pdf-lib expands', async () => {
    const bytes = await buildPdfFixture('pdf-objstm');
    const text = rawText(bytes);
    expect(text).toContain('/Type /ObjStm');
    expect(text).not.toContain('/Author');
    expect(text).not.toContain(rawText(encodeNeedle(PDF_SEED.tomasz, 'utf16be')));
    const doc = await load(bytes);
    const objects = doc.context.enumerateIndirectObjects().map(([, obj]) => obj);
    expect(objects.some((o) => o instanceof PDFRawStream && o.dict.lookup(PDFName.of('Type')) === PDFName.of('ObjStm'))).toBe(true);
    // Objects that were inside the ObjStm are enumerated as ordinary indirect objects.
    expect(objects.some((o) => o instanceof PDFDict && o.has(PDFName.of('Author')))).toBe(true);
    expect(objects.some((o) => o instanceof PDFDict && o.lookup(PDFName.of('BaseFont')) === PDFName.of('Helvetica'))).toBe(true);
    expect(infoText(doc, 'Author')).toBe(PDF_SEED.tomasz);
    const traces = await findTraces(bytes, [PDF_SEED.tomasz]);
    expect(traces.some((t) => partKind(t.part) === 'string' && t.encoding === 'utf16be')).toBe(true);
    expect(traces.some((t) => partKind(t.part) === 'stream string' && t.encoding === 'utf8')).toBe(true);
  });

  it('pdf-rotated-rise-tz rotates the page and uses Tz, Ts and Tw', async () => {
    const doc = await load(await buildPdfFixture('pdf-rotated-rise-tz'));
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    const content = pageContent(doc);
    expect(content).toContain('80 Tz 5 Ts 2 Tw');
    expect(content).toContain('(Karol W\xf3jcik lives here) Tj');
  });
});

describe('package-scan PDF branch', () => {
  async function tinyPdf(setup: (doc: PDFDocument) => void | Promise<void>, useObjectStreams = false): Promise<Uint8Array> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([200, 200]);
    await setup(doc);
    return doc.save({ useObjectStreams });
  }

  function kinds(traces: Trace[], needle: string): string[] {
    return [...new Set(traces.filter((t) => t.needle === needle).map((t) => `${partKind(t.part)}:${t.encoding}`))].sort();
  }

  it('finds a needle inside a Flate stream, an object stream and a hex string', async () => {
    const bytes = await tinyPdf((doc) => {
      const stream = doc.context.flateStream('BT (FlateStreamSecret) Tj ET');
      doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(stream));
      doc.setAuthor('ObjStmHexSecret');
      doc.getPage(0).node.set(PDFName.of('DocCloakHex'), PDFHexString.fromText('PlainHexSecret'));
    }, true);
    const raw = rawText(bytes);
    expect(raw).not.toContain('FlateStreamSecret');
    expect(raw).not.toContain('ObjStmHexSecret');
    expect(raw).toContain('/Type /ObjStm');
    const traces = await findTraces(bytes, ['FlateStreamSecret', 'ObjStmHexSecret', 'PlainHexSecret']);
    expect(kinds(traces, 'FlateStreamSecret')).toEqual(['stream string:latin1', 'stream string:utf8', 'stream:latin1', 'stream:utf8']);
    // The expanded object is reported as a string; the ObjStm's decoded bytes hold the same hex string textually.
    expect(kinds(traces, 'ObjStmHexSecret')).toEqual(['stream string:utf16be', 'string:utf16be']);
    expect(kinds(traces, 'PlainHexSecret')).toEqual(['string:utf16be']);
    await expect(assertNoTrace(bytes, ['FlateStreamSecret'])).rejects.toThrow(/obj \d+ stream/);
    await expect(assertNoTrace(bytes, ['ObjStmHexSecret'])).rejects.toThrow(/obj \d+ string" as utf16be/);
    await expect(assertNoTrace(bytes, ['Absent'])).resolves.toBeUndefined();
  });

  it('decodes hex and escaped literal string operands inside content streams', async () => {
    const bytes = await tinyPdf((doc) => {
      const hex = Array.from('HexOperandSecret', (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      const content = `BT <${hex}> Tj (Esc\\141pedLiteralSecret) Tj (a\\(b\\)c) Tj ET`;
      doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
    });
    const traces = await findTraces(bytes, ['HexOperandSecret', 'EscapedLiteralSecret']);
    expect(kinds(traces, 'HexOperandSecret')).toEqual(['stream string:latin1', 'stream string:utf8']);
    expect(kinds(traces, 'EscapedLiteralSecret')).toEqual(['stream string:latin1', 'stream string:utf8']);
  });

  it('extractPdfStreamStrings handles nesting, escapes, hex whitespace, dict delimiters and comments', () => {
    const src = latin1('% (comment) \n<< /A (x) >> [(a(b)c) <41 4\n2> (\\101\\n\\\\)] <zz> (tail');
    const strings = extractPdfStreamStrings(src).map((s) => rawText(s));
    expect(strings).toEqual(['x', 'a(b)c', 'AB', 'A\n\\', 'tail']);
  });

  it('scans the raw bytes of a PDF as <file> and reports UTF-16 strings once', async () => {
    const bytes = await tinyPdf((doc) => {
      doc.getPage(0).node.set(PDFName.of('DocCloakLiteral'), PDFString.of('RawLiteralSecret'));
      doc.getPage(0).node.set(PDFName.of('DocCloakWide'), PDFHexString.fromText('Wide Secret, and more'));
    });
    const traces = await findTraces(bytes, ['RawLiteralSecret', 'Wide Secret']);
    expect(kinds(traces, 'RawLiteralSecret')).toEqual(['file:latin1', 'file:utf8', 'string:latin1', 'string:utf8']);
    // "Wide Secret" is followed by ", " in the UTF-16BE string, which would alias as UTF-16LE one byte later.
    expect(kinds(traces, 'Wide Secret')).toEqual(['string:utf16be']);
  });

  it('scans image streams raw only and does not throw on them', async () => {
    const bytes = await tinyPdf((doc) => {
      const image = doc.context.stream('DCT ImageBytesSecret', { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, Filter: 'DCTDecode' });
      doc.getPage(0).node.setXObject(PDFName.of('Im1'), doc.context.register(image));
    });
    const traces = await findTraces(bytes, ['ImageBytesSecret']);
    expect(kinds(traces, 'ImageBytesSecret')).toEqual(['file:latin1', 'file:utf8', 'stream:latin1', 'stream:utf8']);
  });

  it('undoes PNG predictors on Flate streams', async () => {
    const bytes = await tinyPdf((doc) => {
      // Predictor 12 (PNG Up), 1 column of 8 bytes per row, two rows: row 2 is the byte-wise delta from row 1.
      const row1 = latin1('SecretAB');
      const row2 = new Uint8Array(8);
      const target = latin1('SecretCD');
      for (let i = 0; i < 8; i++) row2[i] = (target[i] - row1[i]) & 0xff;
      const data = new Uint8Array([0, ...row1, 2, ...row2]);
      const stream = doc.context.flateStream(data, { DecodeParms: { Predictor: 12, Columns: 8 } });
      doc.getPage(0).node.set(PDFName.of('DocCloakPred'), doc.context.register(stream));
    });
    const traces = await findTraces(bytes, ['SecretCD']);
    expect(kinds(traces, 'SecretCD')).toEqual(['stream:latin1', 'stream:utf8']);
  });

  it('recurses into a zip embedded in a PDF and into a PDF embedded in a zip', async () => {
    const inner = new JSZip();
    inner.file('deep.xml', '<a>ZipInPdfSecret</a>');
    const innerBytes = await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const pdf = await tinyPdf(async (doc) => {
      await doc.attach(innerBytes, 'inner.zip', { mimeType: 'application/zip', creationDate: new Date(0), modificationDate: new Date(0) });
      doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('BT (PdfInZipSecret) Tj ET')));
    });
    const pdfTraces = await findTraces(pdf, ['ZipInPdfSecret']);
    expect(pdfTraces.map((t) => t.part)).toContainEqual(expect.stringMatching(/^obj \d+ stream!deep\.xml$/));

    const outer = new JSZip();
    outer.file('word/embeddings/file.pdf', pdf);
    const zipBytes = await outer.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const zipTraces = await findTraces(zipBytes, ['PdfInZipSecret', 'ZipInPdfSecret']);
    expect(zipTraces.map((t) => t.part)).toContainEqual(expect.stringMatching(/^word\/embeddings\/file\.pdf!obj \d+ stream$/));
    expect(zipTraces.map((t) => t.part)).toContainEqual(expect.stringMatching(/^word\/embeddings\/file\.pdf!obj \d+ stream!deep\.xml$/));
  });

  it('accepts a PDF with junk before the header and still scans raw bytes pdf-lib cannot parse', async () => {
    const pdf = await tinyPdf((doc) => {
      doc.getPage(0).node.set(PDFName.of('DocCloakLiteral'), PDFString.of('JunkHeaderSecret'));
    });
    const junk = new Uint8Array(pdf.length + 8);
    junk.set(latin1('GARBAGE\n'), 0);
    junk.set(pdf, 8);
    expect(isPdf(junk)).toBe(true);
    expect((await findTraces(junk, ['JunkHeaderSecret'])).map((t) => t.part)).toContain('<file>');
    // pdf-lib's parser is lenient: unparsable regions yield no objects, but the raw <file> scan still covers them.
    const garbage = await findTraces(latin1('%PDF-1.7\n1 0 obj << /Broken (UnparsedSecret) >>\nno endobj no xref'), ['UnparsedSecret']);
    expect(garbage.map((t) => t.part)).toContain('<file>');
  });
});
