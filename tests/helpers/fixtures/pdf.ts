// Synthetic PDF fixtures for the text-layer redaction module (T214).
//
// Every builder is a pure async function: same input, same bytes. Documents
// are created with pdf-lib (`PDFDocument.create({ updateMetadata: false })`,
// fixed CreationDate / ModDate, no trailer /ID is written by pdf-lib), fonts
// are the standard-14 Helvetica or the Liberation TTFs from fonts/liberation/
// (embedded as subset Type0 / Identity-H with a ToUnicode CMap).
//
// Where the caller needs a specific operator sequence (TJ kerning, split
// shows, hidden text, ActualText, Tz / Ts / Tw) the content stream is written
// by hand and registered as a Flate stream; the font is exposed to it as /F1
// (Helvetica) or /F2 (Liberation) through the page's /Resources.
//
// Seeds name the exact bytes the scanner (tests/helpers/package-scan.ts) can
// find, and the encoding + part kind it finds them in. Text drawn with a
// Type0 font is stored as glyph ids, which no byte scan can see: those
// fixtures plant the same string in the Info /Subject so the seed check still
// proves the PII is in the file (see the `notes` of each spec).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFName, PDFRef, PDFString, StandardFonts, degrees } from '@cantoo/pdf-lib';
import type { PDFFont, PDFPage } from '@cantoo/pdf-lib';
import type { Seed, FixtureSpec } from './shared.ts';
import type { ScanEncoding } from '../package-scan.ts';

/** Which scanner part kind reports the needle (see Trace.part in package-scan.ts). */
export type PdfTraceVia = 'stream' | 'stream string' | 'string' | 'file';

export interface PdfSeed extends Seed {
  /** The encoding the scanner reports the needle in. */
  encoding: ScanEncoding;
  /** The part kind the scanner reports it under. */
  via: PdfTraceVia;
}

export interface PdfFixtureSpec extends FixtureSpec {
  ext: 'pdf';
  seeds: readonly PdfSeed[];
  /** What the fixture exercises and any caveat about where the text really lives. */
  notes: string;
}

export const PDF_SEED = {
  janPesel: 'Jan Kowalski, PESEL 90010112345',
  jan: 'Jan Kowalski',
  anna: 'Anna Nowak',
  shortNames: 'Li Wu and Bo Xu met Al.',
  ewa: 'Ewa Zielińska',
  ewaMail: 'ewa.zielinska@example.com',
  hiddenTr3: 'Marek Niewidoczny',
  hiddenWhite: 'Beata Bielska',
  hiddenOffPage: 'Cezary Zapole',
  hiddenTiny: 'Dorota Drobna',
  piotr: 'Piotr Wiśniewski',
  noteContents: 'note about Jan Kowalski',
  linkUri: 'mailto:jan.kowalski@example.com',
  maria: 'Maria Dąbrowska',
  title: 'Contract with Anna Nowak',
  outline: 'Meeting with Anna Nowak',
  attachment: 'Attachment mentions Jan Kowalski',
  tomasz: 'Tomasz Lewandowski',
  karol: 'Karol Wójcik',
} as const;

export const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

// Resolved lazily: import.meta.url is a file: URL in Node and vitest's node
// environment, but not under jsdom, where vitest injects __dirname instead.
function fontDir(): string {
  const url = new URL('../../../fonts/liberation/', import.meta.url);
  if (url.protocol === 'file:') return fileURLToPath(url);
  return join(__dirname, '..', '..', '..', 'fonts', 'liberation');
}

const fontCache = new Map<string, Uint8Array>();

function fontBytes(file: string): Uint8Array {
  let bytes = fontCache.get(file);
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(join(fontDir(), file)));
    fontCache.set(file, bytes);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** Latin1 bytes of a string; throws on anything above 0xFF (use utf16be() for that). */
function bytesOf(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) throw new Error(`bytesOf: U+${code.toString(16)} is not a latin1 byte`);
    out[i] = code;
  }
  return out;
}

function concat(parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? bytesOf(p) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** UTF-16BE with BOM, the PDF text-string form for non-PDFDocEncoding text. */
function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code >> 8;
    out[3 + i * 2] = code & 0xff;
  }
  return out;
}

/** A PDF literal string "(...)" holding the given bytes, with \ ( ) escaped. */
function literal(raw: string | Uint8Array): Uint8Array {
  const src = typeof raw === 'string' ? bytesOf(raw) : raw;
  const out: number[] = [0x28];
  for (const b of src) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return Uint8Array.from(out);
}

function ascii(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

async function newDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  return doc;
}

async function helvetica(doc: PDFDocument): Promise<PDFFont> {
  return doc.embedFont(StandardFonts.Helvetica);
}

async function liberation(doc: PDFDocument, file = 'LiberationSans-Regular.ttf'): Promise<PDFFont> {
  return doc.embedFont(fontBytes(file), { subset: true });
}

/** A Letter page whose content stream is the given bytes (Flate) with fonts exposed as /F1, /F2 ... */
function rawPage(doc: PDFDocument, content: Uint8Array, fonts: Record<string, PDFFont>): PDFPage {
  const page = doc.addPage([612, 792]);
  for (const [key, font] of Object.entries(fonts)) page.node.setFontDictionary(PDFName.of(key), font.ref);
  const ref = doc.context.register(doc.context.flateStream(content));
  page.node.set(PDFName.of('Contents'), ref);
  return page;
}

async function save(doc: PDFDocument, useObjectStreams = false): Promise<Uint8Array> {
  return doc.save({ useObjectStreams, updateFieldAppearances: true });
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** 1. Helvetica (simple font, WinAnsi) drawn with pdf-lib's drawText: hex-string Tj operands. */
export async function buildPdfStandard14(): Promise<Uint8Array> {
  const doc = await newDoc();
  const font = await helvetica(doc);
  const page = doc.addPage([612, 792]);
  page.drawText(PDF_SEED.janPesel, { x: 72, y: 700, size: 12, font });
  return save(doc);
}

/** 2. Embedded Liberation fonts (Type0 / Identity-H + ToUnicode): glyph ids in the content, seed in /Subject. */
export async function buildPdfType0Liberation(): Promise<Uint8Array> {
  const doc = await newDoc();
  const sans = await liberation(doc, 'LiberationSans-Regular.ttf');
  const serifBold = await liberation(doc, 'LiberationSerif-Bold.ttf');
  const page = doc.addPage([612, 792]);
  page.drawText(PDF_SEED.janPesel, { x: 72, y: 700, size: 12, font: sans });
  page.drawText(PDF_SEED.anna, { x: 72, y: 680, size: 12, font: serifBold });
  doc.setSubject(`${PDF_SEED.janPesel}; ${PDF_SEED.anna}`);
  return save(doc);
}

export const PDF_TJ_KERNING_CONTENT = 'BT /F1 12 Tf 72 700 Td [(Ja) -15 (n) -200 (Kowalski)] TJ ET';

/** 3. TJ array with kerning adjustments splitting the first name. */
export async function buildPdfTjKerning(): Promise<Uint8Array> {
  const doc = await newDoc();
  rawPage(doc, bytesOf(PDF_TJ_KERNING_CONTENT), { F1: await helvetica(doc) });
  return save(doc);
}

export const PDF_SPLIT_SHOWS_CONTENT = 'BT /F1 12 Tf 72 700 Td (Jan Kow) Tj (alski) Tj ET';

/** 4. A name split across two Tj operators with the implicit advance between them. */
export async function buildPdfSplitShows(): Promise<Uint8Array> {
  const doc = await newDoc();
  rawPage(doc, bytesOf(PDF_SPLIT_SHOWS_CONTENT), { F1: await helvetica(doc) });
  return save(doc);
}

/** 5. Two-character names at 10 pt, for placeholder fitting. */
export async function buildPdfShortNames(): Promise<Uint8Array> {
  const doc = await newDoc();
  rawPage(doc, concat(['BT /F1 10 Tf 72 700 Td ', literal(PDF_SEED.shortNames), ' Tj ET']), { F1: await helvetica(doc) });
  return save(doc);
}

/** 6. Text inside a Form XObject: a Type0 line (glyph ids) and a Helvetica line (literal bytes). */
export async function buildPdfFormXObject(): Promise<Uint8Array> {
  const doc = await newDoc();
  const helv = await helvetica(doc);
  const lib = await liberation(doc);
  const page = doc.addPage([612, 792]);
  const xContent = concat([
    'BT /F2 12 Tf 10 30 Td ', lib.encodeText(PDF_SEED.ewa).toString(), ' Tj ET\n',
    'BT /F1 10 Tf 10 10 Td ', literal(PDF_SEED.ewaMail), ' Tj ET\n',
  ]);
  const xobj = doc.context.flateStream(xContent, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, 300, 50],
    Resources: { Font: { F1: helv.ref, F2: lib.ref } },
  });
  page.node.setXObject(PDFName.of('X1'), doc.context.register(xobj));
  const content = doc.context.register(doc.context.flateStream(bytesOf('q 1 0 0 1 72 650 cm /X1 Do Q')));
  page.node.set(PDFName.of('Contents'), content);
  doc.setSubject(PDF_SEED.ewa);
  return save(doc);
}

/** 7. Four hidden runs: render mode 3, white fill, off-page, 0.1 pt; plus one visible line. */
export async function buildPdfHiddenText(): Promise<Uint8Array> {
  const doc = await newDoc();
  const content = concat([
    'BT /F1 12 Tf 72 720 Td (Visible heading) Tj ET\n',
    'BT /F1 12 Tf 3 Tr 72 700 Td ', literal(PDF_SEED.hiddenTr3), ' Tj ET\n',
    'BT /F1 12 Tf 0 Tr 1 g 72 680 Td ', literal(PDF_SEED.hiddenWhite), ' Tj ET\n',
    'BT /F1 12 Tf 0 g -500 -500 Td ', literal(PDF_SEED.hiddenOffPage), ' Tj ET\n',
    'BT /F1 0.1 Tf 72 660 Td ', literal(PDF_SEED.hiddenTiny), ' Tj ET\n',
  ]);
  rawPage(doc, content, { F1: await helvetica(doc) });
  return save(doc);
}

/** 8. Marked content with /ActualText (UTF-16BE literal) over an abbreviated visible run. */
export async function buildPdfActualText(): Promise<Uint8Array> {
  const doc = await newDoc();
  const content = concat([
    'BT /F1 12 Tf 72 700 Td /Span <</ActualText ', literal(utf16be(PDF_SEED.piotr)), '>> BDC (P. Wisniewski) Tj EMC ET',
  ]);
  rawPage(doc, content, { F1: await helvetica(doc) });
  return save(doc);
}

/** 9. A /Text annotation (Contents, T) and a /Link with a mailto URI action. */
export async function buildPdfAnnotations(): Promise<Uint8Array> {
  const doc = await newDoc();
  const page = rawPage(doc, bytesOf('BT /F1 12 Tf 72 700 Td (See the sticky note and the link.) Tj ET'), { F1: await helvetica(doc) });
  const note = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [400, 690, 420, 710],
    Contents: PDFString.of(PDF_SEED.noteContents),
    T: PDFString.of(PDF_SEED.jan),
    Open: false,
    F: 4,
  });
  const link = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 640, 300, 660],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: PDFString.of(PDF_SEED.linkUri) },
  });
  page.node.addAnnot(doc.context.register(note));
  page.node.addAnnot(doc.context.register(link));
  return save(doc);
}

/** 10. An AcroForm text field whose value is the seed (Liberation appearance stream). */
export async function buildPdfAcroForm(): Promise<Uint8Array> {
  const doc = await newDoc();
  const lib = await liberation(doc);
  const page = rawPage(doc, bytesOf('BT /F1 12 Tf 72 700 Td (Owner:) Tj ET'), { F1: await helvetica(doc) });
  const field = doc.getForm().createTextField('owner');
  field.setText(PDF_SEED.maria);
  field.addToPage(page, { x: 130, y: 690, width: 200, height: 20, font: lib });
  return save(doc);
}

export const PDF_XMP = [
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
  `<dc:creator><rdf:Seq><rdf:li>${PDF_SEED.jan}</rdf:li></rdf:Seq></dc:creator>`,
  `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${PDF_SEED.title}</rdf:li></rdf:Alt></dc:title>`,
  '</rdf:Description></rdf:RDF></x:xmpmeta>',
  '<?xpacket end="w"?>',
].join('\n');

/** 11. Info dict (Author, Title), an XMP /Metadata stream and an /Outlines item with PII. */
export async function buildPdfOutlinesInfoXmp(): Promise<Uint8Array> {
  const doc = await newDoc();
  const page = rawPage(doc, bytesOf('BT /F1 12 Tf 72 700 Td (Body without names.) Tj ET'), { F1: await helvetica(doc) });
  doc.setAuthor(PDF_SEED.jan);
  doc.setTitle(PDF_SEED.title);
  const xmp = doc.context.stream(new TextEncoder().encode(PDF_XMP), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(xmp));
  const outlinesRef = doc.context.nextRef();
  const itemRef = doc.context.nextRef();
  doc.context.assign(outlinesRef, doc.context.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
  doc.context.assign(itemRef, doc.context.obj({
    Title: PDFString.of(PDF_SEED.outline),
    Parent: outlinesRef,
    Dest: [page.ref, 'XYZ', null, null, null],
  }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  return save(doc);
}

/** 12. An embedded file (Flate stream) mentioning a name. */
export async function buildPdfEmbeddedFile(): Promise<Uint8Array> {
  const doc = await newDoc();
  rawPage(doc, bytesOf('BT /F1 12 Tf 72 700 Td (See the attachment.) Tj ET'), { F1: await helvetica(doc) });
  await doc.attach(new TextEncoder().encode(PDF_SEED.attachment), 'notes.txt', {
    mimeType: 'text/plain',
    description: 'notes',
    creationDate: FIXED_DATE,
    modificationDate: FIXED_DATE,
  });
  return save(doc);
}

/**
 * 13. A base revision showing 'Jan Kowalski', then a hand-written incremental
 * update: a new content stream with 'Anna Nowak', a new page object pointing
 * at it, an xref section and a trailer with /Prev. The old content stream
 * object stays in the file (Flate, so only an object-level scan sees it).
 */
export async function buildPdfIncrementalUpdate(): Promise<Uint8Array> {
  const doc = await newDoc();
  const page = rawPage(doc, concat(['BT /F1 12 Tf 72 700 Td ', literal(PDF_SEED.jan), ' Tj ET']), { F1: await helvetica(doc) });
  const base = await save(doc);
  const baseText = ascii(base);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(baseText);
  if (!m) throw new Error('base revision has no startxref');
  const prev = Number(m[1]);
  const { Root, Info } = doc.context.trailerInfo;
  if (!(Root instanceof PDFRef)) throw new Error('base revision has no /Root');

  const newNum = doc.context.largestObjectNumber + 1;
  const newContent = doc.context.flateStream(concat(['BT /F1 12 Tf 72 700 Td ', literal(PDF_SEED.anna), ' Tj ET']));
  page.node.set(PDFName.of('Contents'), PDFRef.of(newNum));
  const pageNum = page.ref.objectNumber;

  const serialize = (obj: { sizeInBytes(): number; copyBytesInto(buf: Uint8Array, off: number): number }): Uint8Array => {
    const buf = new Uint8Array(obj.sizeInBytes());
    obj.copyBytesInto(buf, 0);
    return buf;
  };
  const parts: Array<string | Uint8Array> = [base, '\n'];
  let offset = base.length + 1;
  const offsets: Array<[number, number]> = [];
  const pushObj = (num: number, body: Uint8Array): void => {
    offsets.push([num, offset]);
    const head = `${num} 0 obj\n`;
    parts.push(head, body, '\nendobj\n');
    offset += head.length + body.length + 8;
  };
  pushObj(newNum, serialize(newContent));
  pushObj(pageNum, serialize(page.node));
  offsets.sort((a, b) => a[0] - b[0]);
  const xrefOffset = offset;
  let xref = 'xref\n';
  for (const [num, off] of offsets) xref += `${num} 1\n${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${newNum + 1} /Root ${Root.toString()}${Info instanceof PDFRef ? ` /Info ${Info.toString()}` : ''} /Prev ${prev} >>\n`;
  parts.push(xref, trailer, `startxref\n${xrefOffset}\n%%EOF\n`);
  return concat(parts);
}

/** 14. Saved with object streams: page, font and Info dicts live inside an /ObjStm. */
export async function buildPdfObjStm(): Promise<Uint8Array> {
  const doc = await newDoc();
  const font = await helvetica(doc);
  const page = doc.addPage([612, 792]);
  page.drawText(PDF_SEED.tomasz, { x: 72, y: 700, size: 12, font });
  doc.setAuthor(PDF_SEED.tomasz);
  return save(doc, true);
}

export const PDF_ROTATED_CONTENT = concat(['BT /F1 12 Tf 80 Tz 5 Ts 2 Tw 72 700 Td ', literal(`${PDF_SEED.karol} lives here`), ' Tj ET']);

/** 15. /Rotate 90 page with text rise, horizontal scaling and word spacing; 'ó' is WinAnsi 0xF3. */
export async function buildPdfRotatedRiseTz(): Promise<Uint8Array> {
  const doc = await newDoc();
  const page = rawPage(doc, PDF_ROTATED_CONTENT, { F1: await helvetica(doc) });
  page.setRotation(degrees(90));
  return save(doc);
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

const seed = (needle: string, part: string, where: string, encoding: ScanEncoding, via: PdfTraceVia): PdfSeed => ({
  needle,
  part,
  where,
  encoding,
  via,
});

export const PDF_FIXTURES: readonly PdfFixtureSpec[] = [
  {
    name: 'pdf-standard14',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfStandard14,
    seeds: [seed(PDF_SEED.janPesel, 'page1', 'Helvetica Tj operand (hex string) in the page content stream', 'utf8', 'stream string')],
    notes: 'pdf-lib drawText with a standard-14 font writes WinAnsi codes as a hex string; the scanner decodes string operands inside streams.',
  },
  {
    name: 'pdf-type0-liberation',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfType0Liberation,
    seeds: [
      seed(PDF_SEED.janPesel, 'info', 'Info /Subject (UTF-16BE hex string)', 'utf16be', 'string'),
      seed(PDF_SEED.anna, 'info', 'Info /Subject (UTF-16BE hex string)', 'utf16be', 'string'),
    ],
    notes:
      'The page draws both strings with embedded Liberation fonts (LiberationSans-Regular, LiberationSerif-Bold) as Type0 / Identity-H: ' +
      'the Tj operands are glyph ids, recoverable only through the ToUnicode CMap, so no byte scan can see them. ' +
      'The same text is planted in /Subject so the seed check proves the PII is in the file.',
  },
  {
    name: 'pdf-tj-kerning',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfTjKerning,
    seeds: [
      seed('Kowalski', 'page1', 'last element of the TJ array', 'utf8', 'stream'),
      seed('(Ja) -15 (n) -200 (Kowalski)', 'page1', 'the TJ array source: "Jan" is split by kerning adjustments', 'utf8', 'stream'),
    ],
    notes: 'The full name "Jan Kowalski" is never contiguous in the bytes: only a text extractor that applies TJ adjustments sees it.',
  },
  {
    name: 'pdf-split-shows',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfSplitShows,
    seeds: [
      seed('Jan Kow', 'page1', 'first Tj operand', 'utf8', 'stream'),
      seed('alski', 'page1', 'second Tj operand', 'utf8', 'stream'),
    ],
    notes: 'The name continues across two Tj operators with the implicit advance; the two halves are separate literal strings.',
  },
  {
    name: 'pdf-short-names',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfShortNames,
    seeds: [
      seed(PDF_SEED.shortNames, 'page1', '10 pt Helvetica literal', 'utf8', 'stream'),
      seed('Li Wu', 'page1', '2-char names', 'utf8', 'stream'),
      seed('Bo Xu', 'page1', '2-char names', 'utf8', 'stream'),
    ],
    notes: 'Two-character names at 10 pt: a placeholder must fit into a very short run.',
  },
  {
    name: 'pdf-form-xobject',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfFormXObject,
    seeds: [
      seed(PDF_SEED.ewaMail, 'xobject', 'Helvetica literal inside the Form XObject content stream', 'utf8', 'stream'),
      seed(PDF_SEED.ewa, 'info', 'Info /Subject (UTF-16BE hex string)', 'utf16be', 'string'),
    ],
    notes:
      'The page content is only "q ... cm /X1 Do Q"; the XObject (/Type /XObject /Subtype /Form, own /Resources /Font) draws ' +
      '"Ewa Zielińska" with a Liberation Type0 font (glyph ids, ToUnicode only; the same string is planted in /Subject) ' +
      'and the e-mail with Helvetica as a literal string.',
  },
  {
    name: 'pdf-hidden-text',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfHiddenText,
    seeds: [
      seed(PDF_SEED.hiddenTr3, 'page1', 'render mode 3 (3 Tr)', 'utf8', 'stream'),
      seed(PDF_SEED.hiddenWhite, 'page1', 'white fill (1 g)', 'utf8', 'stream'),
      seed(PDF_SEED.hiddenOffPage, 'page1', 'off-page (-500 -500 Td)', 'utf8', 'stream'),
      seed(PDF_SEED.hiddenTiny, 'page1', '0.1 pt font size', 'utf8', 'stream'),
    ],
    notes: 'Four invisible runs a viewer never shows but every text extractor returns.',
  },
  {
    name: 'pdf-actualtext',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfActualText,
    seeds: [seed(PDF_SEED.piotr, 'page1', '/Span <</ActualText (...)>> BDC, UTF-16BE literal with BOM', 'utf16be', 'stream')],
    notes: 'The visible run is "P. Wisniewski"; the full name is only in the ActualText property of the marked-content sequence.',
  },
  {
    name: 'pdf-annotations',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfAnnotations,
    seeds: [
      seed(PDF_SEED.noteContents, 'annots', '/Text annotation /Contents', 'utf8', 'string'),
      seed(PDF_SEED.jan, 'annots', '/Text annotation /T (author)', 'utf8', 'string'),
      seed(PDF_SEED.linkUri, 'annots', '/Link annotation /A /URI', 'utf8', 'string'),
    ],
    notes: 'PII outside the content stream: annotation strings (also visible in the raw file, they are uncompressed literals).',
  },
  {
    name: 'pdf-acroform',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfAcroForm,
    seeds: [seed(PDF_SEED.maria, 'acroform', 'text field /V (UTF-16BE hex string)', 'utf16be', 'string')],
    notes:
      'Field "owner" created with pdf-lib; its appearance stream draws the value with a Liberation Type0 font (glyph ids), ' +
      'the value itself is in /V.',
  },
  {
    name: 'pdf-outlines-info-xmp',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfOutlinesInfoXmp,
    seeds: [
      seed(PDF_SEED.jan, 'info', 'Info /Author (UTF-16BE hex string)', 'utf16be', 'string'),
      seed(PDF_SEED.title, 'info', 'Info /Title (UTF-16BE hex string)', 'utf16be', 'string'),
      seed(PDF_SEED.jan, 'xmp', '/Metadata stream dc:creator (UTF-8 XML, uncompressed)', 'utf8', 'stream'),
      seed(PDF_SEED.title, 'xmp', '/Metadata stream dc:title (UTF-8 XML, uncompressed)', 'utf8', 'stream'),
      seed(PDF_SEED.outline, 'outlines', '/Outlines item /Title', 'utf8', 'string'),
    ],
    notes: 'The same names live in three places with three encodings: Info (UTF-16BE), XMP (UTF-8) and the outline tree (literal).',
  },
  {
    name: 'pdf-embedded-file',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfEmbeddedFile,
    seeds: [seed(PDF_SEED.attachment, 'embedded', '/EmbeddedFile stream (Flate) notes.txt', 'utf8', 'stream')],
    notes: 'doc.attach(): the PII is inside the embedded file stream, reachable through /Names /EmbeddedFiles.',
  },
  {
    name: 'pdf-incremental-update',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfIncrementalUpdate,
    seeds: [
      seed(PDF_SEED.jan, 'prev-revision', 'content stream of the first revision, no longer referenced by the current page', 'utf8', 'stream'),
      seed(PDF_SEED.anna, 'page1', 'content stream of the current revision', 'utf8', 'stream'),
    ],
    notes:
      'Hand-appended incremental update (new content object, new page object, xref section, trailer with /Prev). ' +
      'The current revision shows "Anna Nowak"; the old Flate stream with "Jan Kowalski" is still in the file bytes.',
  },
  {
    name: 'pdf-objstm',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfObjStm,
    seeds: [
      seed(PDF_SEED.tomasz, 'page1', 'Helvetica Tj operand (hex string) in the page content stream', 'utf8', 'stream string'),
      seed(PDF_SEED.tomasz, 'objstm', 'Info /Author (UTF-16BE hex string) inside the /ObjStm', 'utf16be', 'string'),
    ],
    notes: 'Saved with useObjectStreams: the Info, font and AcroForm dicts are Flate-packed inside an /ObjStm and only visible after expansion.',
  },
  {
    name: 'pdf-rotated-rise-tz',
    ext: 'pdf',
    findings: ['PDF'],
    build: buildPdfRotatedRiseTz,
    seeds: [seed(PDF_SEED.karol, 'page1', 'literal with WinAnsi 0xF3 for ó, after 80 Tz 5 Ts 2 Tw', 'latin1', 'stream')],
    notes: '/Rotate 90 page; the run uses horizontal scaling, text rise and word spacing. "ó" is the single WinAnsi byte 0xF3 (latin1 match only).',
  },
];

/** Alias kept for callers that think of the registry as "the seeds". */
export const PDF_SEEDS = PDF_FIXTURES;

/** Build one fixture by name. */
export async function buildPdfFixture(name: string): Promise<Uint8Array> {
  const spec = PDF_FIXTURES.find((f) => f.name === name);
  if (!spec) throw new Error(`unknown PDF fixture ${JSON.stringify(name)}`);
  return spec.build();
}
