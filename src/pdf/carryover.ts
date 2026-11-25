/**
 * @doccloak/core/pdf - what a page left out must not leave behind (WLojek/DocCloak.Core#6).
 *
 * The output is built by copying pages, and a copied page brings everything
 * its dictionary reaches. Many files keep ONE resource dictionary for all
 * pages: page 1 then "has" the scan of page 2 and the form that holds the
 * text of page 3, though it draws neither. Left alone, the original of a
 * page exported as a picture (a scan whose values were painted over, a page
 * rasterized with black boxes, a page with an area hidden by hand), or the
 * picture of a removed page, would ship inside the output as an object
 * nothing draws: the values that were painted over, readable in a stream.
 *
 * So, whenever a page is not copied, before the copy:
 * 1. the streams the pages NOT copied reach are collected (pages exported
 *    as a picture, removed pages);
 * 2. from the resources of the copied pages, every entry their content does
 *    not name is taken out when it leads to one of those streams;
 * 3. the fingerprints of those streams that no copied page still reaches
 *    through an entry its content names are handed to the verifier, which
 *    looks for them in the output.
 *
 * A file whose copied pages share nothing with the pages left out is not
 * changed by any of this.
 *
 * When part of a copied page's content could not be walked, which entries
 * it names is not fully known: nothing is taken out (the part not walked
 * may draw it), and the verifier refuses the export if a stream of a page
 * left out comes along through an entry no walked content names.
 */

import type { PageRecord, PdfModel } from './extract.ts';
import { lexContent } from './lexer.ts';
import type { ContentOp } from './lexer.ts';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, decodeStream, getDict, pageResources, resolve } from './objects.ts';
import type { PDFContext, PDFObject } from './objects.ts';

/** Resource categories a content stream reaches by name. */
const CATEGORIES = ['XObject', 'Font', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties'] as const;
type Category = (typeof CATEGORIES)[number];

/** Operators that name a resource, with the category and which operand holds the name. */
const NAMING_OPS: Record<string, { category: Category; operand: 'first' | 'second' | 'last' }> = {
  Do: { category: 'XObject', operand: 'first' },
  Tf: { category: 'Font', operand: 'first' },
  gs: { category: 'ExtGState', operand: 'first' },
  sh: { category: 'Shading', operand: 'first' },
  cs: { category: 'ColorSpace', operand: 'first' },
  CS: { category: 'ColorSpace', operand: 'first' },
  scn: { category: 'Pattern', operand: 'last' },
  SCN: { category: 'Pattern', operand: 'last' },
  BDC: { category: 'Properties', operand: 'second' },
  DP: { category: 'Properties', operand: 'second' },
};

/** Colour spaces a page uses without naming them: they stand in for the device spaces wherever those are used. */
const IMPLICIT_NAMES: ReadonlySet<string> = new Set(['DefaultGray', 'DefaultRGB', 'DefaultCMYK']);

/** Streams shorter than this hold no content worth a fingerprint (an empty content stream is in every file). */
const MIN_FINGERPRINT_BYTES = 16;

/** Length and two independent 32-bit hashes of a stream's bytes as stored: the same stream copied into another file gives the same text. */
export function streamFingerprint(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul((b ^ (b >>> 15)) + bytes[i], 0x2c1b3c6d);
  }
  return `${bytes.length}.${a >>> 0}.${b >>> 0}`;
}

/** The bytes of a stream as stored (still encoded), or null when they cannot be had. */
export function storedBytes(stream: PDFStream): Uint8Array | null {
  if (stream instanceof PDFRawStream) return stream.contents;
  try {
    return stream.getContents();
  } catch {
    return null;
  }
}

/**
 * Walk the objects `roots` reach, the way a page copy would, but never into the page tree or
 * another page (/Parent, a /Type /Page or /Pages dictionary). `visit` sees every stream and may
 * stop the walk by returning true. `skip` leaves entries of a dictionary out (resource entries
 * no content names).
 */
function walk(
  ctx: PDFContext, roots: Array<PDFObject | undefined>, seen: Set<PDFObject>, visit: (stream: PDFStream) => boolean | void,
  skip?: (dict: PDFDict, key: string) => boolean,
): boolean {
  const stack: PDFObject[] = [];
  const pushDict = (dict: PDFDict): void => {
    for (const [k, v] of dict.entries()) {
      const key = k.decodeText();
      if (key !== 'Parent' && !skip?.(dict, key)) stack.push(v);
    }
  };
  for (const root of roots) if (root) stack.push(root);
  while (stack.length > 0) {
    const raw = stack.pop()!;
    const obj = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
    if (!obj || seen.has(obj)) continue;
    seen.add(obj);
    if (obj instanceof PDFStream) {
      if (visit(obj) === true) return true;
      pushDict(obj.dict);
    } else if (obj instanceof PDFDict) {
      const type = obj.get(PDFName.of('Type'));
      const name = type instanceof PDFName ? type.decodeText() : '';
      if (name === 'Page' || name === 'Pages') continue;
      pushDict(obj);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    }
  }
  return false;
}

/** Every stream a page reaches: through its own entries and the resources it inherits (without the entries `skip` leaves out). */
function reachOfPage(ctx: PDFContext, page: PageRecord, into: Set<PDFStream>, skip?: (dict: PDFDict, key: string) => boolean): void {
  const seen = new Set<PDFObject>([page.dict]);
  const roots: Array<PDFObject | undefined> = [pageResources(ctx, page.dict)];
  for (const [k, v] of page.dict.entries()) if (k.decodeText() !== 'Parent') roots.push(v);
  walk(ctx, roots, seen, (s) => { into.add(s); }, skip);
}

/** The resource names a content stream uses, by category; `inlineImage` when it holds one (its colour space may be a resource this lexer does not read). */
function namesUsed(ops: ContentOp[]): { names: Map<Category, Set<string>>; inlineImage: boolean } {
  const names = new Map<Category, Set<string>>();
  let inlineImage = false;
  for (const op of ops) {
    if (op.op === 'BI') { inlineImage = true; continue; }
    const how = NAMING_OPS[op.op];
    if (!how) continue;
    const operand = how.operand === 'first' ? op.operands[0] : how.operand === 'second' ? op.operands[1] : op.operands[op.operands.length - 1];
    if (!operand || operand.kind !== 'name') continue;
    let set = names.get(how.category);
    if (!set) { set = new Set(); names.set(how.category, set); }
    set.add(operand.value);
  }
  return { names, inlineImage };
}

/**
 * Take out of the copied pages' resources what only pages left out use, and return the
 * fingerprints of the streams that must not be in the output: those the pages left out reach and
 * no copied page does. `copied` and `left` are 0-based page indexes. Changes the model in place;
 * call it after every other change to the source and right before the copy.
 */
export function dropForeignResources(model: PdfModel, copied: number[], left: number[]): string[] {
  const { ctx } = model;
  const foreign = new Set<PDFStream>();
  for (const p of left) reachOfPage(ctx, model.pages[p], foreign);
  if (foreign.size === 0) return [];

  // The glyph procedures of a Type3 font without resources of its own draw with the page's: the
  // names they use count for every page (which page shows which glyph is not worked out).
  const byGlyphs = new Map<Category, Set<string>>();
  let glyphInlineImage = false;
  let glyphsRead = true;
  for (const font of model.fonts.values()) {
    if (!font.type3 || getDict(ctx, font.dict, 'Resources')) continue;
    for (const [, v] of getDict(ctx, font.dict, 'CharProcs')?.entries() ?? []) {
      const proc = resolve(ctx, v);
      if (!(proc instanceof PDFStream)) continue;
      let ops: ContentOp[];
      try {
        ops = lexContent(decodeStream(ctx, proc));
      } catch {
        glyphsRead = false;
        continue;
      }
      if (ops.some((op) => op.op === '')) glyphsRead = false;
      const { names, inlineImage } = namesUsed(ops);
      glyphInlineImage ||= inlineImage;
      for (const [category, set] of names) byGlyphs.set(category, new Set([...(byGlyphs.get(category) ?? []), ...set]));
    }
  }
  // Names used, per category dictionary (several resource dictionaries may share one).
  const used = new Map<PDFDict, Set<string> | 'all'>();
  const note = (resources: PDFDict | undefined, category: Category, names: Set<string> | undefined, all: boolean): void => {
    const sub = getDict(ctx, resources, category);
    if (!sub) return;
    const have = used.get(sub);
    if (have === 'all') return;
    if (all) { used.set(sub, 'all'); return; }
    const set = have ?? new Set<string>();
    for (const n of names ?? []) set.add(n);
    used.set(sub, set);
  };
  for (const p of copied) {
    const page = model.pages[p];
    const pageRes = pageResources(ctx, page.dict);
    for (const key of page.streams) {
      const stream = model.streams.get(key);
      if (!stream) continue;
      const { names, inlineImage } = namesUsed(stream.ops);
      // A form without resources of its own takes its names from whatever draws it: the stream
      // it was first met in, and this page.
      const targets = stream.ownResources ? [stream.resources] : [stream.resources, pageRes];
      for (const resources of targets) {
        for (const category of CATEGORIES) {
          note(resources, category, names.get(category), category === 'ColorSpace' && (inlineImage || glyphInlineImage));
          note(resources, category, byGlyphs.get(category), false);
        }
      }
    }
  }
  // A Type3 font's own resources stay whole.
  for (const font of model.fonts.values()) {
    if (!font.type3) continue;
    const resources = getDict(ctx, font.dict, 'Resources');
    for (const category of CATEGORIES) note(resources, category, undefined, true);
  }
  /** An entry of a resource category that no walked content of a copied page names. */
  const unnamed = (dict: PDFDict, key: string): boolean => {
    const names = used.get(dict);
    return names !== undefined && names !== 'all' && !names.has(key) && !IMPLICIT_NAMES.has(key);
  };

  // Only when every copied page was walked to the end is an unnamed entry known to be unused.
  const walked = glyphsRead && copied.every((p) => !model.pages[p].partialWalk);
  if (walked) {
    for (const [sub, names] of used) {
      if (names === 'all') continue;
      for (const [k, v] of sub.entries()) {
        if (!unnamed(sub, k.decodeText())) continue;
        if (walk(ctx, [v], new Set(), (s) => foreign.has(s))) sub.delete(k);
      }
    }
  }

  // What the copied pages hold as their own: what they reach through entries their content names.
  // An unnamed entry that could not be taken out (content not walked to the end) does not make a
  // stream theirs: if it leads to a stream of a page left out, the verifier finds that stream.
  const own = new Set<PDFStream>();
  for (const p of copied) reachOfPage(ctx, model.pages[p], own, unnamed);
  const keys = new Set<string>();
  const lengths = new Set<number>();
  for (const s of foreign) {
    if (own.has(s)) continue;
    const bytes = storedBytes(s);
    if (!bytes || bytes.length < MIN_FINGERPRINT_BYTES) continue;
    keys.add(streamFingerprint(bytes));
    lengths.add(bytes.length);
  }
  // The same bytes in a stream a copied page holds (a logo embedded once per page) are that page's.
  for (const s of own) {
    if (keys.size === 0) break;
    const bytes = storedBytes(s);
    if (bytes && lengths.has(bytes.length)) keys.delete(streamFingerprint(bytes));
  }
  return [...keys];
}
