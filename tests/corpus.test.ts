// @vitest-environment jsdom
//
// Real-file corpus (T196): every docx / doc / xlsx under tests/corpus/generated
// (LibreOffice output of the seeds) and tests/corpus/handsaved (files saved
// by hand from Word 365, Google Docs, Pages, Excel 365) is redacted through
// the public writers and must come out with zero traces of the seeded PII.
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
//    PDF and to txt/csv and greps the needles once more with LibreOffice as
//    an extractor we did not write.
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
import { assertNoTrace, findTraces, toBytes, writeOutput } from './helpers/package-scan.ts';
import {
  discoverCorpusFiles,
  expectedRefusal,
  guessEntityType,
  readCorpusBytes,
  requiredNeedles,
} from './corpus/manifest.ts';
import type { CorpusFile, CorpusFormat, CorpusManifest } from './corpus/manifest.ts';

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
  /** Docx paragraph break indices; empty for the other formats. */
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
  return { plainText: readDocText(bytes.slice(0)), breaks: [] };
}

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
    return { input, plan, output, outputText: reread.plainText, writerWarnings: result.warnings, unredactable: extraction.unredactable, consented: consentedParts(extraction.unredactable), deletedOccurrences };
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
    return { input, plan, output, outputText: reread.plainText, writerWarnings: result.warnings, unredactable: extraction.unredactable, consented: consentedParts(extraction.unredactable), deletedOccurrences: 0 };
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
  return { input: { plainText, breaks: [] }, plan, output, outputText, writerWarnings: [], unredactable: [], consented, deletedOccurrences: 0 };
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
      });

      it('carries the required seed needles in the input', async () => {
        // Runs are split by Word into several w:r elements sometimes, so a
        // raw-byte miss is not conclusive; the extracted text is checked too.
        const raw = await findTraces(new Uint8Array(bytes), requiredNeedles(manifest));
        const inRaw = new Set(raw.map((t) => t.needle));
        let text = '';
        if (!refusalCode) {
          text = run!.input.plainText;
        }
        const missing = requiredNeedles(manifest).filter((n) => !inRaw.has(n) && !text.includes(n));
        expect(
          missing,
          `seed needles missing from ${file.name} (placements: ${missing.map((n) => `${JSON.stringify(n)} in ${(manifest.placements[n] ?? []).join('/')}`).join('; ')}). ` +
          'If the converter legitimately drops this placement, list the needle under "optional" in the manifest.',
        ).toEqual([]);
      });

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
        if (run.plan.occurrences.length > run.deletedOccurrences && file.ext !== 'doc') {
          expect(countPlaceholders(run.outputText, run.plan.placeholders.values())).toBeGreaterThan(0);
        }
      });

      it('extracts deterministically', async (ctx) => {
        if (!run) return ctx.skip();
        const again = await snapshot(file.ext, bytes, file.name);
        expect(again.plainText).toBe(run.input.plainText);
        expect(again.breaks).toEqual(run.input.breaks);
      });

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
          // deletion (acceptTrackedChanges), not replaced.
          const expected = occurrences - run.deletedOccurrences;
          expect(written, `placeholders written (${written}) < occurrences replaced (${occurrences}) minus deleted (${run.deletedOccurrences})`).toBeGreaterThanOrEqual(expected);
        }
      });

      it('names every unredactable part copied verbatim in the writer warnings, and warns about nothing else', (ctx) => {
        if (!run) return ctx.skip();
        for (const part of run.unredactable) {
          expect(
            run.writerWarnings.some((w) => w.startsWith(`${part.part}:`)),
            `${part.part} (${part.label}) was copied verbatim but is missing from the warnings`,
          ).toBe(true);
        }
        const other = run.writerWarnings.filter((w) => !run!.unredactable.some((part) => w.startsWith(`${part.part}:`)));
        expect(other).toEqual([]);
      });

      it('writes the redacted output for the office-open job', async (ctx) => {
        if (!run) return ctx.skip();
        await writeOutput(`${file.stem}-redacted.${file.ext}`, run.output);
      });
    });
  }
});
