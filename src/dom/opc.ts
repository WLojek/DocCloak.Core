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
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (names.has(all[i].localName)) all[i].textContent = '';
  }
}

/**
 * Replace every occurrence of each sensitive value (case-insensitive) in a
 * string. A replacer function keeps '$' sequences in values/placeholders inert.
 */
export function replaceSensitiveValues(
  input: string,
  valueReplacements: ValueReplacement[],
  urlEncode: boolean
): string {
  let result = input;
  for (const { value, replacement } of valueReplacements) {
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const substitute = urlEncode ? encodeURIComponent(replacement) : replacement;
    result = result.replace(new RegExp(escaped, 'gi'), () => substitute);
  }
  return result;
}

/**
 * Scrub the shared docProps parts:
 * - core.xml: author identities and content-describing fields
 * - app.xml: organization and template/path hints
 * - custom.xml: every leaf value (property names/structure kept)
 */
export async function scrubDocPropsParts(zip: JSZip): Promise<void> {
  const core = await readXmlPart(zip, 'docProps/core.xml');
  if (core) {
    blankElementsByLocalName(core, new Set([
      'creator', 'lastModifiedBy', 'title', 'subject', 'description', 'keywords', 'category',
    ]));
    writeXmlPart(zip, 'docProps/core.xml', core);
  }

  const app = await readXmlPart(zip, 'docProps/app.xml');
  if (app) {
    blankElementsByLocalName(app, new Set(['Company', 'Manager', 'HyperlinkBase', 'Template']));
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

/**
 * Scrub external relationship targets (mailto:/https: hyperlinks keep the raw
 * sensitive value even when the display text was redacted) in every .rels file
 * matched by the given pattern.
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
        const scrubbed = replaceSensitiveValues(target, valueReplacements, true);
        if (scrubbed !== target) rel.setAttribute('Target', scrubbed);
      }
    }
    writeXmlPart(zip, relsPath, rels);
  }
}
