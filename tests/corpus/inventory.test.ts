// Part-name inventory (T196, feeds the T177 part policy).
//
// tests/corpus/part-inventory.json lists every package part name (zip entry
// for docx/xlsx, CFB stream or storage path for doc) seen across the T173
// synthetic fixtures and every corpus file (generated and hand-saved), per
// format. Digit runs are folded to "#" so header1/header2 or sheet1/sheet7
// count as one name.
//
// - DOCCLOAK_UPDATE_INVENTORY=1: merge what is seen now into the file and
//   write it back (sorted, unique). Names already listed are kept.
// - otherwise: every name seen must already be listed. A part written by a
//   new generator (a new Word build, Google Docs, Pages) therefore fails this
//   test until someone adds it to the inventory, which is the moment to
//   classify it in the T177 policy (text / structural / unredactable).

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import CFB from 'cfb';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ALL_FIXTURES } from '../helpers/fixtures/index.ts';
import { discoverCorpusFiles, INVENTORY_PATH } from './manifest.ts';
import type { PackageCorpusFormat } from './manifest.ts';

type Inventory = Record<PackageCorpusFormat, string[]> & { note?: string };

const NOTE =
  'Package part names seen per format across the T173 synthetic fixtures and the T196 corpus ' +
  '(generated + hand-saved). Digit runs are folded to "#". Regenerate with ' +
  'DOCCLOAK_UPDATE_INVENTORY=1 npx vitest run tests/corpus/inventory.test.ts. ' +
  'Every new name must be classified in the T177 part policy.';

/** Fold digit runs so numbered siblings share one inventory entry. */
export function normalizePartName(name: string): string {
  return name.replace(/\d+/g, '#');
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Top-level part names of a package: zip entries, or CFB streams and storages. */
export async function listPartNames(bytes: Uint8Array): Promise<string[]> {
  const names = new Set<string>();
  if (isZip(bytes)) {
    const zip = await JSZip.loadAsync(bytes);
    zip.forEach((path, entry) => {
      if (!entry.dir) names.add(path);
    });
  } else {
    const container = CFB.parse(bytes, { type: 'array' });
    container.FileIndex.forEach((entry, i) => {
      if (i === 0) return; // Root Entry itself
      if (entry.type !== 1 && entry.type !== 2) return;
      names.add(container.FullPaths[i] ?? entry.name);
    });
  }
  return [...names];
}

function emptyInventory(): Inventory {
  return { note: NOTE, docx: [], xlsx: [], doc: [] };
}

function loadInventory(): Inventory {
  if (!existsSync(INVENTORY_PATH)) return emptyInventory();
  const parsed = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8')) as Partial<Inventory>;
  return {
    note: parsed.note ?? NOTE,
    docx: parsed.docx ?? [],
    xlsx: parsed.xlsx ?? [],
    doc: parsed.doc ?? [],
  };
}

async function collectSeen(): Promise<Record<PackageCorpusFormat, Set<string>>> {
  const seen: Record<PackageCorpusFormat, Set<string>> = { docx: new Set(), xlsx: new Set(), doc: new Set() };
  for (const fixture of ALL_FIXTURES) {
    if (fixture.ext === 'pdf') continue; // PDF has no zip/CFB parts; inventoried by its own tests (T214)
    const bytes = await fixture.build();
    for (const name of await listPartNames(bytes)) seen[fixture.ext].add(normalizePartName(name));
  }
  for (const file of discoverCorpusFiles()) {
    if (file.ext === 'pdf') continue; // no package parts (T218 corpus PDFs are checked by tests/corpus.test.ts)
    const bytes = new Uint8Array(readFileSync(file.path));
    for (const name of await listPartNames(bytes)) seen[file.ext].add(normalizePartName(name));
  }
  return seen;
}

const UPDATE = process.env.DOCCLOAK_UPDATE_INVENTORY === '1';

describe('part-name inventory', () => {
  it('normalizes numbered siblings to one name', () => {
    expect(normalizePartName('word/header1.xml')).toBe('word/header#.xml');
    expect(normalizePartName('xl/worksheets/sheet12.xml')).toBe('xl/worksheets/sheet#.xml');
    expect(normalizePartName('Root Entry/1Table')).toBe('Root Entry/#Table');
    expect(normalizePartName('docProps/core.xml')).toBe('docProps/core.xml');
  });

  it(UPDATE ? 'updates tests/corpus/part-inventory.json' : 'lists every part name seen in fixtures and corpus files', async () => {
    const seen = await collectSeen();
    const inventory = loadInventory();

    if (UPDATE) {
      const next = emptyInventory();
      for (const fmt of ['docx', 'xlsx', 'doc'] as const) {
        next[fmt] = [...new Set([...inventory[fmt], ...seen[fmt]])].sort();
      }
      writeFileSync(INVENTORY_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
      for (const fmt of ['docx', 'xlsx', 'doc'] as const) {
        expect(next[fmt].length).toBeGreaterThan(0);
      }
      return;
    }

    expect(existsSync(INVENTORY_PATH), `${INVENTORY_PATH} is missing; run DOCCLOAK_UPDATE_INVENTORY=1 npx vitest run tests/corpus/inventory.test.ts`).toBe(true);
    const missing: string[] = [];
    for (const fmt of ['docx', 'xlsx', 'doc'] as const) {
      const listed = new Set(inventory[fmt]);
      for (const name of [...seen[fmt]].sort()) {
        if (!listed.has(name)) missing.push(`${fmt}: ${JSON.stringify(name)}`);
      }
    }
    expect(
      missing,
      'part names not in tests/corpus/part-inventory.json. Classify each one in the T177 part policy, then add it ' +
      '(DOCCLOAK_UPDATE_INVENTORY=1 npx vitest run tests/corpus/inventory.test.ts, or paste the names by hand):\n' +
      missing.join('\n'),
    ).toEqual([]);
  });

  it('keeps the inventory sorted and unique', () => {
    const inventory = loadInventory();
    for (const fmt of ['docx', 'xlsx', 'doc'] as const) {
      const names = inventory[fmt];
      expect(names, `${fmt} inventory is empty`).not.toEqual([]);
      expect([...names].sort()).toEqual(names);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(name).toBe(normalizePartName(name));
    }
  });
});
