// Shared loader for the real-file corpus (T196).
//
// A seed is a hand-written source document under tests/corpus/seeds/
// (.fodt, .fods or .html) plus a sibling <seed>.json manifest naming the
// exact strings that must not survive redaction. Corpus files are
// discovered in two places:
//
// - tests/corpus/generated/<fmt>/<seed>.<fmt>: produced from the seeds by
//   tests/corpus/generate.mjs (LibreOffice headless; CI only unless
//   LibreOffice is installed locally). Gitignored.
// - tests/corpus/handsaved/<seed>__<source>.<ext>: the same seed content
//   saved by hand from Word 365, Google Docs, Pages or Excel 365. Committed.
//
// Both map back to a manifest by the seed name (the file stem up to the
// first "__").

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CorpusFormat = 'docx' | 'doc' | 'xlsx';

export const CORPUS_FORMATS: readonly CorpusFormat[] = ['docx', 'doc', 'xlsx'];

export interface CorpusManifest {
  /** Seed name, equal to the file stem of the source and the manifest. */
  seed: string;
  /** Source file name (relative to seeds/). */
  source: string;
  /** Main language of the seeded text: pl, en or de. */
  language: string;
  /** Formats the generator produces from this seed. */
  formats: CorpusFormat[];
  /** Exact strings that must not survive in any redacted output. */
  needles: string[];
  /** Placement labels present in the seed (body, header, footnote, chart-title, ...). */
  where: string[];
  /** Placement labels per needle. */
  placements: Record<string, string[]>;
  /**
   * Needles a converter may legitimately drop from the generated input
   * (tracked deletions, HTML comments, chart titles). They are still
   * asserted absent from the output.
   */
  optional: string[];
  /**
   * Refusal expectation: an UnsupportedDocumentError code that the reader
   * must raise for this seed, either for every format (string) or per
   * format (object). Absent for seeds that must redact cleanly.
   */
  expectUnsupported?: string | Partial<Record<CorpusFormat, string>>;
  notes?: string;
}

export type CorpusOrigin = 'generated' | 'handsaved';

export interface CorpusFile {
  /** Absolute path of the input file. */
  path: string;
  /** File name with extension. */
  name: string;
  /** File stem (without extension); unique across the corpus. */
  stem: string;
  ext: CorpusFormat;
  origin: CorpusOrigin;
  /** Seed name derived from the stem (up to the first "__"). */
  seed: string;
  /** The manifest, or null when no seeds/<seed>.json exists. */
  manifest: CorpusManifest | null;
}

export const CORPUS_DIR = dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = join(CORPUS_DIR, 'seeds');
export const GENERATED_DIR = join(CORPUS_DIR, 'generated');
export const HANDSAVED_DIR = join(CORPUS_DIR, 'handsaved');
export const INVENTORY_PATH = join(CORPUS_DIR, 'part-inventory.json');

export function isCorpusFormat(ext: string): ext is CorpusFormat {
  return (CORPUS_FORMATS as readonly string[]).includes(ext);
}

/** Seed name of a corpus file stem: "pl-cv__word365-win" gives "pl-cv". */
export function seedNameOf(stem: string): string {
  const idx = stem.indexOf('__');
  return idx === -1 ? stem : stem.slice(0, idx);
}

/** All manifests, keyed by seed name, in sorted order. */
export function loadManifests(): Map<string, CorpusManifest> {
  const out = new Map<string, CorpusManifest>();
  if (!existsSync(SEEDS_DIR)) return out;
  for (const file of readdirSync(SEEDS_DIR).sort()) {
    if (extname(file) !== '.json') continue;
    const manifest = JSON.parse(readFileSync(join(SEEDS_DIR, file), 'utf8')) as CorpusManifest;
    out.set(basename(file, '.json'), manifest);
  }
  return out;
}

/** Every needle of every manifest, unique, in manifest order. */
export function allNeedles(manifests = loadManifests()): string[] {
  const seen = new Set<string>();
  for (const manifest of manifests.values()) {
    for (const needle of manifest.needles) seen.add(needle);
  }
  return [...seen];
}

/** Needles that must be present in the input (all needles minus optional). */
export function requiredNeedles(manifest: CorpusManifest): string[] {
  const optional = new Set(manifest.optional ?? []);
  return manifest.needles.filter((n) => !optional.has(n));
}

/** The refusal code the manifest expects for this format, if any. */
export function expectedRefusal(manifest: CorpusManifest, ext: CorpusFormat): string | undefined {
  const spec = manifest.expectUnsupported;
  if (!spec) return undefined;
  if (typeof spec === 'string') return spec;
  return spec[ext];
}

function listFiles(dir: string, origin: CorpusOrigin, manifests: Map<string, CorpusManifest>): CorpusFile[] {
  if (!existsSync(dir)) return [];
  const out: CorpusFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    if (name.startsWith('.') || name.startsWith('~$')) continue;
    const ext = extname(name).slice(1).toLowerCase();
    if (!isCorpusFormat(ext)) continue;
    const stem = basename(name, extname(name));
    const seed = seedNameOf(stem);
    out.push({ path, name, stem, ext, origin, seed, manifest: manifests.get(seed) ?? null });
  }
  return out;
}

/**
 * Discover every corpus input: generated/<fmt>/* and handsaved/*. Sorted by
 * origin then name so test order is stable.
 */
export function discoverCorpusFiles(manifests = loadManifests()): CorpusFile[] {
  const files: CorpusFile[] = [];
  for (const fmt of CORPUS_FORMATS) {
    files.push(...listFiles(join(GENERATED_DIR, fmt), 'generated', manifests));
  }
  files.push(...listFiles(HANDSAVED_DIR, 'handsaved', manifests));
  return files;
}

/**
 * Bytes of a corpus file as a standalone ArrayBuffer created in the test
 * realm. Node's Buffer pool lives in another realm under jsdom, and JSZip's
 * instanceof check would reject a slice of it.
 */
export function readCorpusBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

/**
 * Entity type guessed from the needle shape. The corpus suite runs no ML;
 * the type only picks the placeholder label and tells the layer-zero value
 * list which needles are person names (their surname tokens are scrubbed
 * on their own).
 */
export function guessEntityType(needle: string): string {
  if (needle.includes('@')) return 'EMAIL';
  if (/^\d{11}$/.test(needle)) return 'ID';
  if (/^[A-Z]{2}\d{2}[ \dA-Z]+$/.test(needle)) return 'IBAN';
  if (/^\+?[\d\s()./-]{7,}$/.test(needle)) return 'PHONE';
  if (/\d/.test(needle)) return 'ADDRESS';
  return 'PERSON';
}

/** Valid PESEL checksum (weights 1,3,7,9,1,3,7,9,1,3). */
export function isValidPesel(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(value[i]) * w[i];
  return (10 - (sum % 10)) % 10 === Number(value[10]);
}

/** Valid IBAN checksum (ISO 7064 mod 97-10); spaces are ignored. */
export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}
