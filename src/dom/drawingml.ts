/**
 * @doccloak/core/dom - DrawingML, chart, SmartArt and custom XML text units
 * (T175, security remediation 2026-09, finding H3).
 *
 * PII that appears for the first time in a chart (title, category cache,
 * series name), a SmartArt node, a chart user shape or a custom XML data
 * store was previously invisible to the detector: only the layer-zero value
 * scrub (T172) could remove it, and only when the same value had been
 * detected elsewhere. These helpers turn those parts into text units the
 * docx and xlsx readers register as content parts, so the detector sees the
 * text and the writer applies offset replacements to it.
 *
 * A unit is the list of leaf elements whose concatenated text forms one
 * independent string. Units are separated by newlines in the flat text and
 * every separator is a paragraph break, so a replacement never crosses two
 * units (the T172 rule).
 */

import { OOXML_NS, isElementIn } from './opc.ts';
import type { TextNodeMapping, ParagraphBreak } from './docx.ts';

/** Leaf elements whose concatenated text is one independent string. */
export type TextUnit = Element[];

/** chartEx (Office 2016+ chart types: waterfall, treemap, sunburst, funnel). */
const CHARTEX_NS: ReadonlySet<string> = new Set([
  'http://schemas.microsoft.com/office/drawing/2014/chartex',
]);

/** Chart containers whose c:v children hold strings, not numbers. */
const CHART_STRING_CONTAINERS = new Set(['strCache', 'multiLvlStrCache', 'tx']);

/** True for a c:v that holds a string: inside a string cache or a c:tx literal. */
function isChartStringValue(el: Element): boolean {
  if (!isElementIn(el, OOXML_NS.c, 'v')) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.namespaceURI === null || !OOXML_NS.c.has(p.namespaceURI)) continue;
    if (CHART_STRING_CONTAINERS.has(p.localName)) return true;
    if (p.localName === 'numCache' || p.localName === 'numLit') return false;
  }
  return false;
}

/** Every a:t under a DrawingML paragraph, in document order, non-empty. */
function paragraphLeaves(p: Element): TextUnit {
  const leaves: Element[] = [];
  const all = p.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (isElementIn(el, OOXML_NS.a, 't') && (el.textContent ?? '').length > 0) leaves.push(el);
  }
  return leaves;
}

function hasText(el: Element): boolean {
  return (el.textContent ?? '').trim().length > 0;
}

/**
 * Text units of a DrawingML part, in document order:
 * - every a:p (DrawingML paragraph) as one unit of its a:t leaves: chart
 *   titles, axis titles, data labels, text boxes, SmartArt node text
 *   (dgm:t wraps a:p), chart user shapes;
 * - every c:v inside c:strCache / c:multiLvlStrCache (category and series
 *   name caches) or c:tx (literal series names) as its own unit; numeric
 *   caches (c:numCache) are left alone so a chart's numbers stay numbers;
 * - every chartEx cx:pt (string dimension point) and cx:v (text data).
 * Applies to word/charts, word/diagrams, word/drawings, xl/charts and
 * xl/drawings parts.
 */
export function drawingUnits(doc: Document): TextUnit[] {
  const units: TextUnit[] = [];
  const walk = (parent: Element) => {
    for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (isElementIn(child, OOXML_NS.a, 'p')) {
        const leaves = paragraphLeaves(child);
        if (leaves.length > 0) units.push(leaves);
        continue;
      }
      if (isChartStringValue(child)) {
        if (hasText(child)) units.push([child]);
        continue;
      }
      if (isElementIn(child, CHARTEX_NS, 'pt') || isElementIn(child, CHARTEX_NS, 'v')) {
        if (child.childElementCount === 0 && hasText(child)) units.push([child]);
        continue;
      }
      walk(child);
    }
  };
  if (doc.documentElement) walk(doc.documentElement);
  return units;
}

/**
 * Leaf text this long with only base64 characters is an encoded payload
 * (Power Query mashup, serialized add-in state), not user text: it would
 * flood the editor and the detector without ever matching an entity. The
 * layer-zero value scrub still visits it.
 */
const BLOB_MIN_LENGTH = 256;
const BLOB_PATTERN = /^[A-Za-z0-9+/=\r\n]+$/;

function looksLikeBlob(text: string): boolean {
  return text.length >= BLOB_MIN_LENGTH && BLOB_PATTERN.test(text);
}

/**
 * Every non-empty leaf text node of an arbitrary XML part as its own unit
 * (customXml/item*.xml: cover page properties, bibliography sources,
 * SharePoint document properties). Element and attribute names are never
 * units; attribute values are covered by layer zero.
 */
export function leafTextUnits(doc: Document): TextUnit[] {
  const units: TextUnit[] = [];
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.childElementCount !== 0) continue;
    const text = el.textContent ?? '';
    if (text.trim().length === 0 || looksLikeBlob(text)) continue;
    units.push([el]);
  }
  return units;
}

/**
 * Flatten units into the reader's shape: one line per unit, a
 * TextNodeMapping per non-empty leaf, and a ParagraphBreak at every
 * separating newline so no replacement can span two units.
 */
export function flattenUnits(units: TextUnit[]): {
  plainText: string;
  textNodes: TextNodeMapping[];
  paragraphBreaks: ParagraphBreak[];
} {
  const textNodes: TextNodeMapping[] = [];
  const paragraphBreaks: ParagraphBreak[] = [];
  let plainText = '';
  for (const unit of units) {
    const nodes: TextNodeMapping[] = [];
    let unitLength = 0;
    for (const element of unit) {
      const text = element.textContent ?? '';
      if (text.length === 0) continue;
      nodes.push({ element, flatStart: unitLength, flatEnd: unitLength + text.length });
      unitLength += text.length;
    }
    if (unitLength === 0) continue;
    if (plainText.length > 0) {
      paragraphBreaks.push({ flatIndex: plainText.length });
      plainText += '\n';
    }
    const base = plainText.length;
    for (const node of nodes) {
      node.flatStart += base;
      node.flatEnd += base;
      plainText += node.element.textContent ?? '';
      textNodes.push(node);
    }
  }
  return { plainText, textNodes, paragraphBreaks };
}

/**
 * Remove every c:externalData element (with its c:autoUpdate child) from a
 * chart part so Word never tries to open the embedded workbook the chart
 * was built from. The string and number caches stay, so the chart still
 * renders, and they are redacted like any other unit. Returns the number of
 * elements removed. The embedded workbook itself is reported by the package
 * policy (T177) and removed by T199.
 */
export function stripChartExternalData(doc: Document): number {
  const doomed: Element[] = [];
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (isElementIn(all[i], OOXML_NS.c, 'externalData')) doomed.push(all[i]);
  }
  for (const el of doomed) el.parentNode?.removeChild(el);
  return doomed.length;
}
