// T178: legacy .doc hardening (SECURITY_REPORT-2026-09 H5, H6, M5, L2).
//
// - fast-saved (fComplex / Word 97 cQuickSaves) and encrypted (fEncrypted /
//   fObfuscated) files are refused on read AND write with a typed error;
// - every original value is destroyed as bytes in WordDocument (UTF-16LE),
//   Table (UTF-16LE + cp1252) and Data (UTF-16LE) without moving anything;
// - SttbfRMark, GrpXstAtnOwners, SttbfBkmk and AutosaveSource are scrubbed;
// - ObjectPool / Macros are still copied through (T196 / T199) and
//   inspectDoc reports them so hosts can warn.

import { describe, it, expect } from 'vitest';
import CFB from 'cfb';
import {
  readDocText,
  writeAnonymizedDoc,
  inspectDoc,
  buildScrubNeedles,
  scrubStreamBytes,
} from '../src/doc.ts';
import { UnsupportedDocumentError } from '../src/index.ts';
import {
  assertNoTrace,
  findTraces,
  packageContains,
  writeOutput,
  toBytes,
  encodeNeedle,
} from './helpers/package-scan.ts';
import {
  buildDocFixture,
  buildDocFastSave,
  buildDocEncrypted,
  buildDocExtraStreams,
  buildDocRevisionAuthors,
  buildDocEverything,
  DOC_SEED,
  DOC_MAIN_TEXT,
  docIsEncrypted,
} from './helpers/fixtures/doc.ts';

// ─── helpers ─────────────────────────────────────────────────────────────────

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function streamOf(bytes: Uint8Array, path: string): Uint8Array {
  const container = CFB.parse(bytes, { type: 'array' });
  const entry = CFB.find(container, path);
  if (!entry?.content) throw new Error(`missing stream ${path}`);
  const raw = entry.content as unknown;
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
}

/** Rewrite one stream of a CFB fixture with new content (same or different length). */
function withStream(bytes: Uint8Array, path: string, content: Uint8Array): Uint8Array {
  const container = CFB.parse(bytes, { type: 'array' });
  const entry = CFB.find(container, path);
  if (!entry) throw new Error(`missing stream ${path}`);
  entry.content = content;
  entry.size = content.length;
  return new Uint8Array(CFB.write(container, { type: 'array' }) as number[]);
}

/** Patch the FIB: flags word at 0x0A and, optionally, FibBase.nFib at 0x02. */
function withFib(bytes: Uint8Array, patch: { flags?: number; nFib?: number }): Uint8Array {
  const wd = new Uint8Array(streamOf(bytes, '/WordDocument'));
  const v = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  if (patch.flags !== undefined) v.setUint16(0x0a, patch.flags, true);
  if (patch.nFib !== undefined) v.setUint16(0x02, patch.nFib, true);
  return withStream(bytes, '/WordDocument', wd);
}

const utf16 = (s: string): Uint8Array => encodeNeedle(s, 'utf16le');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const F_COMPLEX = 0x0004;
const F_ENCRYPTED = 0x0100;
const F_OBFUSCATED = 0x8000;
const NFIB_WORD97 = 0x00c1;
const NFIB_WORD2007 = 0x0112;

async function expectRefusal(bytes: Uint8Array, code: 'fast-saved' | 'encrypted'): Promise<void> {
  const buffer = asArrayBuffer(bytes);
  let readErr: unknown;
  try { readDocText(buffer); } catch (e) { readErr = e; }
  expect(readErr).toBeInstanceOf(UnsupportedDocumentError);
  expect((readErr as UnsupportedDocumentError).code).toBe(code);

  let writeErr: unknown;
  try { await writeAnonymizedDoc(buffer, []); } catch (e) { writeErr = e; }
  expect(writeErr).toBeInstanceOf(UnsupportedDocumentError);
  expect((writeErr as UnsupportedDocumentError).code).toBe(code);
}

function mainTextReplacement(buffer: ArrayBuffer): { start: number; end: number; replacement: string } {
  const text = readDocText(buffer);
  const start = text.indexOf(DOC_SEED.mainText);
  expect(start).toBeGreaterThanOrEqual(0);
  return { start, end: start + DOC_SEED.mainText.length, replacement: '<<PERSON_1>>' };
}

// ─── refusals ────────────────────────────────────────────────────────────────

describe('legacy .doc refusals', () => {
  it('refuses a fast-saved file (fComplex) on read and write with code fast-saved', async () => {
    await expectRefusal(buildDocFastSave(), 'fast-saved');
  });

  it('names the remedy in the fast-saved message', () => {
    expect(() => readDocText(asArrayBuffer(buildDocFastSave()))).toThrow(/Save As|\.docx/);
  });

  it('refuses an encrypted file (fEncrypted) with code encrypted', async () => {
    const bytes = buildDocEncrypted();
    expect(docIsEncrypted(bytes)).toBe(true);
    await expectRefusal(bytes, 'encrypted');
  });

  it('refuses an XOR-obfuscated file (fObfuscated) with code encrypted', async () => {
    await expectRefusal(withFib(buildDocFixture(), { flags: F_OBFUSCATED }), 'encrypted');
  });

  it('reports encrypted before fast-saved when both flags are set', async () => {
    await expectRefusal(withFib(buildDocFixture(), { flags: F_ENCRYPTED | F_COMPLEX }), 'encrypted');
  });

  it('treats Word 97 cQuickSaves > 0 as fast-saved', async () => {
    await expectRefusal(withFib(buildDocFixture(), { flags: 3 << 4, nFib: NFIB_WORD97 }), 'fast-saved');
  });

  it('ignores cQuickSaves = 0xF on Word 2000+ files (MS-DOC requires 0xF there)', () => {
    const bytes = withFib(buildDocFixture(), { flags: 0xf << 4, nFib: NFIB_WORD2007 });
    expect(readDocText(asArrayBuffer(bytes))).toContain(DOC_SEED.mainText);
    expect(inspectDoc(bytes).fastSaved).toBe(false);
  });

  it('never silently returns partial text for a fast-saved file', () => {
    // The orphan bytes are outside the piece table: a plain read would return
    // the visible text and hide the remnant. The refusal is the fix (H5).
    expect(() => readDocText(asArrayBuffer(buildDocFastSave()))).toThrow(UnsupportedDocumentError);
  });
});

// ─── inspectDoc ──────────────────────────────────────────────────────────────

describe('inspectDoc', () => {
  it('reports a clean file as clean', () => {
    expect(inspectDoc(buildDocFixture())).toEqual({
      encrypted: false,
      fastSaved: false,
      streams: { data: false, objectPool: false, macros: false },
    });
  });

  it('reports refusal flags without throwing', () => {
    expect(inspectDoc(buildDocFastSave()).fastSaved).toBe(true);
    expect(inspectDoc(buildDocEncrypted()).encrypted).toBe(true);
    expect(inspectDoc(withFib(buildDocFixture(), { flags: F_OBFUSCATED })).encrypted).toBe(true);
  });

  it('reports Data, ObjectPool and Macros streams', () => {
    expect(inspectDoc(buildDocExtraStreams()).streams).toEqual({ data: true, objectPool: true, macros: true });
    expect(inspectDoc(asArrayBuffer(buildDocEverything())).streams.macros).toBe(true);
  });

  it('rejects non-.doc input', () => {
    expect(() => inspectDoc(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

// ─── byte scrub primitives ───────────────────────────────────────────────────

describe('buildScrubNeedles', () => {
  it('keeps values, tokens and punctuation-stripped tokens of 4+ chars, longest first', () => {
    const needles = buildScrubNeedles(['John Smith,', 'Jo Li', 'ab']);
    expect(needles[0]).toBe('John Smith,');
    expect(needles).toContain('Smith,');
    expect(needles).toContain('Smith');
    expect(needles).toContain('John');
    expect(needles).not.toContain('Jo');
    expect(needles).not.toContain('Li');
    expect(needles).not.toContain('ab');
    // 'Jo Li' is 5 chars including the space: kept as a whole value
    expect(needles).toContain('Jo Li');
  });

  it('drops tokens that occur inside a replacement, never the full value', () => {
    const needles = buildScrubNeedles(['Leaky Person', 'Smith & Co'], ['[PERSON_1]', 'Nowak & Co']);
    expect(needles).toContain('Leaky Person');
    expect(needles).toContain('Leaky');
    expect(needles).not.toContain('Person');
    expect(needles).toContain('Smith & Co');
    expect(needles).toContain('Smith');
    // A full value that is also inside a replacement is still scrubbed
    expect(buildScrubNeedles(['Person'], ['[PERSON_1]'])).toEqual(['Person']);
  });
});

describe('scrubStreamBytes', () => {
  it('overwrites UTF-16LE hits at any byte alignment, case-insensitively, keeping length', () => {
    const bytes = concat(new Uint8Array([0x99]), utf16('xx JOHN smith yy'), new Uint8Array([0x00]));
    const before = bytes.length;
    expect(scrubStreamBytes(bytes, 'John Smith', 'utf16le')).toBe(1);
    expect(bytes.length).toBe(before);
    expect(bytes[0]).toBe(0x99);
    expect(new TextDecoder('utf-16le').decode(bytes.subarray(1, before - 1))).toBe('xx            yy');
  });

  it('overwrites cp1252 hits with spaces and leaves other bytes alone', () => {
    const bytes = encodeNeedle('\u0001Zoe Müller\u0002zoe müLLER', 'latin1');
    expect(scrubStreamBytes(bytes, 'Zoe Müller', 'cp1252')).toBe(2);
    expect(Array.from(bytes)).toEqual([0x01, ...Array(10).fill(0x20), 0x02, ...Array(10).fill(0x20)]);
  });

  it('skips a cp1252 search for needles that cp1252 cannot encode', () => {
    const bytes = encodeNeedle('Michał Nowak', 'latin1');
    expect(scrubStreamBytes(bytes, 'Michał', 'cp1252')).toBe(0);
    expect(scrubStreamBytes(utf16('Michał Nowak'), 'michaŁ', 'utf16le')).toBe(1);
  });

  it('does not match a cp1252 needle against UTF-16 bytes or vice versa', () => {
    const bytes = utf16('John');
    expect(scrubStreamBytes(bytes, 'John', 'cp1252')).toBe(0);
    expect(scrubStreamBytes(encodeNeedle('John', 'latin1'), 'John', 'utf16le')).toBe(0);
  });
});

// ─── writer: byte scrub of Data / WordDocument / Table ───────────────────────

describe('writeAnonymizedDoc byte scrub', () => {
  // The T173 fixture seeds Data in latin1. Data is scanned in UTF-16LE only
  // (hyperlink field data and OLE previews store text as UTF-16; cp1252 hits
  // inside embedded JPEG/PNG bytes would corrupt pictures), so a cp1252
  // remnant in Data is out of scope by design. This variant seeds the same
  // value as UTF-16LE, the encoding Word actually uses there.
  const DATA_UTF16_PREFIX = new Uint8Array([0xd0, 0xc9, 0xea, 0x79, 0x00, 0x00]);
  function buildDocExtraStreamsUtf16Data(): Uint8Array {
    const data = concat(DATA_UTF16_PREFIX, utf16(`http://${DOC_SEED.dataStream}/x`), utf16(DOC_SEED.dataStream.toUpperCase()));
    return withStream(buildDocExtraStreams(), '/Data', data);
  }

  it('destroys UTF-16LE values in the Data stream without changing its length', async () => {
    const input = buildDocExtraStreamsUtf16Data();
    expect(await packageContains(input, DOC_SEED.dataStream)).toBe(true);
    const dataBefore = streamOf(input, '/Data');

    const buffer = asArrayBuffer(input);
    const repl = mainTextReplacement(buffer);
    const blob = await writeAnonymizedDoc(buffer, [repl], [{ value: DOC_SEED.dataStream, replacement: '<<URL_1>>' }]);
    const out = await toBytes(blob);
    await writeOutput('doc-extra-streams-utf16-redacted.doc', out);

    await assertNoTrace(out, [DOC_SEED.dataStream, DOC_SEED.mainText, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor]);
    const dataAfter = streamOf(out, '/Data');
    expect(dataAfter.length).toBe(dataBefore.length);
    expect(Array.from(dataAfter.subarray(0, DATA_UTF16_PREFIX.length))).toEqual(Array.from(DATA_UTF16_PREFIX));
    expect(new TextDecoder('utf-16le').decode(dataAfter.subarray(DATA_UTF16_PREFIX.length))).toMatch(/^http:\/\/ +\/x +$/);
    expect(readDocText(asArrayBuffer(out))).toContain('Call <<PERSON_1>> now.');
  });

  it('scrubs Data from the session values alone (no offset replacements), all stream lengths unchanged', async () => {
    const input = buildDocExtraStreamsUtf16Data();
    const sizes = (b: Uint8Array) => ['/WordDocument', '/0Table', '/Data'].map((p) => streamOf(b, p).length);
    const before = sizes(input);

    const blob = await writeAnonymizedDoc(asArrayBuffer(input), [], [{ value: DOC_SEED.dataStream, replacement: '<<URL_1>>' }]);
    const out = await toBytes(blob);
    expect(sizes(out)).toEqual(before);
    await assertNoTrace(out, [DOC_SEED.dataStream, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor]);
    expect(readDocText(asArrayBuffer(out))).toContain(DOC_MAIN_TEXT.trim());
  });

  it('leaves cp1252 bytes in Data alone by design (documented limit) and keeps ObjectPool / Macros', async () => {
    const input = buildDocExtraStreams();
    const buffer = asArrayBuffer(input);
    const repl = mainTextReplacement(buffer);
    const blob = await writeAnonymizedDoc(buffer, [repl], [
      { value: DOC_SEED.dataStream, replacement: '<<URL_1>>' },
      { value: DOC_SEED.objectPool, replacement: '<<OBJ_1>>' },
      { value: DOC_SEED.macro, replacement: '<<MACRO_1>>' },
    ]);
    const out = await toBytes(blob);
    await writeOutput('doc-extra-streams-redacted.doc', out);

    // Text streams and metadata are clean
    await assertNoTrace(out, [DOC_SEED.mainText, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor]);
    // The latin1 Data seed survives only as latin1/utf8 in Data itself
    const traces = await findTraces(out, [DOC_SEED.dataStream]);
    expect(traces.length).toBeGreaterThan(0);
    for (const t of traces) {
      expect(['Root Entry/Data', '<archive>']).toContain(t.part);
      expect(t.encoding).not.toBe('utf16le');
    }
    // TODO(T196, T199): ObjectPool and Macros are still copied through
    expect(await packageContains(out, DOC_SEED.objectPool)).toBe(true);
    expect(await packageContains(out, DOC_SEED.macro)).toBe(true);
    expect(inspectDoc(out).streams).toEqual({ data: true, objectPool: true, macros: true });
  });

  it('destroys case variants and tokens of the original in Table (UTF-16 and cp1252) and WordDocument (UTF-16)', async () => {
    // Plant remnants: Table gets "LEAKY PERSON" (UTF-16 at an odd offset) and
    // "leaky" (cp1252); WordDocument gets "Leaky Person" as UTF-16 in an
    // unreferenced region and "leaky" as cp1252 (which stays: WordDocument is
    // scanned in UTF-16 only).
    const base = buildDocFixture();
    const table = new Uint8Array(streamOf(base, '/0Table'));
    table.set(utf16(`ZZ ${DOC_SEED.mainText.toUpperCase()} ZZ`), 0x1c1);
    table.set(encodeNeedle('leaky', 'latin1'), 0x1f0);
    const wd = new Uint8Array(streamOf(base, '/WordDocument'));
    wd.set(utf16(DOC_SEED.mainText), 0x500);
    wd.set(encodeNeedle('leaky', 'latin1'), 0x580);
    const input = withStream(withStream(base, '/0Table', table), '/WordDocument', wd);

    const buffer = asArrayBuffer(input);
    const repl = mainTextReplacement(buffer);
    const blob = await writeAnonymizedDoc(buffer, [repl]);
    const out = await toBytes(blob);
    await writeOutput('doc-remnants-redacted.doc', out);

    await assertNoTrace(out, [DOC_SEED.mainText, DOC_SEED.mainText.toUpperCase(), 'Leaky', 'LEAKY']);
    const outTable = streamOf(out, '/0Table');
    expect(new TextDecoder('utf-16le').decode(outTable.subarray(0x1c1, 0x1c1 + 2 * (DOC_SEED.mainText.length + 6)))).toBe('ZZ              ZZ');
    expect(new TextDecoder('latin1').decode(outTable.subarray(0x1f0, 0x1f5))).toBe('     ');
    const outWd = streamOf(out, '/WordDocument');
    expect(new TextDecoder('latin1').decode(outWd.subarray(0x580, 0x585))).toBe('leaky');
    expect(readDocText(asArrayBuffer(out))).toContain('Call <<PERSON_1>> now.');
  });

  it('never touches the replacement text or values shorter than 4 chars', async () => {
    const base = buildDocFixture();
    const table = new Uint8Array(streamOf(base, '/0Table'));
    table.set(utf16('Leaky Person <<PERSON_1>> now'), 0x1c0);
    const input = withStream(base, '/0Table', table);
    const buffer = asArrayBuffer(input);
    const repl = mainTextReplacement(buffer);
    const blob = await writeAnonymizedDoc(buffer, [repl], [{ value: 'now', replacement: 'X' }]);
    const out = await toBytes(blob);

    const outTable = streamOf(out, '/0Table');
    expect(new TextDecoder('utf-16le').decode(outTable.subarray(0x1c0, 0x1c0 + 2 * 29))).toBe('             <<PERSON_1>> now');
    expect(readDocText(asArrayBuffer(out))).toContain('Call <<PERSON_1>> now.');
  });
});

// ─── writer: Table string tables (M5) ────────────────────────────────────────

describe('writeAnonymizedDoc string tables', () => {
  it('scrubs SttbfRMark, GrpXstAtnOwners and AutosaveSource and the file still parses', async () => {
    const input = buildDocRevisionAuthors();
    const tableBefore = streamOf(input, '/0Table').length;
    const buffer = asArrayBuffer(input);
    const repl = mainTextReplacement(buffer);
    const blob = await writeAnonymizedDoc(buffer, [repl]);
    const out = await toBytes(blob);
    await writeOutput('doc-revision-authors-redacted.doc', out);

    await assertNoTrace(out, [
      DOC_SEED.mainText, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor,
      DOC_SEED.revisionAuthor, DOC_SEED.commentOwner, DOC_SEED.autosavePath, 'leakuser',
    ]);
    // Table only grows by the appended CLX / PLC structures; original bytes keep their offsets
    expect(streamOf(out, '/0Table').length).toBeGreaterThanOrEqual(tableBefore);
    const outWd = streamOf(out, '/WordDocument');
    const fib = new DataView(outWd.buffer, outWd.byteOffset, outWd.byteLength);
    expect(fib.getInt32(0x0232, true)).toBe(0x160); // fcSttbfRMark unchanged
    expect(fib.getInt32(0x01ba, true)).toBe(0x190); // fcGrpXstAtnOwners unchanged
    expect(fib.getInt32(0x01b6, true)).toBe(0); // lcbAutosaveSource cleared
    expect(readDocText(asArrayBuffer(out))).toContain('Call <<PERSON_1>> now.');
  });

  it('scrubs the string tables even without replacements, keeping stream lengths', async () => {
    const input = buildDocRevisionAuthors();
    const before = ['/WordDocument', '/0Table'].map((p) => streamOf(input, p).length);
    const out = await toBytes(await writeAnonymizedDoc(asArrayBuffer(input), []));
    expect(['/WordDocument', '/0Table'].map((p) => streamOf(out, p).length)).toEqual(before);
    await assertNoTrace(out, [DOC_SEED.revisionAuthor, DOC_SEED.commentOwner, DOC_SEED.autosavePath, DOC_SEED.assocAuthor]);
    expect(readDocText(asArrayBuffer(out))).toContain(DOC_SEED.mainText);
  });

  it('scrubs SttbfBkmk (bookmark names) and an 8-bit STTB, keeping the entry count', async () => {
    const base = buildDocFixture();
    const table = new Uint8Array(streamOf(base, '/0Table'));
    const tv = new DataView(table.buffer);
    // 8-bit STTB at 0x1c0: cData=2, cbExtra=0, "bkJohnSmith", "other"
    const off = 0x1c0;
    tv.setUint16(off, 2, true);
    tv.setUint16(off + 2, 0, true);
    let p = off + 4;
    for (const s of ['bkJohnSmith', 'other']) {
      table[p++] = s.length;
      table.set(encodeNeedle(s, 'latin1'), p);
      p += s.length;
    }
    const wd = new Uint8Array(streamOf(base, '/WordDocument'));
    const wv = new DataView(wd.buffer);
    wv.setInt32(0x0142, off, true);
    wv.setInt32(0x0146, p - off, true);
    const input = withStream(withStream(base, '/0Table', table), '/WordDocument', wd);

    const out = await toBytes(await writeAnonymizedDoc(asArrayBuffer(input), []));
    await assertNoTrace(out, ['bkJohnSmith', 'other']);
    const outTable = streamOf(out, '/0Table');
    const ov = new DataView(outTable.buffer, outTable.byteOffset, outTable.byteLength);
    expect(ov.getUint16(off, true)).toBe(2);
    expect(outTable[off + 4]).toBe('bkJohnSmith'.length);
    expect(outTable[off + 5]).toBe(0x20);
    const outWd = streamOf(out, '/WordDocument');
    expect(new DataView(outWd.buffer, outWd.byteOffset, outWd.byteLength).getInt32(0x0146, true)).toBe(p - off);
  });

  it('blanks and disconnects a string table it cannot parse', async () => {
    const base = buildDocFixture();
    const table = new Uint8Array(streamOf(base, '/0Table'));
    const tv = new DataView(table.buffer);
    // Extended STTB claiming a string longer than the region
    tv.setUint16(0x1c0, 0xffff, true);
    tv.setUint16(0x1c2, 1, true);
    tv.setUint16(0x1c4, 0, true);
    tv.setUint16(0x1c6, 0x7fff, true);
    table.set(utf16('RevGarbage'), 0x1c8);
    const wd = new Uint8Array(streamOf(base, '/WordDocument'));
    const wv = new DataView(wd.buffer);
    wv.setInt32(0x0232, 0x1c0, true);
    wv.setInt32(0x0236, 8 + 20, true);
    const input = withStream(withStream(base, '/0Table', table), '/WordDocument', wd);

    const out = await toBytes(await writeAnonymizedDoc(asArrayBuffer(input), []));
    await assertNoTrace(out, ['RevGarbage']);
    const outWd = streamOf(out, '/WordDocument');
    expect(new DataView(outWd.buffer, outWd.byteOffset, outWd.byteLength).getInt32(0x0236, true)).toBe(0);
  });
});

// ─── whole corpus ────────────────────────────────────────────────────────────

describe('doc fixture corpus', () => {
  it('every non-refused fixture exports with no trace of the seeds it can reach', async () => {
    const cases: Array<{ name: string; build: () => Uint8Array; needles: string[] }> = [
      { name: 'doc-base', build: () => buildDocFixture(), needles: [DOC_SEED.mainText, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor] },
      { name: 'doc-revision-authors', build: buildDocRevisionAuthors, needles: [DOC_SEED.mainText, DOC_SEED.assocAuthor, DOC_SEED.oleAuthor, DOC_SEED.revisionAuthor, DOC_SEED.commentOwner, DOC_SEED.autosavePath] },
    ];
    for (const c of cases) {
      const buffer = asArrayBuffer(c.build());
      const repl = mainTextReplacement(buffer);
      const out = await toBytes(await writeAnonymizedDoc(buffer, [repl]));
      await writeOutput(`${c.name}-redacted.doc`, out);
      await assertNoTrace(out, c.needles);
      expect(readDocText(asArrayBuffer(out))).toContain('<<PERSON_1>>');
    }
  });

  it('refuses the everything fixture (fast-saved) rather than exporting it partially', async () => {
    await expectRefusal(buildDocEverything(), 'fast-saved');
  });
});
