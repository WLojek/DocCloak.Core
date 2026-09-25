/**
 * @doccloak/core/pdf - typed helpers over the pdf-lib object model (T206).
 *
 * pdf-lib (@cantoo/pdf-lib) parses the file into PDFContext objects; these
 * helpers resolve indirect references and coerce values so the rest of the
 * module never touches raw PDFObject subclasses in ad-hoc ways. All getters
 * return undefined for missing or wrong-typed values instead of throwing:
 * callers decide whether a missing value is an "unsafe page" or a default.
 */

import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

export type { PDFContext, PDFObject };
export { PDFName, PDFNumber, PDFString, PDFHexString, PDFRawStream, PDFBool, PDFArray, PDFDict, PDFRef, PDFStream };

/** Follow indirect references (bounded, refs can be chained). */
export function resolve(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  let cur = obj;
  for (let i = 0; i < 32 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur);
  return cur instanceof PDFRef ? undefined : cur;
}

export function getDict(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFDict | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function getStream(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFStream | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  return v instanceof PDFStream ? v : undefined;
}

export function getArray(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFArray | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  return v instanceof PDFArray ? v : undefined;
}

export function getName(ctx: PDFContext, dict: PDFDict | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function getNumber(ctx: PDFContext, dict: PDFDict | undefined, key: string): number | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getBool(ctx: PDFContext, dict: PDFDict | undefined, key: string): boolean | undefined {
  if (!dict) return undefined;
  const v = resolve(ctx, dict.get(PDFName.of(key)));
  return v instanceof PDFBool ? v.asBoolean() : undefined;
}

/** Raw bytes of a string object (literal or hex), without text decoding. */
export function stringBytes(obj: PDFObject | undefined): Uint8Array | undefined {
  if (obj instanceof PDFHexString) return obj.asBytes();
  if (obj instanceof PDFString) return obj.asBytes();
  return undefined;
}

/** Decoded text of a string object (PDFDocEncoding / UTF-16 BOM aware). */
export function stringText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFHexString || obj instanceof PDFString) {
    try { return obj.decodeText(); } catch { return undefined; }
  }
  return undefined;
}

export function getString(ctx: PDFContext, dict: PDFDict | undefined, key: string): string | undefined {
  if (!dict) return undefined;
  return stringText(resolve(ctx, dict.get(PDFName.of(key))));
}

/** Numbers of an array (non-numbers skipped). */
export function numbersOf(ctx: PDFContext, arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = resolve(ctx, arr.get(i));
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

/** Elements of an array, references resolved. */
export function itemsOf(ctx: PDFContext, arr: PDFArray | undefined): PDFObject[] {
  if (!arr) return [];
  const out: PDFObject[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = resolve(ctx, arr.get(i));
    if (v) out.push(v);
  }
  return out;
}

/** Names of a name-or-array-of-names value (e.g. /Filter). */
export function namesOf(ctx: PDFContext, obj: PDFObject | undefined): string[] {
  const v = resolve(ctx, obj);
  if (v instanceof PDFName) return [v.decodeText()];
  if (v instanceof PDFArray) {
    return itemsOf(ctx, v).filter((x): x is PDFName => x instanceof PDFName).map((n) => n.decodeText());
  }
  return [];
}

/** Filters that decodePDFRawStream understands (image codecs are left encoded). */
const DECODABLE_FILTERS = new Set(['FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'RunLengthDecode', 'RL']);

export class StreamDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamDecodeError';
  }
}

/**
 * Fully decoded bytes of a stream. Throws StreamDecodeError when a filter is
 * not decodable (JPX, DCT, CCITT, JBIG2, Crypt) or the data is corrupt, so
 * the caller can treat the page as unsafe instead of reading garbage.
 */
export function decodeStream(ctx: PDFContext, stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    const filters = namesOf(ctx, stream.dict.get(PDFName.of('Filter')));
    for (const f of filters) {
      if (!DECODABLE_FILTERS.has(f)) throw new StreamDecodeError(`undecodable filter /${f}`);
    }
    try {
      return decodePDFRawStream(stream).decode();
    } catch (err) {
      throw new StreamDecodeError(`stream decode failed: ${(err as Error).message}`);
    }
  }
  // pdf-lib's own stream classes (created streams): getContents is the decoded form
  // for PDFContentStream; for PDFFlateStream it is the encoded form, so avoid them.
  const maybe = stream as unknown as { getUnencodedContents?: () => Uint8Array; getContents?: () => Uint8Array };
  if (typeof maybe.getUnencodedContents === 'function') return maybe.getUnencodedContents();
  if (typeof maybe.getContents === 'function') return maybe.getContents();
  throw new StreamDecodeError('unknown stream class');
}

/** True when the filter list contains an image codec (the stream holds pixels, not operators). */
export function isImageEncoded(ctx: PDFContext, stream: PDFStream): boolean {
  const filters = namesOf(ctx, stream.dict.get(PDFName.of('Filter')));
  return filters.some((f) => !DECODABLE_FILTERS.has(f));
}

/** Stable key for an object: 'r<num>g<gen>' for refs, or a synthetic key. */
export function refKey(ref: PDFRef): string {
  return `r${ref.objectNumber}g${ref.generationNumber}`;
}

/** Find the ref of an object stored directly in a dict entry (undefined for direct objects). */
export function refOf(dict: PDFDict, key: string): PDFRef | undefined {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFRef ? v : undefined;
}

/** Iterate (key, value) pairs of a dict with references resolved. */
export function entriesOf(ctx: PDFContext, dict: PDFDict): Array<[string, PDFObject]> {
  const out: Array<[string, PDFObject]> = [];
  for (const [k, v] of dict.entries()) {
    const r = resolve(ctx, v);
    if (r) out.push([k.decodeText(), r]);
  }
  return out;
}

/** The content streams of a page: /Contents may be a stream or an array of streams. */
export function pageContentStreams(ctx: PDFContext, pageDict: PDFDict): Array<{ ref: PDFRef | undefined; stream: PDFStream }> {
  const raw = pageDict.get(PDFName.of('Contents'));
  const resolved = resolve(ctx, raw);
  if (resolved instanceof PDFStream) return [{ ref: raw instanceof PDFRef ? raw : undefined, stream: resolved }];
  if (resolved instanceof PDFArray) {
    const out: Array<{ ref: PDFRef | undefined; stream: PDFStream }> = [];
    for (let i = 0; i < resolved.size(); i++) {
      const item = resolved.get(i);
      const s = resolve(ctx, item);
      if (s instanceof PDFStream) out.push({ ref: item instanceof PDFRef ? item : undefined, stream: s });
    }
    return out;
  }
  return [];
}

/** Resources dict of a page, walking up the /Parent chain when inherited. */
export function pageResources(ctx: PDFContext, pageDict: PDFDict): PDFDict | undefined {
  let node: PDFDict | undefined = pageDict;
  for (let depth = 0; node && depth < 64; depth++) {
    const res = getDict(ctx, node, 'Resources');
    if (res) return res;
    node = getDict(ctx, node, 'Parent');
  }
  return undefined;
}

/** Inherited page attribute (MediaBox, CropBox, Rotate). */
export function inheritedPageValue(ctx: PDFContext, pageDict: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = pageDict;
  for (let depth = 0; node && depth < 64; depth++) {
    const v = resolve(ctx, node.get(PDFName.of(key)));
    if (v) return v;
    node = getDict(ctx, node, 'Parent');
  }
  return undefined;
}
