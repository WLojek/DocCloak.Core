// @vitest-environment jsdom
//
// Real-file corpus (T196): every docx / doc / xlsx / pdf under
// tests/corpus/generated (LibreOffice output of the seeds) and
// tests/corpus/handsaved (files saved by hand from Word 365, Google Docs,
// Pages, Excel 365) is redacted through the public writers and must come out
// with zero traces of the seeded PII. PDFs (T218) go through the text-layer
// writer of @doccloak/core/pdf with the raster fallback enabled; the
// office-open job then runs poppler's pdftotext over the outputs.
//
// The suite runs no ML. The manifest needles ARE the entity list: every exact
// occurrence in the extracted plain text becomes an entity with a placeholder
// replacement, and every manifest needle (found in the text or not) goes into
// the layer-zero value list, so a value that only lives in a sheet name, a
// chart cache or document properties is still scrubbed.
//
// Per file:
// 1. the required seed needles are present in the input (plain text or raw
//    bytes), so the seed really tests what it claims;
// 2. redaction succeeds (or the reader refuses with the code the manifest
//    expects under `expectUnsupported`);
// 3. assertNoTrace(output, needles): nothing survives in any part or encoding;
// 4. the output parses again and carries the placeholders;
// 5. extraction is deterministic (two reads of the input agree);
// 6. the number of placeholders written covers the occurrences found;
// 7. the output is written for the office-open CI job, which converts it to
//    PDF and to txt/csv (LibreOffice) or to txt (poppler pdftotext for PDF)
//    and greps the needles once more with an extractor we did not write.
//
// Without corpus files (no LibreOffice locally, nothing hand-saved yet) the
// suite records one skipped test whose name says why.

import { describe, it, expect, beforeAll } from 'vitest';
import { readDocx, writeAnonymizedDocxWithReport } from '../src/dom/docx.ts';
import type { DocxExtraction } from '../src/dom/docx.ts';
import { readXlsx, writeAnonymizedXlsxWithReport } from '../src/dom/xlsx.ts';
import type { XlsxExtraction } from '../src/dom/xlsx.ts';
import { layerZeroValueReplacements } from '../src/dom/opc.ts';
import { isUnsupportedDocumentError } from '../src/dom/errors.ts';
import type { UnredactablePart } from '../src/dom/errors.ts';
import { inspectDoc, readDocText, writeAnonymizedDoc } from '../src/doc.ts';
import { readPdf, writeAnonymizedPdfWithReport } from '../src/pdf/index.ts';
import type { PdfAssetPaths, PdfExtraction } from '../src/pdf/index.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoTrace, findTraces, toBytes, writeOutput } from './helpers/package-scan.ts';
import { nodeCanvasFactory } from './helpers/pdf-canvas.ts';
import {
  discoverCorpusFiles,
  expectedRefusal,
  guessEntityType,
  readCorpusBytes,
  requiredNeedles,
} from './corpus/manifest.ts';
import type { CorpusFile, CorpusFormat, CorpusManifest } from './corpus/manifest.ts';

// Fallback fonts for the PDF writer. import.meta.url is not a file: URL under
// jsdom; vitest injects __dirname instead (same as tests/office-redact.test.ts).
const PDF_FONTS = join(__dirname, '..', 'fonts', 'liberation');
const PDF_ASSETS: PdfAssetPaths = { loadFont: async (file) => new Uint8Array(readFileSync(join(PDF_FONTS, file))) };

/** Reading a multi-page LibreOffice PDF twice through pdf.js takes seconds, not the default 5 s. */
const PDF_TIMEOUT = 120_000;

/** Whitespace-insensitive containment, for a PDF whose line wrap turned a space in a needle into a newline. */
function containsIgnoringWhitespace(text: string, needle: string): boolean {
  const fold = (s: string) => s.replace(/\s+/g, ' ');
  return fold(text).includes(fold(needle));
}

interface Occurrence {
  start: number;
  end: number;
  value: string;
  replacement: string;
}

interface NeedlePlan {
  /** Placeholder per needle, in manifest order. */
  placeholders: Map<string, string>;
  /** Non-overlapping occurrences in the plain text, sorted by start. */
  occurrences: Occurrence[];
  /** Value list for the layer-zero scrub: every manifest needle. */
  valueReplacements: Array<{ value: string; replacement: string }>;
}

/**
 * Exact needle matching against the plain text. Longer needles win: an
 * occurrence that overlaps one already taken is dropped, so a surname that
 * is also part of a full name is not matched twice.
 */
function planNeedles(plainText: string, manifest: CorpusManifest): NeedlePlan {
  const placeholders = new Map<string, string>();
  const counters = new Map<string, number>();
  for (const needle of manifest.needles) {
    const type = guessEntityType(needle);
    const n = (counters.get(type) ?? 0) + 1;
    counters.set(type, n);
    placeholders.set(needle, `[${type}_${n}]`);
  }

  const taken: Array<[number, number]> = [];
  const occurrences: Occurrence[] = [];
  const byLength = [...manifest.needles].sort((a, b) => b.length - a.length);
  for (const needle of byLength) {
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = plainText.indexOf(needle, from);
      if (idx === -1) break;
      const end = idx + needle.length;
      const overlaps = taken.some(([s, e]) => idx < e && end > s);
      if (!overlaps) {
        taken.push([idx, end]);
        occurrences.push({ start: idx, end, value: needle, replacement: placeholders.get(needle)! });
      }
      from = idx + 1;
    }
  }
  occurrences.sort((a, b) => a.start - b.start);

  const valueReplacements = layerZeroValueReplacements(
    manifest.needles.map((needle) => ({
      original: needle,
      replacement: placeholders.get(needle)!,
      entityType: guessEntityType(needle),
    })),
  );
  return { placeholders, occurrences, valueReplacements };
}

function countPlaceholders(text: string, placeholders: Iterable<string>): number {
  let count = 0;
  for (const placeholder of placeholders) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(placeholder, from);
      if (idx === -1) break;
      count++;
      from = idx + placeholder.length;
    }
  }
  return count;
}

function toFile(bytes: ArrayBuffer, name: string): File {
  const file = new File([bytes], name);
  // jsdom's File lacks arrayBuffer(); polyfill it for the code under test
  // (same as tests/docx.test.ts).
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice(0) });
  }
  return file;
}

interface Snapshot {
  plainText: string;
  /** Docx paragraph break indices, PDF page start offsets; empty for the other formats. */
  breaks: number[];
}

interface RedactionRun {
  input: Snapshot;
  plan: NeedlePlan;
  output: Uint8Array;
  outputText: string;
  writerWarnings: string[];
  /** Parts copied verbatim under allowUnredactable (T177); each must be named in writerWarnings. */
  unredactable: UnredactablePart[];
  /**
   * Predicate for parts whose surviving needles are not a failure: the
   * unredactable parts above (docx, xlsx) or, for .doc, the ObjectPool and
   * Macros storages that inspectDoc reports and the host shows to the user.
   */
  consented: (part: string) => boolean;
  /** Occurrences inside tracked deletions: dropped by acceptTrackedChanges, so no placeholder is written for them. */
  deletedOccurrences: number;
  /** PDF only: occurrences on pages the writer rasterized (blacked out in pixels; no placeholder text is written). */
  rasterizedOccurrences: number;
  /** PDF only: 0-based pages the writer rasterized. */
  rasterizedPages: number[];
}

function consentedParts(unredactable: UnredactablePart[]): (part: string) => boolean {
  const parts = unredactable.map((u) => u.part);
  return (part) => parts.some((p) => part === p || part.startsWith(`${p}!`));
}

function insideTrackedDeletion(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.localName === 'del' || cur.localName === 'moveFrom') return true;
    cur = cur.parentElement;
  }
  return false;
}

function countDeletedOccurrences(extraction: DocxExtraction, occurrences: Array<{ start: number }>): number {
  let count = 0;
  for (const occ of occurrences) {
    const node = extraction.textNodes.find((t) => t.flatStart <= occ.start && occ.start < t.flatEnd);
    if (node && insideTrackedDeletion(node.element)) count++;
  }
  return count;
}

async function snapshot(ext: CorpusFormat, bytes: ArrayBuffer, name: string): Promise<Snapshot> {
  if (ext === 'docx') {
    const extraction = await readDocx(toFile(bytes, name));
    return { plainText: extraction.plainText, breaks: extraction.paragraphBreaks.map((b) => b.flatIndex) };
  }
  if (ext === 'xlsx') {
    const extraction = await readXlsx(toFile(bytes, name));
    return { plainText: extraction.plainText, breaks: [] };
  }
  if (ext === 'pdf') {
    const extraction = await readPdf(new Uint8Array(bytes), { assets: PDF_ASSETS });
    return { plainText: extraction.plainText, breaks: extraction.pages.map((p) => p.textStart) };
  }
  return { plainText: readDocText(bytes.slice(0)), breaks: [] };
}

const NO_RASTER = { rasterizedOccurrences: 0, rasterizedPages: [] as number[] };

async function redact(file: CorpusFile, manifest: CorpusManifest, bytes: ArrayBuffer): Promise<RedactionRun> {
  if (file.ext === 'docx') {
    const extraction: DocxExtraction = await readDocx(toFile(bytes, file.name));
    const plan = planNeedles(extraction.plainText, manifest);
    const input = { plainText: extraction.plainText, breaks: extraction.paragraphBreaks.map((b) => b.flatIndex) };
    const deletedOccurrences = countDeletedOccurrences(extraction, plan.occurrences);
    const result = await writeAnonymizedDocxWithReport(
      extraction,
      plan.occurrences.map(({ start, end, replacement }) => ({ start, end, replacement })),
      plan.valueReplacements,
      { acceptTrackedChanges: true, allowUnredactable: true },
    );
    const output = await toBytes(result.blob);
    const reread = await readDocx(toFile(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer, file.name));
    return { input, plan, output, outputText: reread.plainText, writerWarnings: result.warnings, unredactable: extraction.unredactable, consented: consentedParts(extraction.unredactable), deletedOccurrences, ...NO_RASTER };
  }
  if (file.ext === 'xlsx') {
    const extraction: XlsxExtraction = await readXlsx(toFile(bytes, file.name));
    const plan = planNeedles(extraction.plainText, manifest);
    const input = { plainText: extraction.plainText, breaks: [] };
    const result = await writeAnonymizedXlsxWithReport(
      extraction,
      plan.occurrences.map(({ start, end, replacement }) => ({ start, end, replacement })),
      plan.valueReplacements,
      { allowUnredactable: true },
    );
    const output = await toBytes(result.blob);
    const reread = await readXlsx(toFile(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer, file.name));
    return { input, plan, output, outputText: reread.plainText, writerWarnings: result.warnings, unredactable: extraction.unredactable, consented: consentedParts(extraction.unredactable), deletedOccurrences: 0, ...NO_RASTER };
  }
  if (file.ext === 'pdf') {
    // Text-layer redaction (T213/T215): every occurrence becomes a placeholder
    // written as real text; the value list is layer zero (every other
    // occurrence in the text). allowUnredactable lets a page that is an image
    // through with a warning, and the Node canvas factory backs the raster
    // fallback for pages the surgery cannot edit safely.
    const extraction: PdfExtraction = await readPdf(new Uint8Array(bytes), { assets: PDF_ASSETS });
    const plan = planNeedles(extraction.plainText, manifest);
    const input = { plainText: extraction.plainText, breaks: extraction.pages.map((p) => p.textStart) };
    const result = await writeAnonymizedPdfWithReport(
      extraction,
      plan.occurrences.map(({ start, end, replacement }) => ({ start, end, replacement })),
      plan.valueReplacements,
      { assets: PDF_ASSETS, allowUnredactable: true, canvasFactory: await nodeCanvasFactory() },
    );
    const output = await toBytes(result.blob);
    const reread = await readPdf(output, { assets: PDF_ASSETS });
    const rasterized = new Set(result.rasterizedPages);
    const onRasterizedPage = (start: number) =>
      extraction.pages.some((p) => rasterized.has(p.index) && p.textStart <= start && start < p.textEnd);
    const rasterizedOccurrences = plan.occurrences.filter((o) => onRasterizedPage(o.start)).length;
    // The scanner reports PDF parts by object number, not by page, so no part
    // is consented: a needle surviving anywhere in the output is a failure.
    return {
      input,
      plan,
      output,
      outputText: reread.plainText,
      writerWarnings: result.warnings,
      unredactable: extraction.unredactable,
      consented: () => false,
      deletedOccurrences: 0,
      rasterizedOccurrences,
      rasterizedPages: result.rasterizedPages,
    };
  }
  const plainText = readDocText(bytes.slice(0));
  const plan = planNeedles(plainText, manifest);
  const blob = await writeAnonymizedDoc(
    bytes.slice(0),
    plan.occurrences.map(({ start, end, replacement }) => ({ start, end, replacement })),
  );
  const output = await toBytes(blob);
  const outputText = readDocText(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  // The legacy writer cannot rewrite OLE storages or macros; inspectDoc reports
  // them and the host asks the user (T177). Their bytes are copied verbatim.
  const inspection = inspectDoc(new Uint8Array(bytes));
  const consentedStorages: RegExp[] = [];
  if (inspection.streams.objectPool) consentedStorages.push(/\/ObjectPool\//);
  if (inspection.streams.macros) consentedStorages.push(/\/Macros\//);
  const consented = (part: string) => consentedStorages.some((re) => re.test(part));
  return { input: { plainText, breaks: [] }, plan, output, outputText, writerWarnings: [], unredactable: [], consented, deletedOccurrences: 0, ...NO_RASTER };
}

/** Writer warnings that are not about an unredactable part but are legitimate for the format. */
function isExpectedWarning(ext: CorpusFormat, warning: string): boolean {
  if (ext !== 'pdf') return false;
  // The raster fallback and a placeholder character outside the fallback
  // font's coverage are reported, not refused (T213); the pdftotext check in
  // CI still proves nothing readable survived.
  return /^page \d+: rasterized /.test(warning) || /^placeholder ".*" has characters the fallback font cannot show/.test(warning);
}

/** Does a writer warning name this unredactable part? docx/xlsx: "<part>: ...", pdf: "<label> (exported as is)". */
function warnsAbout(ext: CorpusFormat, warning: string, part: UnredactablePart): boolean {
  return ext === 'pdf' ? warning.startsWith(part.label) : warning.startsWith(`${part.part}:`);
}

const corpus = discoverCorpusFiles();

describe('real-file corpus', () => {
  if (corpus.length === 0) {
    it.skip('no corpus files: run `node tests/corpus/generate.mjs` with LibreOffice installed, or add files under tests/corpus/handsaved/', () => {});
    return;
  }

  for (const file of corpus) {
    describe(`${file.origin}/${file.name}`, () => {
      const manifest = file.manifest;
      if (!manifest) {
        it('has a manifest', () => {
          throw new Error(
            `${file.path}: no manifest tests/corpus/seeds/${file.seed}.json. ` +
            'Hand-saved files must be named <seed>__<source>.<ext> where <seed> is an existing seed.',
          );
        });
        return;
      }

      const expectedCode = expectedRefusal(manifest, file.ext);
      let bytes: ArrayBuffer;
      let run: RedactionRun | null = null;
      let refusalCode: string | null = null;
      let refusalMessage = '';

      beforeAll(async () => {
        bytes = readCorpusBytes(file.path);
        try {
          run = await redact(file, manifest, bytes);
        } catch (err) {
          if (!isUnsupportedDocumentError(err)) throw err;
          refusalCode = err.code;
          refusalMessage = err.message;
        }
      }, PDF_TIMEOUT);

      it('carries the required seed needles in the input', async () => {
        // Runs are split by Word into several w:r elements sometimes, so a
        // raw-byte miss is not conclusive; the extracted text is checked too.
        // For PDF the raw scan only sees Info strings and simple-font text
        // (subset Type0 fonts store glyph ids), so the text layer decides;
        // a needle wrapped over two lines still counts as present.
        const required = requiredNeedles(manifest, file.ext);
        const raw = await findTraces(new Uint8Array(bytes), required);
        const inRaw = new Set(raw.map((t) => t.needle));
        let text = '';
        if (!refusalCode) {
          text = run!.input.plainText;
        }
        const inText = (n: string) => text.includes(n) || (file.ext === 'pdf' && containsIgnoringWhitespace(text, n));
        const missing = required.filter((n) => !inRaw.has(n) && !inText(n));
        expect(
          missing,
          `seed needles missing from ${file.name} (placements: ${missing.map((n) => `${JSON.stringify(n)} in ${(manifest.placements[n] ?? []).join('/')}`).join('; ')}). ` +
          'If the converter legitimately drops this placement, list the needle under "optional" (or "optionalFor" per format) in the manifest.',
        ).toEqual([]);
      }, PDF_TIMEOUT);

      it(expectedCode ? `is refused with code ${expectedCode}` : 'is redacted without a refusal', () => {
        if (expectedCode) {
          expect(refusalCode, `expected UnsupportedDocumentError(${expectedCode}) but the file was redacted`).toBe(expectedCode);
          return;
        }
        expect(refusalCode, `UnsupportedDocumentError(${refusalCode}): ${refusalMessage}`).toBeNull();
      });

      it('leaves no trace of any needle in the output package outside consented parts', async (ctx) => {
        if (!run) return ctx.skip();
        await assertNoTrace(run.output, manifest.needles, { exclude: run.consented });
      });

      it('re-parses with the placeholders and without the needles', (ctx) => {
        if (!run) return ctx.skip();
        for (const needle of manifest.needles) {
          expect(run.outputText, `needle ${JSON.stringify(needle)} in re-extracted output text`).not.toContain(needle);
        }
        // The legacy .doc writer overwrites text outside the main story
        // (frames, text boxes, headers, footnotes) in place, without a
        // placeholder, so a .doc whose PII sits only in frames re-parses
        // clean but placeholder-free; the no-needle check above is the test.
        // A rasterized PDF page carries no text either (the box is in the pixels).
        if (run.plan.occurrences.length > run.deletedOccurrences + run.rasterizedOccurrences && file.ext !== 'doc') {
          expect(countPlaceholders(run.outputText, run.plan.placeholders.values())).toBeGreaterThan(0);
        }
      });

      it('extracts deterministically', async (ctx) => {
        if (!run) return ctx.skip();
        const again = await snapshot(file.ext, bytes, file.name);
        expect(again.plainText).toBe(run.input.plainText);
        expect(again.breaks).toEqual(run.input.breaks);
      }, PDF_TIMEOUT);

      it('writes at least as many placeholders as needle occurrences', (ctx) => {
        if (!run) return ctx.skip();
        const occurrences = run.plan.occurrences.length;
        expect(occurrences, `no needle occurrence found in the extracted text of ${file.name}; the reader does not see the seeded text`).toBeGreaterThan(0);
        const written = countPlaceholders(run.outputText, run.plan.placeholders.values());
        if (file.ext === 'doc') {
          // The legacy writer substitutes placeholders in the main text and
          // overwrites other stories (frames, footnotes, headers, comments)
          // in place, so the count can be anything down to zero; what must
          // hold is that no occurrence survives in the re-extracted text.
          for (const needle of manifest.needles) expect(run.outputText).not.toContain(needle);
        } else {
          // Occurrences inside tracked deletions are dropped with the
          // deletion (acceptTrackedChanges), not replaced; occurrences on a
          // rasterized PDF page are blacked out in the pixels instead.
          const expected = occurrences - run.deletedOccurrences - run.rasterizedOccurrences;
          expect(written, `placeholders written (${written}) < occurrences replaced (${occurrences}) minus deleted (${run.deletedOccurrences}) minus rasterized (${run.rasterizedOccurrences})`).toBeGreaterThanOrEqual(expected);
        }
      });

      it('names every unredactable part copied verbatim in the writer warnings, and warns about nothing else', (ctx) => {
        if (!run) return ctx.skip();
        for (const part of run.unredactable) {
          expect(
            run.writerWarnings.some((w) => warnsAbout(file.ext, w, part)),
            `${part.part} (${part.label}) was copied verbatim but is missing from the warnings`,
          ).toBe(true);
        }
        const other = run.writerWarnings.filter(
          (w) => !run!.unredactable.some((part) => warnsAbout(file.ext, w, part)) && !isExpectedWarning(file.ext, w),
        );
        expect(other).toEqual([]);
        // A rasterized page must be announced, so the host can tell the user
        // that its text layer is gone.
        for (const page of run.rasterizedPages) {
          expect(run.writerWarnings.some((w) => w.startsWith(`page ${page + 1}: rasterized`)), `page ${page + 1} was rasterized silently`).toBe(true);
        }
      });

      it('writes the redacted output for the office-open job', async (ctx) => {
        if (!run) return ctx.skip();
        await writeOutput(`${file.stem}-redacted.${file.ext}`, run.output);
      });
    });
  }
});
