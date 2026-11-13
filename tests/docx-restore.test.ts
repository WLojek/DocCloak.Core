// @vitest-environment jsdom
/**
 * Restoring originals inside a docx (WLojek/DocCloak#3): a pseudonymized
 * document goes to an assistant, comes back edited, and the session's
 * placeholders are replaced with the originals in place, formatting kept.
 * The assistant (or Word) splits a placeholder across runs, changes its
 * case, drops brackets, invents tokens: each case below is one of those.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  readDocx,
  writeAnonymizedDocxWithReport,
  writeRestoredDocx,
  writeRestoredDocxWithReport,
  applyTextReplacements,
} from '../src/dom/docx.ts';
import { AnonymizationSession } from '../src/session.ts';
import type { DetectedEntity } from '../src/types.ts';
import { buildDocxFixture, DOCX_SEED, type DocxFixtureOptions } from './helpers/fixtures/index.ts';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function docxWith(parts: Record<string, string>): JSZip {
  const zip = new JSZip();
  const overrides = Object.keys(parts)
    .filter((p) => p !== 'word/document.xml')
    .map((p) => {
      const kind = /header/.test(p) ? 'header' : /footer/.test(p) ? 'footer' : 'footnotes';
      return `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`;
    })
    .join('');
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${overrides}
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  const rels = Object.keys(parts)
    .filter((p) => p !== 'word/document.xml')
    .map((p, i) => {
      const kind = /header/.test(p) ? 'header' : /footer/.test(p) ? 'footer' : 'footnotes';
      return `<Relationship Id="rId${i + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${p.replace('word/', '')}"/>`;
    })
    .join('');
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}">${rels}</Relationships>`);
  for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
  return zip;
}

function body(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${inner}</w:body></w:document>`;
}

async function toFile(source: JSZip | Uint8Array): Promise<File> {
  const ab = source instanceof Uint8Array
    ? (() => { const copy = new Uint8Array(source.length); copy.set(source); return copy.buffer; })()
    : await source.generateAsync({ type: 'arraybuffer' });
  const file = new File([ab], 'test.docx');
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => ab });
  }
  return file;
}

function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((ab) => new Uint8Array(ab));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function sessionOf(entries: Array<[string, string, string]>): AnonymizationSession {
  return AnonymizationSession.deserialize(
    JSON.stringify(entries.map(([original, replacement, entity_type]) => ({ original, replacement, entity_type }))),
  );
}

const MAP: Array<[string, string, string]> = [
  ['Anna Wiśniewska', '[PERSON_1]', 'PERSON'],
  ['Jan Kowalski', '[PERSON_2]', 'PERSON'],
  ['Kowalski', '[PERSON_2_LAST]', 'PERSON'],
  ['Budimex S.A.', '[COMPANY_1]', 'COMPANY'],
  ['anna@firma.example', '[EMAIL_1]', 'EMAIL'],
];

/** Restore `zip` with `session`; returns the written package and its re-read text. */
async function restore(zip: JSZip, session: AnonymizationSession) {
  const extraction = await readDocx(await toFile(zip));
  const before = extraction.plainText;
  const spans = session.restoreSpans(before);
  const unresolved = session.unresolvedTokens(before);
  const blob = await writeRestoredDocx(extraction, spans);
  const bytes = await blobBytes(blob);
  const written = await JSZip.loadAsync(bytes);
  const again = await readDocx(await toFile(bytes));
  return { before, spans, unresolved, written, text: again.plainText };
}

/** Runs of the first paragraph as [text, has w:b, has w:i]. */
function runsOf(xml: string): Array<[string, boolean, boolean]> {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.getElementsByTagNameNS(W, 'r')).map((r) => [
    Array.from(r.getElementsByTagNameNS(W, 't')).map((t) => t.textContent ?? '').join(''),
    r.getElementsByTagNameNS(W, 'b').length > 0,
    r.getElementsByTagNameNS(W, 'i').length > 0,
  ]);
}

describe('writeRestoredDocx', () => {
  it('restores a placeholder Word split across three runs and keeps each run\'s formatting', async () => {
    const zip = docxWith({
      'word/document.xml': body(`<w:p>
        <w:r><w:t xml:space="preserve">Aneks podpisała </w:t></w:r>
        <w:r><w:rPr><w:b/></w:rPr><w:t>[PER</w:t></w:r>
        <w:proofErr w:type="spellStart"/>
        <w:r><w:rPr><w:b/></w:rPr><w:t>SON</w:t></w:r>
        <w:proofErr w:type="spellEnd"/>
        <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">_1] w obecności świadka.</w:t></w:r>
      </w:p>`),
    });
    const { text, written } = await restore(zip, sessionOf(MAP));
    expect(text).toBe('Aneks podpisała Anna Wiśniewska w obecności świadka.');
    const runs = runsOf(await written.file('word/document.xml')!.async('string'));
    expect(runs).toEqual([
      ['Aneks podpisała ', false, false],
      ['Anna Wiśniewska', true, false],
      ['', true, false],
      // The words after the placeholder stay in their own (italic) run.
      [' w obecności świadka.', false, true],
    ]);
  });

  it('restores tokens an assistant mangled and leaves unknown ones in place', async () => {
    const zip = docxWith({
      'word/document.xml': body(`
        <w:p><w:r><w:t>Summary for [person_1] and PERSON_2, see [ COMPANY_1 ] and **[EMAIL_1]**.</w:t></w:r></w:p>
        <w:p><w:r><w:t>Mr [PERSON_2_LAST] met [PERSON_9] of [COMPANY_7] [see par. 3] and [Table 1].</w:t></w:r></w:p>`),
    });
    const { text, unresolved, spans } = await restore(zip, sessionOf(MAP));
    expect(text).toBe(
      'Summary for Anna Wiśniewska and Jan Kowalski, see Budimex S.A. and **anna@firma.example**.\n'
      + 'Mr Kowalski met [PERSON_9] of [COMPANY_7] [see par. 3] and [Table 1].',
    );
    expect(unresolved).toEqual(['[PERSON_9]', '[COMPANY_7]']);
    expect(spans.filter((s) => !s.exact).map((s) => s.token)).toEqual(['[PERSON_1]', '[PERSON_2]', '[COMPANY_1]']);
  });

  it('restores in headers, footers, footnotes, tables and text the assistant added', async () => {
    const zip = docxWith({
      'word/document.xml': body(`
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>[COMPANY_1]</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>[EMAIL_1]</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:t>New paragraph about [PERSON_1].</w:t></w:r></w:p>`),
      'word/header1.xml': `<?xml version="1.0"?><w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Client: [PERSON_2]</w:t></w:r></w:p></w:hdr>`,
      'word/footer1.xml': `<?xml version="1.0"?><w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Prepared for [COMPANY_1]</w:t></w:r></w:p></w:ftr>`,
      'word/footnotes.xml': `<?xml version="1.0"?><w:footnotes xmlns:w="${W}"><w:footnote w:id="1"><w:p><w:r><w:t>See [PERSON_1].</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    });
    const { text, unresolved } = await restore(zip, sessionOf(MAP));
    expect(text).not.toMatch(/\[(?:PERSON|COMPANY|EMAIL)_\d/);
    for (const expected of [
      'Budimex S.A.', 'anna@firma.example', 'New paragraph about Anna Wiśniewska.',
      'Client: Jan Kowalski', 'Prepared for Budimex S.A.', 'See Anna Wiśniewska.',
    ]) {
      expect(text).toContain(expected);
    }
    expect(unresolved).toEqual([]);
  });

  it('writes originals with XML syntax characters as text, the package stays well formed', async () => {
    const zip = docxWith({
      'word/document.xml': body('<w:p><w:r><w:t>Between [COMPANY_1] and [PERSON_1].</w:t></w:r></w:p>'),
    });
    const session = sessionOf([
      ['Smith & Sons <UK> "Ltd"', '[COMPANY_1]', 'COMPANY'],
      ["O'Brien $1 $& \\1", '[PERSON_1]', 'PERSON'],
    ]);
    const { text, written } = await restore(zip, session);
    expect(text).toBe('Between Smith & Sons <UK> "Ltd" and O\'Brien $1 $& \\1.');
    const xml = await written.file('word/document.xml')!.async('string');
    expect(xml).toContain('Smith &amp; Sons &lt;UK&gt;');
    expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
  });

  it('keeps leading and trailing spaces of a restored value (xml:space)', async () => {
    const zip = docxWith({
      'word/document.xml': body(`<w:p><w:r><w:t>[PERSON_1]</w:t></w:r><w:r><w:t>signed.</w:t></w:r></w:p>`),
    });
    const { text, written } = await restore(zip, sessionOf([['Anna Nowak ', '[PERSON_1]', 'PERSON']]));
    expect(text).toBe('Anna Nowak signed.');
    expect(await written.file('word/document.xml')!.async('string')).toMatch(/xml:space="preserve"[^>]*>Anna Nowak </);
  });

  it('changes nothing when the document holds no placeholder of the session', async () => {
    const zip = docxWith({
      'word/document.xml': body('<w:p><w:r><w:t>Nothing to restore here, [Table 1] stays.</w:t></w:r></w:p>'),
    });
    const { text, spans, unresolved, before } = await restore(zip, sessionOf(MAP));
    expect(spans).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(text).toBe(before);
  });

  it('never restores twice: an original that reads like a placeholder is written once', async () => {
    const zip = docxWith({
      'word/document.xml': body('<w:p><w:r><w:t>[PERSON_1] and [PERSON_2]</w:t></w:r></w:p>'),
    });
    const session = sessionOf([
      ['[PERSON_2]', '[PERSON_1]', 'PERSON'],
      ['Jan Kowalski', '[PERSON_2]', 'PERSON'],
    ]);
    const { text } = await restore(zip, session);
    expect(text).toBe('[PERSON_2] and Jan Kowalski');
  });
});

describe('round trip: pseudonymize, then restore', () => {
  const variants: Record<string, DocxFixtureOptions> = {
    base: {},
    strict: { strict: true },
    textbox: { textbox: true },
    tabHyphen: { tabHyphen: true },
    omml: { omml: true },
    delInstrText: { delInstrText: true },
    numbering: { numbering: true },
    chart: { chart: true },
    diagram: { diagram: true },
    customXml: { customXml: true },
  };
  const seeds = Object.values(DOCX_SEED) as string[];

  for (const [name, options] of Object.entries(variants)) {
    it(`${name}: the restored text equals the original text`, async () => {
      const original = await readDocx(await toFile(await buildDocxFixture(options)));
      const text = original.plainText;
      const entities: DetectedEntity[] = [];
      for (const value of seeds) {
        for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + value.length)) {
          entities.push({
            type: value.includes('@') ? 'EMAIL' : 'OTHER',
            value, start: i, end: i + value.length, confidence: 1, detector: 'regex',
          } as DetectedEntity);
        }
      }
      entities.sort((a, b) => a.start - b.start);
      expect(entities.length).toBeGreaterThan(0);

      const session = new AnonymizationSession();
      session.anonymizeText(text, entities);
      const { blob } = await writeAnonymizedDocxWithReport(
        original,
        entities.map((e) => ({ start: e.start, end: e.end, replacement: session.getForward(e.value)! })),
        entities.map((e) => ({ value: e.value, replacement: session.getForward(e.value)! })),
        { allowUnredactable: true },
      );
      const anonymized = await readDocx(await toFile(await blobBytes(blob)));
      for (const e of entities) expect(anonymized.plainText).not.toContain(e.value);

      const spans = session.restoreSpans(anonymized.plainText);
      const restored = await readDocx(await toFile(await blobBytes(await writeRestoredDocx(anonymized, spans))));
      expect(restored.plainText).toBe(text);
    });
  }
});

describe('a value that ran across a paragraph break', () => {
  it('comes back complete, as one piece where its placeholder stands', async () => {
    // A detector sometimes takes the end of one paragraph and the start of
    // the next as one value (a name and the number below it). The writer
    // puts the placeholder in the first paragraph and removes the rest from
    // the second, so the restore has one place to write the value to.
    const zip = docxWith({
      'word/document.xml': body(`
        <w:p><w:r><w:t>Bank: Acme Bank</w:t></w:r></w:p>
        <w:p><w:r><w:t>40 Main Street, London</w:t></w:r></w:p>`),
    });
    const original = await readDocx(await toFile(zip));
    expect(original.plainText).toBe('Bank: Acme Bank\n40 Main Street, London');
    const value = 'Acme Bank\n40';
    const start = original.plainText.indexOf(value);
    const entity = { type: 'COMPANY', value, start, end: start + value.length, confidence: 1, detector: 'ml' } as DetectedEntity;
    const session = new AnonymizationSession();
    session.anonymizeText(original.plainText, [entity]);
    const { blob } = await writeAnonymizedDocxWithReport(
      original,
      [{ start: entity.start, end: entity.end, replacement: session.getForward(value)! }],
      [{ value, replacement: session.getForward(value)! }],
    );
    const anonymized = await readDocx(await toFile(await blobBytes(blob)));
    expect(anonymized.plainText).toBe('Bank: [COMPANY_1]\n Main Street, London');

    const restored = await readDocx(await toFile(await blobBytes(
      await writeRestoredDocx(anonymized, session.restoreSpans(anonymized.plainText)),
    )));
    // Nothing is lost; the "40" stays with the name instead of opening the next paragraph.
    expect(restored.plainText).toBe('Bank: Acme Bank\n40\n Main Street, London');
    expect(restored.plainText.replace(/\s+/g, '')).toBe(original.plainText.replace(/\s+/g, ''));
  });
});

describe('applyTextReplacements across runs', () => {
  it('leaves the text after the range in its own run', async () => {
    const zip = docxWith({
      'word/document.xml': body(`<w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Signed by Anna </w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>Wiśniewska in Warsaw.</w:t></w:r>
      </w:p>`),
    });
    const extraction = await readDocx(await toFile(zip));
    const start = extraction.plainText.indexOf('Anna');
    const end = start + 'Anna Wiśniewska'.length;
    applyTextReplacements(extraction.textNodes, [{ start, end, replacement: '[PERSON_1]' }]);
    const xml = new XMLSerializer().serializeToString(extraction.contentParts[0].xmlDoc);
    expect(runsOf(xml)).toEqual([
      ['Signed by [PERSON_1]', true, false],
      [' in Warsaw.', false, true],
    ]);
    // Positions stay consistent for the replacements applied before this one.
    const nodes = extraction.textNodes;
    expect(nodes[0].flatEnd - nodes[0].flatStart).toBe('Signed by [PERSON_1]'.length);
    expect(nodes[1].flatStart).toBe(nodes[0].flatEnd);
    expect(nodes[1].flatEnd - nodes[1].flatStart).toBe(' in Warsaw.'.length);
  });

  it('applies several multi-run replacements in one paragraph', async () => {
    const zip = docxWith({
      'word/document.xml': body(`<w:p>
        <w:r><w:t>A [PER</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>SON_1] B [COM</w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>PANY_1] C [PERSON_2] D</w:t></w:r>
      </w:p>`),
    });
    const { text, written } = await restore(zip, sessionOf(MAP));
    expect(text).toBe('A Anna Wiśniewska B Budimex S.A. C Jan Kowalski D');
    expect(runsOf(await written.file('word/document.xml')!.async('string'))).toEqual([
      ['A Anna Wiśniewska', false, false],
      [' B Budimex S.A.', true, false],
      [' C Jan Kowalski D', false, true],
    ]);
  });
});

describe('labels outside the flat text: properties and link targets', () => {
  const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
  const DC = 'http://purl.org/dc/elements/1.1/';
  const DCTERMS = 'http://purl.org/dc/terms/';
  const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
  const EP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
  const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
  const CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
  const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

  const CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="${CP}" xmlns:dc="${DC}" xmlns:dcterms="${DCTERMS}" xmlns:xsi="${XSI}"><dc:title>Memo for [PERSON_1]</dc:title><dc:subject>[COMPANY_1] engagement</dc:subject><dc:creator>assistant</dc:creator><cp:keywords>[PERSON_2]; [PERSON_9]</cp:keywords><dc:description>Reply to [person_1] about PERSON_2</dc:description><cp:category></cp:category><cp:revision>3</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">2026-11-13T10:00:00Z</dcterms:created></cp:coreProperties>`;
  const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${EP}" xmlns:vt="${VT}"><Application>Microsoft Office Word</Application><Pages>2</Pages><Company>[COMPANY_1]</Company><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Memo for [PERSON_1]</vt:lpstr></vt:vector></TitlesOfParts><AppVersion>16.0000</AppVersion></Properties>`;
  const CUSTOM_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="${CUSTOM}" xmlns:vt="${VT}"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>[PERSON_2]</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="File of [PERSON_1]"><vt:i4>42</vt:i4></property></Properties>`;
  const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${HYPERLINK}" Target="mailto:[EMAIL_1]" TargetMode="External"/><Relationship Id="rId2" Type="${HYPERLINK}" Target="https://crm.example/klient/%5BPERSON_2%5D?note=Re%3A%20%5BCOMPANY_1%5D&amp;id=7" TargetMode="External"/><Relationship Id="rId3" Type="${HYPERLINK}" Target="[URL_1]" TargetMode="External"/><Relationship Id="rId4" Type="${HYPERLINK}" Target="https://example.com/[PERSON_9]" TargetMode="External"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/[PERSON_1].png"/></Relationships>`;

  const LINK_MAP: Array<[string, string, string]> = [...MAP, ['https://firma.example/akta?id=1&x=a b', '[URL_1]', 'URL']];

  function reply(): JSZip {
    const zip = docxWith({
      'word/document.xml': body('<w:p><w:r><w:t>Dear [PERSON_1], see the link.</w:t></w:r></w:p>'),
    });
    zip.file('docProps/core.xml', CORE);
    zip.file('docProps/app.xml', APP);
    zip.file('docProps/custom.xml', CUSTOM_PROPS);
    zip.file('word/_rels/document.xml.rels', RELS);
    return zip;
  }

  const OUTSIDE = ['docProps/core.xml', 'docProps/app.xml', 'docProps/custom.xml', 'word/_rels/document.xml.rels'];

  async function partsOf(blob: Blob): Promise<Record<string, string>> {
    const zip = await JSZip.loadAsync(await blobBytes(blob));
    const parts: Record<string, string> = {};
    for (const path of [...OUTSIDE, 'word/document.xml']) parts[path] = await zip.file(path)!.async('string');
    return parts;
  }

  it('restores them through restoreText and lists the restored strings', async () => {
    const session = sessionOf(LINK_MAP);
    const extraction = await readDocx(await toFile(reply()));
    const { blob, outsideText } = await writeRestoredDocxWithReport(
      extraction,
      session.restoreSpans(extraction.plainText),
      { restoreText: (text) => session.deanonymize(text) },
    );
    const parts = await partsOf(blob);

    const core = parts['docProps/core.xml'];
    expect(core).toContain('<dc:title>Memo for Anna Wiśniewska</dc:title>');
    expect(core).toContain('<dc:subject>Budimex S.A. engagement</dc:subject>');
    // A label the session does not know stays as written.
    expect(core).toContain('<cp:keywords>Jan Kowalski; [PERSON_9]</cp:keywords>');
    // Mangled labels are restored like in the text.
    expect(core).toContain('<dc:description>Reply to Anna Wiśniewska about Jan Kowalski</dc:description>');
    // Counts and dates are not user text.
    expect(core).toContain('<cp:revision>3</cp:revision>');
    expect(core).toContain('2026-11-13T10:00:00Z');

    const app = parts['docProps/app.xml'];
    expect(app).toContain('<Company>Budimex S.A.</Company>');
    expect(app).toContain('<vt:lpstr>Memo for Anna Wiśniewska</vt:lpstr>');
    expect(app).toContain('<Application>Microsoft Office Word</Application>');

    const custom = parts['docProps/custom.xml'];
    expect(custom).toContain('name="Client"><vt:lpwstr>Jan Kowalski</vt:lpwstr>');
    expect(custom).toContain('name="File of Anna Wiśniewska"><vt:i4>42</vt:i4>');

    const rels = parts['word/_rels/document.xml.rels'];
    // In a mailto: target the address is an address.
    expect(rels).toContain('Target="mailto:anna@firma.example"');
    // Inside a URL a value is percent-encoded, the way the anonymizer writes into one; the rest keeps its characters.
    expect(rels).toContain('Target="https://crm.example/klient/Jan%20Kowalski?note=Re%3A%20Budimex%20S.A.&amp;id=7"');
    // A target that was a label is the value as a link.
    expect(rels).toContain('Target="https://firma.example/akta?id=1&amp;x=a%20b"');
    expect(rels).toContain('Target="https://example.com/[PERSON_9]"');
    // An internal target is a part name.
    expect(rels).toContain('Target="media/[PERSON_1].png"');

    expect(outsideText).toEqual([
      'Memo for Anna Wiśniewska',
      'Budimex S.A. engagement',
      'assistant',
      'Jan Kowalski; [PERSON_9]',
      'Reply to Anna Wiśniewska about Jan Kowalski',
      'Budimex S.A.',
      'Memo for Anna Wiśniewska',
      'Client',
      'Jan Kowalski',
      'File of Anna Wiśniewska',
      'mailto:anna@firma.example',
      'https://crm.example/klient/Jan Kowalski?note=Re: Budimex S.A.&id=7',
      'https://firma.example/akta?id=1&x=a b',
      'https://example.com/[PERSON_9]',
    ]);
    // The host looks for labels that stayed in exactly these strings.
    expect(session.unresolvedTokens(outsideText.join('\n'))).toEqual(['[PERSON_9]']);
    expect(parts['word/document.xml']).toContain('Dear Anna Wiśniewska, see the link.');
    for (const xml of Object.values(parts)) {
      expect(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
    }
  });

  it('changes nothing outside the text without restoreText and lists the labels', async () => {
    const session = sessionOf(LINK_MAP);
    const extraction = await readDocx(await toFile(reply()));
    const { blob, outsideText } = await writeRestoredDocxWithReport(extraction, session.restoreSpans(extraction.plainText));
    const parts = await partsOf(blob);
    expect(parts['docProps/core.xml']).toBe(CORE);
    expect(parts['docProps/app.xml']).toBe(APP);
    expect(parts['docProps/custom.xml']).toBe(CUSTOM_PROPS);
    expect(parts['word/_rels/document.xml.rels']).toBe(RELS);
    expect(parts['word/document.xml']).toContain('Dear Anna Wiśniewska, see the link.');
    expect(outsideText).toEqual([
      'Memo for [PERSON_1]',
      '[COMPANY_1] engagement',
      'assistant',
      '[PERSON_2]; [PERSON_9]',
      'Reply to [person_1] about PERSON_2',
      '[COMPANY_1]',
      'Memo for [PERSON_1]',
      'Client',
      '[PERSON_2]',
      'File of [PERSON_1]',
      'mailto:[EMAIL_1]',
      // A link target is listed decoded, so a label in it reads as a label.
      'https://crm.example/klient/[PERSON_2]?note=Re: [COMPANY_1]&id=7',
      '[URL_1]',
      'https://example.com/[PERSON_9]',
    ]);
  });

  it('writes the same file as before when called with two arguments', async () => {
    const session = sessionOf(LINK_MAP);
    const first = await readDocx(await toFile(reply()));
    const two = await writeRestoredDocx(first, session.restoreSpans(first.plainText));
    const second = await readDocx(await toFile(reply()));
    const three = await writeRestoredDocx(second, session.restoreSpans(second.plainText), {});
    const parts = await partsOf(two);
    expect(parts['docProps/core.xml']).toBe(CORE);
    expect(parts['docProps/app.xml']).toBe(APP);
    expect(parts['docProps/custom.xml']).toBe(CUSTOM_PROPS);
    expect(parts['word/_rels/document.xml.rels']).toBe(RELS);
    expect(parts['word/document.xml']).toContain('Dear Anna Wiśniewska, see the link.');
    expect(await partsOf(three)).toEqual(parts);
    // The plain variant takes the option too.
    const third = await readDocx(await toFile(reply()));
    const restored = await writeRestoredDocx(third, session.restoreSpans(third.plainText), { restoreText: (text) => session.deanonymize(text) });
    expect((await partsOf(restored))['docProps/core.xml']).toContain('<dc:title>Memo for Anna Wiśniewska</dc:title>');
  });

  it('leaves a property part that does not parse and a package without properties', async () => {
    const session = sessionOf(MAP);
    const broken = reply();
    broken.file('docProps/core.xml', '<cp:coreProperties><dc:title>[PERSON_1]');
    broken.remove('docProps/app.xml');
    broken.remove('docProps/custom.xml');
    const extraction = await readDocx(await toFile(broken));
    const { blob, outsideText } = await writeRestoredDocxWithReport(extraction, [], { restoreText: (text) => session.deanonymize(text) });
    const zip = await JSZip.loadAsync(await blobBytes(blob));
    expect(await zip.file('docProps/core.xml')!.async('string')).toBe('<cp:coreProperties><dc:title>[PERSON_1]');
    expect(outsideText).toEqual([
      'mailto:anna@firma.example',
      'https://crm.example/klient/Jan Kowalski?note=Re: Budimex S.A.&id=7',
      '[URL_1]',
      'https://example.com/[PERSON_9]',
    ]);
  });

  it('brings a link the anonymizer rewrote back to what it was, but never a mail address', async () => {
    const zip = docxWith({
      'word/document.xml': body('<w:p><w:r><w:t>File of Jan Kowalski at Budimex S.A., mail anna@firma.example.</w:t></w:r></w:p>'),
    });
    const original = 'https://crm.example/klient/Jan%20Kowalski?firma=Budimex%20S.A.';
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${HYPERLINK}" Target="${original}" TargetMode="External"/><Relationship Id="rId2" Type="${HYPERLINK}" Target="mailto:anna@firma.example" TargetMode="External"/></Relationships>`);
    const source = await readDocx(await toFile(zip));
    const text = source.plainText;
    const session = new AnonymizationSession();
    const entities = (['Jan Kowalski', 'Budimex S.A.', 'anna@firma.example'] as const).map((value) => ({
      type: value.includes('@') ? 'EMAIL' : value.includes('S.A.') ? 'COMPANY' : 'PERSON',
      value, start: text.indexOf(value), end: text.indexOf(value) + value.length, confidence: 1, detector: 'regex',
    } as DetectedEntity));
    session.anonymizeText(text, entities);
    const pairs = entities.map((e) => ({ value: e.value, replacement: session.getForward(e.value)! }));
    const { blob } = await writeAnonymizedDocxWithReport(
      source, entities.map((e, i) => ({ start: e.start, end: e.end, replacement: pairs[i].replacement })), pairs,
    );
    const anonymized = await readDocx(await toFile(await blobBytes(blob)));
    const { blob: restoredBlob, outsideText } = await writeRestoredDocxWithReport(
      anonymized, session.restoreSpans(anonymized.plainText), { restoreText: (t) => session.deanonymize(t) },
    );
    const rels = await (await JSZip.loadAsync(await blobBytes(restoredBlob))).file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain(`Target="${original}"`);
    // The anonymizer replaced the whole mailto: target: the address is not in the file and does not come back.
    expect(rels).toContain('Target="mailto:redacted@example.invalid"');
    expect(outsideText).toEqual(['https://crm.example/klient/Jan Kowalski?firma=Budimex S.A.', 'mailto:redacted@example.invalid']);
  });
});
