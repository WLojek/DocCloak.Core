/**
 * @doccloak/core/dom - shared OPC (Open Packaging Conventions) helpers (T110).
 *
 * Both .docx and .xlsx are OPC packages: a zip with XML parts, docProps
 * metadata, relationship files and an optional thumbnail. The metadata
 * scrubbing that is format-independent lives here so the xlsx module does not
 * duplicate the docx module's logic. The docx module keeps its historical
 * implementation untouched (behavior-preservation for existing callers); new
 * code paths use these helpers.
 */

import type JSZip from 'jszip';
import type { ValueReplacement } from '../docx.ts';

// ---------------------------------------------------------------------------
// Namespaces (T172, H1)
// ---------------------------------------------------------------------------

/**
 * OOXML namespace families. Every family holds the ECMA-376 transitional URI
 * (what Word/Excel write by default) and the ISO/IEC 29500 strict URI
 * (purl.oclc.org, written by "Strict Open XML Document"). Matching only the
 * transitional form let a strict file through with zero extracted text and
 * an unredacted copy as the "result" (SECURITY_REPORT-2026-09 H1).
 */
export const OOXML_NS = {
  /** WordprocessingML main */
  w: new Set([
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ]),
  /** SpreadsheetML main */
  ss: new Set([
    'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'http://purl.oclc.org/ooxml/spreadsheetml/main',
  ]),
  /** DrawingML main (a:) */
  a: new Set([
    'http://schemas.openxmlformats.org/drawingml/2006/main',
    'http://purl.oclc.org/ooxml/drawingml/main',
  ]),
  /** DrawingML chart (c:) */
  c: new Set([
    'http://schemas.openxmlformats.org/drawingml/2006/chart',
    'http://purl.oclc.org/ooxml/drawingml/chart',
  ]),
  /** DrawingML diagram / SmartArt (dgm:) */
  dgm: new Set([
    'http://schemas.openxmlformats.org/drawingml/2006/diagram',
    'http://purl.oclc.org/ooxml/drawingml/diagram',
  ]),
  /** Office Math (m:) */
  m: new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/math',
    'http://purl.oclc.org/ooxml/officeDocument/math',
  ]),
  /** Markup compatibility (mc:); the strict profile keeps the same URI */
  mc: new Set([
    'http://schemas.openxmlformats.org/markup-compatibility/2006',
  ]),
  /** Package relationships references (r:), attribute values are rIds */
  r: new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
  ]),
  /** WordprocessingML drawing (wp:), carries wp:docPr alt text (T174) */
  wp: new Set([
    'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    'http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing',
  ]),
} as const;

/** True when the element has the local name and one of the namespaces. */
export function isElementIn(el: Element, namespaces: ReadonlySet<string>, localName: string): boolean {
  return el.localName === localName && el.namespaceURI !== null && namespaces.has(el.namespaceURI);
}

/**
 * getElementsByTagNameNS across a namespace family, in document order. The
 * result is a static array, so callers may remove elements while iterating.
 */
export function elementsByLocalName(
  root: Document | Element,
  namespaces: ReadonlySet<string>,
  localName: string
): Element[] {
  const result: Element[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (isElementIn(all[i], namespaces, localName)) result.push(all[i]);
  }
  return result;
}

/**
 * Namespace prefixes the office readers understand as "one of ours". An
 * element outside every family here is foreign: when the main part yields
 * no paragraph (or no sheetData) while foreign elements are present, the
 * reader refuses the file instead of exporting an unredacted copy.
 */
const KNOWN_NAMESPACE_PREFIXES = [
  'http://schemas.openxmlformats.org/',
  'http://purl.oclc.org/ooxml/',
  'http://schemas.microsoft.com/office/',
  'urn:schemas-microsoft-com:',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2001/XMLSchema',
];

/** Distinct namespace URIs of elements that belong to no known OOXML family. */
export function foreignNamespaces(root: Document | Element): string[] {
  const seen = new Set<string>();
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const ns = all[i].namespaceURI ?? '';
    if (KNOWN_NAMESPACE_PREFIXES.some((prefix) => ns.startsWith(prefix))) continue;
    seen.add(ns === '' ? '(no namespace)' : ns);
  }
  return [...seen];
}

/** Parse one XML part from the zip; null when absent or malformed. */
export async function readXmlPart(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  const xmlStr = await file.async('string');
  const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  return doc;
}

/** Serialize an XML document back into the zip at the given path. */
export function writeXmlPart(zip: JSZip, path: string, doc: Document): void {
  zip.file(path, new XMLSerializer().serializeToString(doc));
}

/** Blank the text content of every element whose local name is in the set. */
export function blankElementsByLocalName(doc: Document, names: Set<string>): void {
  setElementsTextByLocalName(doc, names, '');
}

/** Set the text content of every element whose local name is in the set. */
function setElementsTextByLocalName(root: Document | Element, names: Set<string>, value: string): void {
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (names.has(all[i].localName)) all[i].textContent = value;
  }
}

/** Remove every element whose local name is in the set (static snapshot first). */
function removeElementsByLocalName(doc: Document, names: Set<string>): void {
  const all = doc.getElementsByTagName('*');
  const doomed: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    if (names.has(all[i].localName)) doomed.push(all[i]);
  }
  for (const el of doomed) el.parentNode?.removeChild(el);
}

/**
 * The timestamp written wherever a date would fingerprint the original
 * (T179, M6): docProps created/modified/lastPrinted and w:date on comments,
 * revisions and property-change records. A fixed value instead of removal
 * keeps the elements schema-valid (dcterms:* carry xsi:type="dcterms:W3CDTF").
 */
export const NORMALISED_DATE = '2000-01-01T00:00:00Z';

/**
 * Replace every occurrence of each sensitive value (case-insensitive) in a
 * string. A replacer function keeps '$' sequences in values/placeholders inert.
 *
 * Longer values are applied first so a name variant ("Kowalski") can never
 * pre-empt the fuller form it is part of ("Jan Kowalski") and leave the rest
 * of it behind. When the input is a URL (urlEncode), the percent-encoded form
 * of each value is matched too, so "Jan%20Kowalski" in a hyperlink target is
 * scrubbed as a whole.
 */
export function replaceSensitiveValues(
  input: string,
  valueReplacements: ValueReplacement[],
  urlEncode: boolean,
  options: { wordBoundary?: boolean } = {}
): string {
  let result = input;
  const ordered = [...valueReplacements]
    .filter(({ value }) => value)
    .sort((a, b) => b.value.length - a.value.length);
  for (const { value, replacement } of ordered) {
    const forms = [value];
    if (urlEncode) {
      const encoded = encodeURIComponent(value);
      if (encoded !== value) forms.push(encoded);
    }
    const alternatives = forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // Boundaries are only meaningful for values that begin and end with a
    // word character; \b would otherwise make a value like "(c)" unmatchable.
    const bounded = options.wordBoundary && /^\w[\s\S]*\w$|^\w$/.test(value);
    const pattern = bounded ? `\\b(?:${alternatives})\\b` : alternatives;
    const substitute = urlEncode ? encodeURIComponent(replacement) : replacement;
    result = result.replace(new RegExp(pattern, 'gi'), () => substitute);
  }
  return result;
}

/**
 * Value list for the layer-zero scrub (T172): every session entry plus, for
 * PERSON entries, each whitespace-separated token of at least four characters
 * that contains a letter, mapped to the entry's placeholder. A surname that
 * appears alone in a chart cache or a custom XML part is then caught even if
 * it never got its own session entry. Tokens already present as entries keep
 * their own replacement; replaceSensitiveValues applies longer values first,
 * so the full name always wins over a token inside it.
 *
 * office.ts (redactOfficeFile) is the intended caller; hosts that call the
 * writers directly can build their list through this helper too.
 */
export function layerZeroValueReplacements(
  entries: ReadonlyArray<{ original: string; replacement: string; entityType?: string }>
): ValueReplacement[] {
  const result: ValueReplacement[] = [];
  const seen = new Set<string>();
  const add = (value: string, replacement: string) => {
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) return;
    seen.add(key);
    result.push({ value, replacement });
  };
  for (const entry of entries) add(entry.original, entry.replacement);
  for (const entry of entries) {
    if (entry.entityType !== 'PERSON') continue;
    for (const raw of entry.original.split(/\s+/)) {
      const token = raw.replace(/^[.,;:!?()"'\u201E\u201C\u201D]+|[.,;:!?()"'\u201E\u201C\u201D]+$/g, '');
      if (token.length >= 4 && /\p{L}/u.test(token)) add(token, entry.replacement);
    }
  }
  return result;
}

/** core.xml elements blanked: identities and content-describing text. */
const CORE_BLANKED = new Set([
  'creator', 'lastModifiedBy', 'title', 'subject', 'description', 'keywords', 'category',
  'contentStatus', 'identifier',
]);
/** core.xml timestamps set to NORMALISED_DATE (schema-typed W3CDTF, never blanked). */
const CORE_DATES = new Set(['created', 'modified', 'lastPrinted']);
/** core.xml elements removed outright (optional in the schema, numeric fingerprints). */
const CORE_REMOVED = new Set(['revision', 'version']);
/** app.xml elements blanked: organisation and template/path hints. */
const APP_BLANKED = new Set(['Company', 'Manager', 'HyperlinkBase', 'Template']);
/** app.xml statistics set to '0': they fingerprint the original's length and edit time. */
const APP_ZEROED = new Set([
  'Pages', 'Words', 'Characters', 'CharactersWithSpaces', 'Lines', 'Paragraphs', 'TotalTime',
  'Slides', 'Notes', 'HiddenSlides', 'MMClips',
]);
/** app.xml vectors whose vt:lpstr entries name headings, sheets and defined names. */
const APP_PART_VECTORS = new Set(['TitlesOfParts', 'HeadingPairs']);

/**
 * Scrub the shared docProps parts (T179 extends the list, finding M6):
 * - core.xml: author identities, content-describing fields, content status
 *   and identifier blanked; created/modified/lastPrinted set to
 *   NORMALISED_DATE; revision and version removed
 * - app.xml: organization and template/path hints blanked; page, word,
 *   character, line, paragraph and editing-time statistics set to 0;
 *   TitlesOfParts and HeadingPairs keep their vt:vector size and element
 *   count while every vt:lpstr (heading text, sheet name, defined name) is
 *   blanked
 * - custom.xml: every leaf value (property names/structure kept)
 */
export async function scrubDocPropsParts(zip: JSZip): Promise<void> {
  const core = await readXmlPart(zip, 'docProps/core.xml');
  if (core) {
    blankElementsByLocalName(core, CORE_BLANKED);
    setElementsTextByLocalName(core, CORE_DATES, NORMALISED_DATE);
    removeElementsByLocalName(core, CORE_REMOVED);
    writeXmlPart(zip, 'docProps/core.xml', core);
  }

  const app = await readXmlPart(zip, 'docProps/app.xml');
  if (app) {
    blankElementsByLocalName(app, APP_BLANKED);
    setElementsTextByLocalName(app, APP_ZEROED, '0');
    const all = app.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (APP_PART_VECTORS.has(all[i].localName)) {
        setElementsTextByLocalName(all[i], new Set(['lpstr']), '');
      }
    }
    writeXmlPart(zip, 'docProps/app.xml', app);
  }

  const custom = await readXmlPart(zip, 'docProps/custom.xml');
  if (custom) {
    const props = custom.getElementsByTagName('*');
    for (let i = 0; i < props.length; i++) {
      const el = props[i];
      if (el.localName !== 'property' && el.childElementCount === 0 && (el.textContent ?? '') !== '') {
        el.textContent = '';
      }
    }
    writeXmlPart(zip, 'docProps/custom.xml', custom);
  }
}

/**
 * Remove the package thumbnail (a rendered image of page/sheet one leaks
 * content wholesale) together with its package relationship and content-type
 * override.
 */
export async function removePackageThumbnail(zip: JSZip): Promise<void> {
  const thumbnailPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (/^docProps\/thumbnail\.[a-z]+$/i.test(relativePath)) {
      thumbnailPaths.push(relativePath);
    }
  });
  if (thumbnailPaths.length === 0) return;

  for (const path of thumbnailPaths) zip.remove(path);

  const rootRels = await readXmlPart(zip, '_rels/.rels');
  if (rootRels) {
    const relationships = rootRels.getElementsByTagName('Relationship');
    for (let i = relationships.length - 1; i >= 0; i--) {
      const type = relationships[i].getAttribute('Type') ?? '';
      if (type.endsWith('/thumbnail')) {
        relationships[i].parentNode?.removeChild(relationships[i]);
      }
    }
    writeXmlPart(zip, '_rels/.rels', rootRels);
  }

  const contentTypes = await readXmlPart(zip, '[Content_Types].xml');
  if (contentTypes) {
    const overrides = contentTypes.getElementsByTagName('Override');
    for (let i = overrides.length - 1; i >= 0; i--) {
      const partName = overrides[i].getAttribute('PartName') ?? '';
      if (thumbnailPaths.some((p) => partName === '/' + p)) {
        overrides[i].parentNode?.removeChild(overrides[i]);
      }
    }
    writeXmlPart(zip, '[Content_Types].xml', contentTypes);
  }
}

/** The date every entry of an exported package carries (T179, L1). */
export const ZIP_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1));

/**
 * Normalise the archive container before generation (T179, finding L1):
 * every entry, structural ones and directories included, gets ZIP_ENTRY_DATE
 * and an empty comment, and the archive comment is cleared. JSZip otherwise
 * keeps the original mtime of untouched entries and stamps rewritten ones
 * with "now", which fingerprints both the source file and the parts DocCloak
 * touched; entry and archive comments are copied through verbatim.
 *
 * generateAsync must still receive { comment: '' }; JSZip falls back to the
 * loaded archive comment when the option is empty, which is why the archive
 * comment is cleared on the instance here as well.
 */
export function normalizeZipEntries(zip: JSZip): void {
  for (const entry of Object.values(zip.files)) {
    entry.date = new Date(ZIP_ENTRY_DATE.getTime());
    entry.comment = '';
  }
  (zip as unknown as { comment: string | null }).comment = '';
}

/**
 * What every mailto: relationship target becomes (T174, M1). A mail address
 * in a hyperlink target is personal data by definition, and the detector
 * never sees relationship files, so the rule is unconditional: no known
 * value list is needed for it to fire.
 */
export const MAILTO_REDACTED_TARGET = 'mailto:redacted@example.invalid';

/**
 * Always-scrub rule for external relationship targets: a mailto: target is
 * replaced wholesale (address, query string and all); anything else is
 * returned unchanged so the caller can apply the value-based scrub.
 */
export function scrubMailtoTarget(target: string): string {
  return /^\s*mailto:/i.test(target) ? MAILTO_REDACTED_TARGET : target;
}

/**
 * Scrub external relationship targets in every .rels file matched by the
 * given pattern: mailto: targets are always replaced (T174), and every other
 * external target has the known values removed (https: hyperlinks keep the
 * raw sensitive value even when the display text was redacted).
 */
export async function scrubExternalRelTargets(
  zip: JSZip,
  relsPattern: RegExp,
  valueReplacements: ValueReplacement[]
): Promise<void> {
  const relsPaths: string[] = [];
  zip.forEach((relativePath) => {
    if (relsPattern.test(relativePath)) relsPaths.push(relativePath);
  });
  for (const relsPath of relsPaths.sort()) {
    const rels = await readXmlPart(zip, relsPath);
    if (!rels) continue;
    const relationships = rels.getElementsByTagName('Relationship');
    for (let i = relationships.length - 1; i >= 0; i--) {
      const rel = relationships[i];
      if (rel.getAttribute('TargetMode') === 'External') {
        const target = rel.getAttribute('Target') ?? '';
        const scrubbed = replaceSensitiveValues(scrubMailtoTarget(target), valueReplacements, true);
        if (scrubbed !== target) rel.setAttribute('Target', scrubbed);
      }
    }
    writeXmlPart(zip, relsPath, rels);
  }
}

// ---------------------------------------------------------------------------
// Layer zero: package-wide value scrub (T172, H3/H4)
// ---------------------------------------------------------------------------

/**
 * Attribute local names that carry identifiers or numeric layout and are
 * never rewritten: a placeholder inside one of these corrupts the file.
 */
const NEVER_SCRUB_ATTRS = new Set([
  'id', 'paraid', 'textid', 'durableid', 'embed', 'link', 'pict', 'cx', 'cy', 'x', 'y',
  'l', 't', 'r', 'b', 'w', 'h', 'sz', 'szcs', 'dxaorig', 'dyaorig', 'type', 'partname',
  'extension', 'contenttype', 'requires', 'ignorable',
]);

/**
 * Elements whose every attribute is geometry or positioning (DrawingML and
 * WordprocessingML layout): skipped wholesale.
 */
const LAYOUT_ELEMENTS = new Set([
  'ext', 'off', 'extent', 'effectExtent', 'chOff', 'chExt', 'positionH', 'positionV',
  'posOffset', 'simplePos', 'srcRect', 'tblW', 'tcW', 'tblInd', 'ind', 'spacing',
  'pgSz', 'pgMar', 'gridCol', 'trHeight', 'tblCellMar', 'framePr', 'anchor', 'inline',
  'wrapSquare', 'wrapTight', 'wrapThrough', 'wrapTopAndBottom', 'lnTo', 'pt',
  'cubicBezTo', 'quadBezTo', 'arcTo', 'path', 'gd', 'pos',
]);

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Attribute safety rule from the T172 spec, applied per attribute. */
function isScrubbableAttribute(el: Element, attr: Attr, isRels: boolean): boolean {
  if (attr.namespaceURI === XMLNS_NS || attr.name.startsWith('xmlns')) return false;
  if (attr.namespaceURI === XML_NS) return false;
  if (attr.namespaceURI !== null && OOXML_NS.r.has(attr.namespaceURI)) return false;
  const local = attr.localName.toLowerCase();
  if (NEVER_SCRUB_ATTRS.has(local) || local.startsWith('rsid')) return false;
  if (LAYOUT_ELEMENTS.has(el.localName)) return false;
  if (isRels && el.localName === 'Relationship') {
    // Internal targets are part names; only external ones carry user data.
    return attr.localName === 'Target' && el.getAttribute('TargetMode') === 'External';
  }
  return true;
}

/** Split the value list per the safety rule: lettered values, long numeric values. */
function partitionForAttributes(valueReplacements: ValueReplacement[]): {
  lettered: ValueReplacement[];
  longNumeric: ValueReplacement[];
} {
  const lettered: ValueReplacement[] = [];
  const longNumeric: ValueReplacement[] = [];
  for (const pair of valueReplacements) {
    if (/\p{L}/u.test(pair.value)) lettered.push(pair);
    else if (/^\d{9,}$/.test(pair.value)) longNumeric.push(pair);
  }
  return { lettered, longNumeric };
}

function scrubAttributeValue(
  value: string,
  urlEncode: boolean,
  lettered: ValueReplacement[],
  longNumeric: ValueReplacement[]
): string {
  let result = value;
  if (lettered.length > 0) result = replaceSensitiveValues(result, lettered, urlEncode);
  if (longNumeric.length > 0) result = replaceSensitiveValues(result, longNumeric, urlEncode, { wordBoundary: true });
  return result;
}

const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const ELEMENT_NODE = 1;

/**
 * Scrub every known value inside one parsed XML part: text and CDATA node
 * values get every value; attribute values follow the safety rule (lettered
 * values, or purely numeric values of at least nine digits at word
 * boundaries; never identifiers, relationship ids or layout numbers).
 * Element names and rels Type/Id/internal Target are never touched.
 * Returns true when anything changed.
 */
export function scrubXmlValues(doc: Document, valueReplacements: ValueReplacement[], isRels: boolean): boolean {
  const { lettered, longNumeric } = partitionForAttributes(valueReplacements);
  let changed = false;
  const visit = (node: Node) => {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
      const value = node.nodeValue ?? '';
      if (value.trim().length === 0) return;
      const scrubbed = replaceSensitiveValues(value, valueReplacements, false);
      if (scrubbed !== value) {
        node.nodeValue = scrubbed;
        changed = true;
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    const attrs = el.attributes;
    for (let a = 0; a < attrs.length; a++) {
      const attr = attrs[a];
      if (!isScrubbableAttribute(el, attr, isRels)) continue;
      const urlEncode = isRels || /^(?:https?:|mailto:|file:)/i.test(attr.value);
      // Second layer for the mailto rule (T174): the writers apply it to
      // their own rels first; any rels part they did not visit gets it here.
      const base = isRels ? scrubMailtoTarget(attr.value) : attr.value;
      const scrubbed = scrubAttributeValue(base, urlEncode, lettered, longNumeric);
      if (scrubbed !== attr.value) {
        attr.value = scrubbed;
        changed = true;
      }
    }
    for (let child = el.firstChild; child; child = child.nextSibling) visit(child);
  };
  // The Document node itself is neither an element nor text: start at its children.
  for (let child = doc.firstChild; child; child = child.nextSibling) visit(child);
  return changed;
}

export interface PackageScrubOptions {
  /** Parts to leave alone (content parts already written by the caller). */
  skip?: ReadonlySet<string>;
}

export interface PackageScrubResult {
  /** Parts that were rewritten. */
  touched: string[];
  /** Human-readable notes: parts that could not be parsed and were left as-is. */
  warnings: string[];
}

/** Every XML-like part of the package except the content-types manifest. */
export function isLayerZeroPart(path: string): boolean {
  if (path === '[Content_Types].xml') return false;
  return /\.(?:xml|rels|vml)$/i.test(path);
}

/**
 * Layer zero (plan 3.1): walk every *.xml, *.rels and *.vml part of the zip,
 * including customXml/, word/charts/, word/diagrams/, word/glossary/,
 * docProps/ and xl/pivotCache/, and scrub every known value from text nodes
 * and attribute values. Runs after the content replacements and before the
 * zip is generated, so nothing the content extractors did not understand can
 * carry a known value out of the package. Parts that do not parse are left
 * untouched and listed in warnings; the caller decides how to surface them.
 */
export async function scrubPackageValues(
  zip: JSZip,
  valueReplacements: ValueReplacement[],
  options: PackageScrubOptions = {}
): Promise<PackageScrubResult> {
  const result: PackageScrubResult = { touched: [], warnings: [] };
  const active = valueReplacements.filter((pair) => pair.value.length > 0);
  if (active.length === 0) return result;

  const paths: string[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    if (options.skip?.has(relativePath)) return;
    if (isLayerZeroPart(relativePath)) paths.push(relativePath);
  });
  paths.sort();

  const parser = new DOMParser();
  for (const path of paths) {
    const file = zip.file(path);
    if (!file) continue;
    const xmlStr = await file.async('string');
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      result.warnings.push(`${path}: not well-formed XML, left untouched by the value scrub`);
      continue;
    }
    const isRels = /\.rels$/i.test(path);
    if (scrubXmlValues(doc, active, isRels)) {
      writeXmlPart(zip, path, doc);
      result.touched.push(path);
    }
  }
  return result;
}
