// @vitest-environment jsdom
//
// Seed self-test (T196). Runs everywhere, LibreOffice or not: proves that
// every seed under tests/corpus/seeds/ is well-formed, that its manifest
// names strings which really occur in the source, that identifiers carry
// valid checksums (so a PESEL or IBAN regex would fire on them too), and
// that the seed set as a whole covers every placement the plan asks for.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import {
  CORPUS_FORMATS,
  SEEDS_DIR,
  isValidIban,
  isValidPesel,
  loadManifests,
  requiredNeedles,
} from './manifest.ts';

const manifests = loadManifests();

const SOURCE_FORMATS: Record<string, string[]> = {
  '.fodt': ['docx', 'doc', 'pdf'],
  '.html': ['docx', 'doc', 'pdf'],
  '.fods': ['xlsx', 'pdf'],
};

/** Placements the plan (section 4) requires the corpus to seed. */
const REQUIRED_PLACEMENTS = [
  'body', 'heading', 'table', 'header', 'footer', 'footnote', 'comment', 'frame',
  'chart-title', 'chart-category', 'meta', 'sheet-name', 'cell',
];

describe('corpus seeds', () => {
  it('has at least 15 seeds with manifests', () => {
    expect(manifests.size).toBeGreaterThanOrEqual(15);
  });

  it('has a manifest for every source and a source for every manifest', () => {
    const files = readdirSync(SEEDS_DIR).sort();
    const sources = files.filter((f) => f in SOURCE_FORMATS || extname(f) in SOURCE_FORMATS);
    for (const source of sources) {
      const stem = source.slice(0, -extname(source).length);
      expect(manifests.has(stem), `${source} has no ${stem}.json`).toBe(true);
    }
    for (const [name, manifest] of manifests) {
      expect(manifest.seed).toBe(name);
      expect(existsSync(join(SEEDS_DIR, manifest.source)), `${name}: source ${manifest.source} missing`).toBe(true);
    }
  });

  it('covers every placement the plan requires', () => {
    const where = new Set<string>();
    for (const manifest of manifests.values()) {
      for (const label of manifest.where) where.add(label);
    }
    // A label counts when any seed uses it or a more specific variant
    // (heading-adjacent-body, header-with-page-field, ...).
    const missing = REQUIRED_PLACEMENTS.filter((p) => ![...where].some((w) => w === p || w.startsWith(`${p}-`)));
    expect(missing).toEqual([]);
  });

  it('covers docx, doc, xlsx and pdf', () => {
    const formats = new Set<string>();
    for (const manifest of manifests.values()) for (const f of manifest.formats) formats.add(f);
    expect([...formats].sort()).toEqual([...CORPUS_FORMATS].sort());
  });

  for (const [name, manifest] of manifests) {
    describe(name, () => {
      const sourcePath = join(SEEDS_DIR, manifest.source);
      const sourceText = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
      const ext = extname(manifest.source);

      it('declares formats its source can produce', () => {
        const allowed = SOURCE_FORMATS[ext] ?? [];
        expect(manifest.formats.length).toBeGreaterThan(0);
        for (const f of manifest.formats) expect(allowed, `${f} cannot be produced from ${ext}`).toContain(f);
      });

      it('is well-formed', () => {
        expect(sourceText.length).toBeGreaterThan(0);
        if (ext === '.html') return;
        const doc = new DOMParser().parseFromString(sourceText, 'application/xml');
        const error = doc.querySelector('parsererror');
        expect(error?.textContent ?? '').toBe('');
        expect(doc.documentElement.localName).toBe('document');
      });

      it('names needles that occur verbatim in the source', () => {
        expect(manifest.needles.length).toBeGreaterThan(0);
        expect(new Set(manifest.needles).size).toBe(manifest.needles.length);
        for (const needle of manifest.needles) {
          expect(needle.trim()).toBe(needle);
          expect(needle).not.toMatch(/[&<>]/);
          expect(sourceText.includes(needle), `${JSON.stringify(needle)} not in ${manifest.source}`).toBe(true);
        }
      });

      it('keeps placements, optional and where consistent', () => {
        expect(Object.keys(manifest.placements).sort()).toEqual([...manifest.needles].sort());
        for (const needle of manifest.optional) expect(manifest.needles).toContain(needle);
        expect(requiredNeedles(manifest).length).toBeGreaterThan(0);
        const labels = new Set(Object.values(manifest.placements).flat());
        expect([...labels].sort()).toEqual([...manifest.where].sort());
      });

      it('uses identifiers with valid checksums', () => {
        for (const needle of manifest.needles) {
          if (/^\d{11}$/.test(needle)) expect(isValidPesel(needle), `PESEL ${needle}`).toBe(true);
          if (/^[A-Z]{2}\d{2}[ \dA-Z]+$/.test(needle)) expect(isValidIban(needle), `IBAN ${needle}`).toBe(true);
        }
      });

      it('does not leak another seed\'s needles into its filler text', () => {
        // The CI grep uses the union of all needles, so a name from seed A
        // must not appear in seed B unless B lists it too.
        const own = new Set(manifest.needles);
        for (const [otherName, other] of manifests) {
          if (otherName === name) continue;
          for (const needle of other.needles) {
            if (own.has(needle)) continue;
            expect(sourceText.includes(needle), `${JSON.stringify(needle)} from ${otherName} appears in ${manifest.source} but is not in its manifest`).toBe(false);
          }
        }
      });
    });
  }
});
