// Proves the fixtures themselves (never calls the redactor):
// - every generator yields a well-formed container of the right kind,
// - every documented seed is really present, in the documented part,
// - assertNoTrace fails loudly on each of them and passes on a clean needle,
// - generators are deterministic,
// - the package-scan helper sees latin1, UTF-16LE and nested containers,
// - writeOutput honours the DOCCLOAK_WRITE_OUTPUTS contract.
//
// When DOCCLOAK_WRITE_OUTPUTS is set, every fixture is also written to disk so
// the 'office-open' CI job can prove LibreOffice opens the inputs.

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import CFB from 'cfb';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoTrace,
  findTraces,
  packageContains,
  bytesContain,
  encodeNeedle,
  writeOutput,
} from './package-scan.ts';
import { ALL_FIXTURES, docIsEncrypted, buildDocFixture, latin1 } from './fixtures/index.ts';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

describe('fixture generators', () => {
  for (const fixture of ALL_FIXTURES) {
    describe(fixture.name, () => {
      it('produces a container of the expected kind', async () => {
        const bytes = await fixture.build();
        expect(bytes).toBeInstanceOf(Uint8Array);
        if (fixture.ext === 'doc') {
          expect(startsWith(bytes, CFB_MAGIC)).toBe(true);
          const container = CFB.parse(bytes, { type: 'array' });
          expect(container.FullPaths).toContain('Root Entry/WordDocument');
        } else {
          expect(startsWith(bytes, ZIP_MAGIC)).toBe(true);
          const zip = await JSZip.loadAsync(bytes);
          expect(zip.file('[Content_Types].xml')).not.toBeNull();
          expect(zip.file('_rels/.rels')).not.toBeNull();
          const main = fixture.ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml';
          expect(zip.file(main)).not.toBeNull();
        }
        await writeOutput(`${fixture.name}.${fixture.ext}`, bytes);
      });

      it('has at least one seed and names a finding', () => {
        expect(fixture.seeds.length).toBeGreaterThan(0);
        expect(fixture.findings.length).toBeGreaterThan(0);
      });

      it('seeds every documented needle in the documented part', async () => {
        const bytes = await fixture.build();
        for (const seed of fixture.seeds) {
          const traces = await findTraces(bytes, [seed.needle]);
          const parts = traces.map((t) => t.part);
          expect(parts, `needle ${JSON.stringify(seed.needle)} (${seed.where}) missing`).not.toHaveLength(0);
          expect(parts, `needle ${JSON.stringify(seed.needle)} expected in ${seed.part}, found in ${JSON.stringify([...new Set(parts)])}`).toContain(seed.part);
        }
      });

      it('makes assertNoTrace fail with part and needle', async () => {
        const bytes = await fixture.build();
        const needles = fixture.seeds.map((s) => s.needle);
        await expect(assertNoTrace(bytes, needles)).rejects.toThrow(/assertNoTrace/);
        for (const seed of fixture.seeds) {
          let message = '';
          try {
            await assertNoTrace(bytes, [seed.needle]);
          } catch (err) {
            message = (err as Error).message;
          }
          expect(message).toContain(JSON.stringify(seed.needle));
          expect(message).toContain(JSON.stringify(seed.part));
        }
      });

      it('passes assertNoTrace for a needle that was never planted', async () => {
        const bytes = await fixture.build();
        await expect(assertNoTrace(bytes, ['NEVER_PLANTED_NEEDLE_0xC0FFEE'])).resolves.toBeUndefined();
      });

      it('is deterministic', async () => {
        const a = await fixture.build();
        const b = await fixture.build();
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      });
    });
  }

  it('sets fEncrypted only on the encrypted variant', () => {
    expect(docIsEncrypted(buildDocFixture({ encrypted: true }))).toBe(true);
    expect(docIsEncrypted(buildDocFixture())).toBe(false);
  });

  it('uses unique fixture names', () => {
    const names = ALL_FIXTURES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('package-scan helper', () => {
  it('bytesContain finds latin1 and UTF-16LE encodings separately', () => {
    const latin = latin1('abc Secret xyz');
    expect(bytesContain(latin, 'Secret', false)).toBe(true);
    expect(bytesContain(latin, 'Secret', true)).toBe(false);
    const wide = encodeNeedle('abc Secret xyz', 'utf16le');
    expect(bytesContain(wide, 'Secret', true)).toBe(true);
    expect(bytesContain(wide, 'Secret', false)).toBe(false);
    expect(bytesContain(latin.buffer as ArrayBuffer, 'Secret', false)).toBe(true);
  });

  it('reports the encoding a needle was found in', async () => {
    const zip = new JSZip();
    zip.file('wide.bin', encodeNeedle('hello WideSecret', 'utf16le'));
    zip.file('narrow.bin', latin1('hello NarrowSecret'));
    zip.file('text.xml', '<a>TextSecret</a>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const traces = await findTraces(bytes, ['WideSecret', 'NarrowSecret', 'TextSecret']);
    // Small entries are STORED by JSZip, so the raw archive matches too; look at parts only.
    const find = (needle: string): string[] =>
      traces.filter((t) => t.needle === needle && t.part !== '<archive>').map((t) => `${t.part}:${t.encoding}`);
    expect(find('WideSecret')).toEqual(['wide.bin:utf16le']);
    expect(find('NarrowSecret')).toEqual(expect.arrayContaining(['narrow.bin:utf8', 'narrow.bin:latin1']));
    expect(find('NarrowSecret')).not.toContain('narrow.bin:utf16le');
    expect(find('TextSecret')).toEqual(expect.arrayContaining(['text.xml:utf8', 'text.xml:latin1']));
  });

  it('scans the raw archive bytes (zip comment, entry names)', async () => {
    const zip = new JSZip();
    zip.file('SecretEntryName.xml', '<a/>');
    const bytes = await zip.generateAsync({ type: 'uint8array', comment: 'ArchiveCommentSecret' });
    const traces = await findTraces(bytes, ['ArchiveCommentSecret', 'SecretEntryName']);
    expect(traces.some((t) => t.needle === 'ArchiveCommentSecret' && t.part === '<archive>')).toBe(true);
    expect(traces.some((t) => t.needle === 'SecretEntryName' && t.part === '<archive>')).toBe(true);
  });

  it('recurses into nested zip and CFB entries', async () => {
    const inner = new JSZip();
    inner.file('deep.xml', '<a>NestedZipSecret</a>');
    const innerBytes = await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, '/Stream1', latin1('NestedCfbSecret'));
    const cfbBytes = new Uint8Array(CFB.write(cfb, { type: 'array' }) as number[]);
    const outer = new JSZip();
    outer.file('embeddings/inner.xlsx', innerBytes);
    outer.file('embeddings/ole.bin', cfbBytes);
    const bytes = await outer.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const traces = await findTraces(bytes, ['NestedZipSecret', 'NestedCfbSecret']);
    expect(traces.map((t) => t.part)).toContain('embeddings/inner.xlsx!deep.xml');
    expect(traces.map((t) => t.part)).toContain('embeddings/ole.bin!Root Entry/Stream1');
    await expect(assertNoTrace(bytes, ['NestedZipSecret'])).rejects.toThrow(/inner\.xlsx!deep\.xml/);
  });

  it('scans every CFB stream in latin1 and UTF-16LE', async () => {
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, '/Narrow', latin1('xx NarrowStreamSecret'));
    CFB.utils.cfb_add(cfb, '/Sub/Wide', encodeNeedle('xx WideStreamSecret', 'utf16le'));
    const bytes = new Uint8Array(CFB.write(cfb, { type: 'array' }) as number[]);
    const traces = await findTraces(bytes, ['NarrowStreamSecret', 'WideStreamSecret']);
    expect(traces.some((t) => t.part === 'Root Entry/Narrow' && t.encoding === 'latin1')).toBe(true);
    expect(traces.some((t) => t.part === 'Root Entry/Sub/Wide' && t.encoding === 'utf16le')).toBe(true);
    expect(await packageContains(bytes, 'WideStreamSecret')).toBe(true);
    expect(await packageContains(bytes, 'Absent')).toBe(false);
  });

  it('accepts Blob, ArrayBuffer and Uint8Array inputs', async () => {
    const zip = new JSZip();
    zip.file('a.xml', '<a>BlobSecret</a>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await expect(assertNoTrace(bytes, ['BlobSecret'])).rejects.toThrow(/a\.xml/);
    await expect(assertNoTrace(ab, ['BlobSecret'])).rejects.toThrow(/a\.xml/);
    await expect(assertNoTrace(new Blob([bytes]), ['BlobSecret'])).rejects.toThrow(/a\.xml/);
    await expect(assertNoTrace(new Blob([bytes]), ['Other'])).resolves.toBeUndefined();
  });

  it('writeOutput is a no-op without DOCCLOAK_WRITE_OUTPUTS and writes when set', async () => {
    const saved = process.env.DOCCLOAK_WRITE_OUTPUTS;
    try {
      delete process.env.DOCCLOAK_WRITE_OUTPUTS;
      expect(await writeOutput('x.docx', latin1('abc'))).toBeUndefined();
      const dir = mkdtempSync(join(tmpdir(), 'doccloak-outputs-'));
      try {
        process.env.DOCCLOAK_WRITE_OUTPUTS = dir;
        const path = await writeOutput('sub/dir/we ird!.docx', latin1('abc'));
        expect(path).toBe(join(dir, 'we_ird_.docx'));
        expect(existsSync(path as string)).toBe(true);
        expect(readFileSync(path as string, 'latin1')).toBe('abc');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      if (saved === undefined) delete process.env.DOCCLOAK_WRITE_OUTPUTS;
      else process.env.DOCCLOAK_WRITE_OUTPUTS = saved;
    }
  });
});
