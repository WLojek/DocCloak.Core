// @vitest-environment jsdom
//
// T175: DrawingML / chart / SmartArt / custom XML text units.
import { describe, it, expect } from 'vitest';
import {
  drawingUnits,
  leafTextUnits,
  flattenUnits,
  stripChartExternalData,
} from '../src/dom/drawingml.ts';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const A_STRICT = 'http://purl.oclc.org/ooxml/drawingml/main';
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const CX = 'http://schemas.microsoft.com/office/drawing/2014/chartex';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror').length, 'fixture XML must parse').toBe(0);
  return doc;
}

function unitTexts(doc: Document, units = drawingUnits(doc)): string[] {
  return units.map((unit) => unit.map((el) => el.textContent ?? '').join(''));
}

function chartXml(inner: string, ns = { a: A, c: C }): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${ns.c}" xmlns:a="${ns.a}" xmlns:r="${R}">${inner}</c:chartSpace>`;
}

describe('drawingUnits (T175)', () => {
  it('joins the runs of one a:p into one unit and keeps paragraphs apart', () => {
    const doc = parse(chartXml(
      `<c:chart><c:title><c:tx><c:rich><a:bodyPr/>` +
      `<a:p><a:r><a:t>Sales of </a:t></a:r><a:r><a:rPr b="1"/><a:t>Jan Kowalski</a:t></a:r></a:p>` +
      `<a:p><a:r><a:t>Second line</a:t></a:r></a:p>` +
      `</c:rich></c:tx></c:title></c:chart>`,
    ));
    expect(unitTexts(doc)).toEqual(['Sales of Jan Kowalski', 'Second line']);
    expect(drawingUnits(doc)[0]).toHaveLength(2);
  });

  it('takes c:v from string caches, multi-level caches and c:tx literals, never from numeric caches', () => {
    const doc = parse(chartXml(
      `<c:chart><c:plotArea><c:barChart><c:ser>` +
      `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Series Anna</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
      `<c:cat><c:multiLvlStrRef><c:f>Sheet1!$A$2:$A$3</c:f><c:multiLvlStrCache><c:ptCount val="2"/>` +
      `<c:lvl><c:pt idx="0"><c:v>anna@acme.example</c:v></c:pt><c:pt idx="1"><c:v>bob@acme.example</c:v></c:pt></c:lvl>` +
      `</c:multiLvlStrCache></c:multiLvlStrRef></c:cat>` +
      `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/>` +
      `<c:pt idx="0"><c:v>90010112345</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val>` +
      `</c:ser><c:ser><c:tx><c:v>Literal name</c:v></c:tx></c:ser>` +
      `</c:barChart></c:plotArea></c:chart>`,
    ));
    expect(unitTexts(doc)).toEqual(['Series Anna', 'anna@acme.example', 'bob@acme.example', 'Literal name']);
  });

  it('reads SmartArt node text (dgm:t wraps a:p) and strict-namespace a:t', () => {
    const doc = parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<dgm:dataModel xmlns:dgm="${DGM}" xmlns:a="${A_STRICT}"><dgm:ptLst>
<dgm:pt modelId="1"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Node Anna</a:t></a:r></a:p></dgm:t></dgm:pt>
<dgm:pt modelId="2"><dgm:t><a:bodyPr/><a:p><a:r><a:t></a:t></a:r></a:p></dgm:t></dgm:pt>
<dgm:pt modelId="3"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Node Bob</a:t></a:r></a:p></dgm:t></dgm:pt>
</dgm:ptLst></dgm:dataModel>`);
    expect(unitTexts(doc)).toEqual(['Node Anna', 'Node Bob']);
  });

  it('reads chartEx string dimension points and text data', () => {
    const doc = parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cx:chartSpace xmlns:cx="${CX}" xmlns:a="${A}"><cx:chartData><cx:data id="0">
<cx:strDim type="cat"><cx:f>Sheet1!$A$2:$A$3</cx:f><cx:lvl ptCount="2"><cx:pt idx="0">Anna Nowak</cx:pt><cx:pt idx="1">Bob Smith</cx:pt></cx:lvl></cx:strDim>
<cx:numDim type="size"><cx:f>Sheet1!$B$2:$B$3</cx:f><cx:lvl ptCount="2" formatCode="General"><cx:pt idx="0">5</cx:pt><cx:pt idx="1">7</cx:pt></cx:lvl></cx:numDim>
</cx:data></cx:chartData><cx:chart><cx:title><cx:tx><cx:txData><cx:v>Treemap of clients</cx:v></cx:txData></cx:tx></cx:title></cx:chart></cx:chartSpace>`);
    // Numeric dimension points are cx:pt too: they are reported as units
    // (a number in a string context is harmless), the string ones matter.
    const texts = unitTexts(doc);
    expect(texts).toContain('Anna Nowak');
    expect(texts).toContain('Bob Smith');
    expect(texts).toContain('Treemap of clients');
  });

  it('returns no units for a chart without text', () => {
    const doc = parse(chartXml(`<c:chart><c:plotArea/></c:chart>`));
    expect(drawingUnits(doc)).toEqual([]);
  });
});

describe('leafTextUnits (T175)', () => {
  it('yields every non-blank leaf text node, never containers or attributes', () => {
    const doc = parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<CoverPageProperties xmlns="http://schemas.microsoft.com/office/2006/coverPageProps" author="attr-only">
  <PublishDate/><Abstract>   </Abstract><CompanyAddress>1 Main St</CompanyAddress>
  <CompanyEmail>cover@acme.example</CompanyEmail>
</CoverPageProperties>`);
    const texts = unitTexts(doc, leafTextUnits(doc));
    expect(texts).toEqual(['1 Main St', 'cover@acme.example']);
  });

  it('skips base64 payloads so an encoded blob never floods the editor', () => {
    const blob = 'QUJD'.repeat(100);
    const doc = parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<DataMashup xmlns="http://schemas.microsoft.com/DataMashup">${blob}</DataMashup>`);
    expect(leafTextUnits(doc)).toEqual([]);
    const short = parse(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><x><v>QUJD</v></x>`);
    expect(unitTexts(short, leafTextUnits(short))).toEqual(['QUJD']);
  });
});

describe('flattenUnits (T175)', () => {
  it('puts one unit per line, maps every leaf and records each separator as a break', () => {
    const doc = parse(chartXml(
      `<c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Ab</a:t></a:r><a:r><a:t>cd</a:t></a:r></a:p></c:rich></c:tx></c:title>` +
      `<c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>xyz</c:v></c:pt></c:strCache></c:strRef></c:cat></c:ser></c:barChart></c:plotArea></c:chart>`,
    ));
    const flat = flattenUnits(drawingUnits(doc));
    expect(flat.plainText).toBe('Abcd\nxyz');
    expect(flat.paragraphBreaks).toEqual([{ flatIndex: 4 }]);
    expect(flat.textNodes.map((n) => [n.flatStart, n.flatEnd])).toEqual([[0, 2], [2, 4], [5, 8]]);
    expect(flat.textNodes.map((n) => n.element.localName)).toEqual(['t', 't', 'v']);
  });

  it('is empty for no units', () => {
    expect(flattenUnits([])).toEqual({ plainText: '', textNodes: [], paragraphBreaks: [] });
  });
});

describe('stripChartExternalData (T175)', () => {
  it('removes c:externalData with its c:autoUpdate and leaves the caches', () => {
    const doc = parse(chartXml(
      `<c:chart><c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>kept</c:v></c:pt></c:strCache></c:strRef></c:cat></c:ser></c:barChart></c:plotArea></c:chart>` +
      `<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>`,
    ));
    expect(stripChartExternalData(doc)).toBe(1);
    const xml = new XMLSerializer().serializeToString(doc);
    expect(xml).not.toContain('externalData');
    expect(xml).not.toContain('autoUpdate');
    expect(xml).toContain('<c:v>kept</c:v>');
    expect(stripChartExternalData(doc)).toBe(0);
  });
});
