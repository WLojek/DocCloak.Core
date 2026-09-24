// Shared test helper: prove that an exported package holds no trace of the
// original text in ANY part and ANY encoding (SECURITY_REPORT-2026-09 L6).
//
// - ZIP containers (docx/xlsx): every entry is decoded as UTF-8 text and also
//   scanned as raw bytes in latin1 and UTF-16LE. Entries that are themselves
//   ZIP or CFB containers (embeddings/*.xlsx, oleObject*.bin) are scanned
//   recursively. The raw archive bytes are scanned too, which covers entry
//   names, entry comments and the archive comment.
// - CFB containers (.doc): every stream is scanned in all three encodings,
//   plus the raw container bytes.
// - Anything else: the raw bytes only.
//
// The helper never calls the redactor. It only looks at bytes.

import JSZip from 'jszip';
import CFB from 'cfb';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export type PackageInput = Blob | ArrayBuffer | Uint8Array;

export type ScanEncoding = 'utf8' | 'latin1' | 'utf16le';

export interface Trace {
  /** Part name inside the container ("<archive>" for the raw container bytes). Nested containers use "outer!inner". */
  part: string;
  needle: string;
  encoding: ScanEncoding;
}

const MAX_NESTING = 3;

/** Normalise any supported input to a Uint8Array. */
export async function toBytes(input: PackageInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof (input as Blob).arrayBuffer === 'function') {
    return new Uint8Array(await (input as Blob).arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(input as Blob);
  });
}

function asUint8(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

/** Encode a needle the way it would appear in bytes for the given encoding. */
export function encodeNeedle(needle: string, encoding: ScanEncoding): Uint8Array {
  if (encoding === 'utf8') return new TextEncoder().encode(needle);
  const out: number[] = [];
  for (let i = 0; i < needle.length; i++) {
    const code = needle.charCodeAt(i);
    if (encoding === 'utf16le') {
      out.push(code & 0xff, code >> 8);
    } else {
      // latin1: only the low byte is representable; callers pass ASCII needles
      out.push(code & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Naive byte search. Fixtures are small, so no need for anything smarter. */
export function indexOfBytes(haystack: Uint8Array, target: Uint8Array, from = 0): number {
  if (target.length === 0) return -1;
  outer: for (let i = from; i + target.length <= haystack.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * True when `needle` occurs in `buffer` as latin1 bytes (utf16 = false) or as
 * UTF-16LE bytes (utf16 = true). Kept with its original signature from
 * tests/doc.test.ts so existing call sites keep working.
 */
export function bytesContain(buffer: ArrayBuffer | Uint8Array, needle: string, utf16: boolean): boolean {
  return indexOfBytes(asUint8(buffer), encodeNeedle(needle, utf16 ? 'utf16le' : 'latin1')) !== -1;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isCfb(bytes: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function scanBytes(part: string, bytes: Uint8Array, needles: string[], out: Trace[]): void {
  let text: string | null = null;
  for (const needle of needles) {
    if (text === null) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes(needle)) out.push({ part, needle, encoding: 'utf8' });
    if (indexOfBytes(bytes, encodeNeedle(needle, 'latin1')) !== -1) out.push({ part, needle, encoding: 'latin1' });
    if (indexOfBytes(bytes, encodeNeedle(needle, 'utf16le')) !== -1) out.push({ part, needle, encoding: 'utf16le' });
  }
}

function cfbStreams(bytes: Uint8Array): Array<{ name: string; content: Uint8Array }> {
  const container = CFB.parse(bytes, { type: 'array' });
  const streams: Array<{ name: string; content: Uint8Array }> = [];
  container.FileIndex.forEach((entry, i) => {
    if (entry.type !== 2 || !entry.content) return;
    const raw = entry.content as unknown;
    const content = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
    streams.push({ name: container.FullPaths[i] ?? entry.name, content });
  });
  return streams;
}

async function scanContainer(prefix: string, bytes: Uint8Array, needles: string[], out: Trace[], depth: number): Promise<void> {
  const archiveName = prefix ? prefix : '<archive>';
  scanBytes(archiveName, bytes, needles, out);
  if (depth >= MAX_NESTING) return;

  if (isZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    for (const path of Object.keys(zip.files)) {
      const file = zip.file(path);
      if (!file) continue;
      const part = prefix ? `${prefix}!${path}` : path;
      const content = await file.async('uint8array');
      if (isZip(content) || isCfb(content)) {
        await scanContainer(part, content, needles, out, depth + 1);
      } else {
        scanBytes(part, content, needles, out);
      }
    }
    return;
  }

  if (isCfb(bytes)) {
    for (const stream of cfbStreams(bytes)) {
      const part = prefix ? `${prefix}!${stream.name}` : stream.name;
      if (isZip(stream.content) || isCfb(stream.content)) {
        await scanContainer(part, stream.content, needles, out, depth + 1);
      } else {
        scanBytes(part, stream.content, needles, out);
      }
    }
  }
}

/**
 * Return every (part, needle, encoding) hit without throwing. Useful for
 * tests that want to assert a fixture DOES contain something.
 */
export async function findTraces(input: PackageInput, needles: string[]): Promise<Trace[]> {
  const bytes = await toBytes(input);
  const out: Trace[] = [];
  await scanContainer('', bytes, needles.filter((n) => n.length > 0), out, 0);
  return out;
}

/**
 * Throw when any needle survives anywhere in the package: every zip entry or
 * CFB stream (UTF-8, latin1, UTF-16LE), nested containers, and the raw bytes.
 */
export interface NoTraceOptions {
  /**
   * Parts the writer copies verbatim under informed consent (T177: embedded
   * objects, macros, OLE ObjectPool streams). A trace inside such a part,
   * or inside a container nested in it (`part!inner`), is not a failure;
   * the suite asserts separately that the part was reported to the user.
   */
  exclude?: (part: string) => boolean;
}

export async function assertNoTrace(input: PackageInput, needles: string[], options: NoTraceOptions = {}): Promise<void> {
  const all = await findTraces(input, needles);
  const traces = options.exclude ? all.filter((t) => !options.exclude!(t.part)) : all;
  if (traces.length === 0) return;
  const lines = traces.map((t) => `  ${JSON.stringify(t.needle)} in ${JSON.stringify(t.part)} as ${t.encoding}`);
  throw new Error(`assertNoTrace: ${traces.length} trace(s) of the original survived:\n${lines.join('\n')}`);
}

/**
 * True when the needle is present somewhere in the package. Used by the
 * fixture self-tests to prove a generator really seeded what it claims.
 */
export async function packageContains(input: PackageInput, needle: string): Promise<boolean> {
  return (await findTraces(input, [needle])).length > 0;
}

/**
 * Env var contract for the LibreOffice CI job: when DOCCLOAK_WRITE_OUTPUTS is
 * set to a directory, tests can drop the files they produced there so the
 * 'office-open' workflow job can run `soffice --headless --convert-to pdf`
 * over them. When the variable is unset this is a no-op and returns undefined.
 * Returns the absolute path written.
 */
export async function writeOutput(name: string, bytes: PackageInput): Promise<string | undefined> {
  const dir = typeof process !== 'undefined' ? process.env?.DOCCLOAK_WRITE_OUTPUTS : undefined;
  if (!dir) return undefined;
  const safe = basename(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, safe);
  writeFileSync(target, await toBytes(bytes));
  return target;
}
