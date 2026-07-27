/**
 * T018 shared rules format tests:
 *  - every rules/*.json pack validates against rules/schema.json
 *  - pattern dialect lint (parses in ECMAScript, no inline flags, lookbehind
 *    only where explicitly grandfathered)
 *  - the generated rules.data.ts is in sync with the canonical JSON
 *  - the loader rejects unknown validator names at build time
 *  - metadata parity: ALL_REGEX_RULES compiled from JSON is identical to the
 *    pre-T018 hand-written TS exports (fixtures/metadata-baseline.json was
 *    captured from those modules before the switch)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { loadRegexRules, type RegionRulesJson } from '../../src/regex/loader.ts';
import { RULES_DATA } from '../../src/regex/rules.data.ts';
import { VALIDATORS } from '../../src/regex/validators.ts';
// @ts-expect-error plain .mjs helper without type declarations
import { render } from '../../scripts/generate-rules-module.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_DIR = join(ROOT, 'rules');

const schema = JSON.parse(readFileSync(join(RULES_DIR, 'schema.json'), 'utf8'));
const packFiles = readdirSync(RULES_DIR).filter((f) => f.endsWith('.json') && f !== 'schema.json');
const packs = new Map<string, RegionRulesJson>(
  packFiles.map((f) => [f, JSON.parse(readFileSync(join(RULES_DIR, f), 'utf8'))]),
);

// ── Minimal JSON Schema validator ───────────────────────────
// Covers exactly the keyword subset rules/schema.json uses; throws on any
// keyword it does not implement so the schema cannot silently outgrow it.

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'pattern', 'minLength', 'minItems', 'exclusiveMinimum', 'maximum',
]);

function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function validate(node: Record<string, unknown>, value: unknown, path: string, errors: string[]): void {
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new Error(`schema keyword "${key}" at ${path} is not supported by the test validator`);
    }
  }

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref "${ref}"`);
    const target = (schema.$defs as Record<string, Record<string, unknown>>)[ref.slice('#/$defs/'.length)];
    if (!target) throw new Error(`unresolvable $ref "${ref}"`);
    validate(target, value, path, errors);
    return;
  }

  if (node.enum !== undefined) {
    if (!(node.enum as unknown[]).includes(value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
    }
    return;
  }

  if (typeof node.type === 'string' && jsonType(value) !== node.type) {
    errors.push(`${path}: expected ${node.type}, got ${jsonType(value)}`);
    return;
  }

  if (typeof value === 'string') {
    if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match ${node.pattern}`);
    }
    if (typeof node.minLength === 'number' && value.length < node.minLength) {
      errors.push(`${path}: shorter than minLength ${node.minLength}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof node.exclusiveMinimum === 'number' && value <= node.exclusiveMinimum) {
      errors.push(`${path}: ${value} <= exclusiveMinimum ${node.exclusiveMinimum}`);
    }
    if (typeof node.maximum === 'number' && value > node.maximum) {
      errors.push(`${path}: ${value} > maximum ${node.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === 'number' && value.length < node.minItems) {
      errors.push(`${path}: fewer than minItems ${node.minItems}`);
    }
    if (node.items) {
      value.forEach((item, i) => validate(node.items as Record<string, unknown>, item, `${path}[${i}]`, errors));
    }
  }

  if (jsonType(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const req of (node.required ?? []) as string[]) {
      if (!(req in obj)) errors.push(`${path}: missing required property "${req}"`);
    }
    for (const [key, propValue] of Object.entries(obj)) {
      if (props[key]) {
        validate(props[key], propValue, `${path}.${key}`, errors);
      } else if (node.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`);
      }
    }
  }
}

// ── Schema validation ───────────────────────────────────────

describe('rules/*.json: schema validation', () => {
  it('found all 18 rule packs next to schema.json', () => {
    expect(packFiles.length).toBe(18);
  });

  for (const [file, pack] of packs) {
    it(`${file} validates against rules/schema.json`, () => {
      const errors: string[] = [];
      validate(schema, pack, file.replace('.json', ''), errors);
      expect(errors).toEqual([]);
    });

    it(`${file} region matches its filename`, () => {
      expect(`${pack.region}.json`).toBe(file);
    });
  }

  it('rule ids are globally unique and total 147', () => {
    const ids = [...packs.values()].flatMap((p) => p.rules.map((r) => r.id));
    expect(ids.length).toBe(147);
    expect(new Set(ids).size).toBe(147);
  });

  it('every rule id embeds its pack region', () => {
    for (const pack of packs.values()) {
      for (const rule of pack.rules) {
        expect(rule.id.startsWith(`regex:${pack.region}:`), rule.id).toBe(true);
      }
    }
  });

  it('every validate name resolves in the validators.ts registry', () => {
    for (const pack of packs.values()) {
      for (const rule of pack.rules) {
        if (rule.validate !== undefined) {
          expect(VALIDATORS[rule.validate], `${rule.id} -> ${rule.validate}`).toBeTypeOf('function');
        }
      }
    }
  });

  it('every registry validator is referenced by at least one rule', () => {
    const used = new Set(
      [...packs.values()].flatMap((p) => p.rules.map((r) => r.validate)).filter(Boolean),
    );
    expect([...used].sort()).toEqual(Object.keys(VALIDATORS).sort());
  });
});

// ── Pattern dialect lint (arch doc section 6) ───────────────

/**
 * Lookbehind is outside the documented ECMAScript/Python common subset.
 * These two pre-existing universal rules were moved verbatim (behavior
 * freeze); they are grandfathered here and flagged for reconciliation in
 * the Python-consumption work (T019/T021). Do not add new entries.
 */
const LOOKBEHIND_GRANDFATHERED = new Set([
  'regex:universal:labeled_id',
  'regex:universal:long_number',
]);

describe('rules/*.json: pattern dialect lint', () => {
  for (const pack of packs.values()) {
    for (const rule of pack.rules) {
      it(`${rule.id} parses in ECMAScript with its declared flags`, () => {
        expect(() => new RegExp(rule.pattern, rule.flags)).not.toThrow();
      });

      it(`${rule.id} keeps flags in the flags field (no inline flag groups)`, () => {
        // (?i), (?im), (?i:...), (?-s:...) style groups; every legit
        // ECMAScript group has a non-letter right after "(?".
        expect(rule.pattern).not.toMatch(/\(\?[a-zA-Z]+[-:)]/);
        expect(rule.flags).toMatch(/^g[imsuy]*$/);
      });

      it(`${rule.id} avoids lookbehind unless grandfathered`, () => {
        const hasLookbehind = /\(\?</.test(rule.pattern.replace(/\(\?<[a-zA-Z]/g, ''));
        if (LOOKBEHIND_GRANDFATHERED.has(rule.id)) return;
        expect(hasLookbehind, `${rule.id} uses lookbehind`).toBe(false);
      });
    }
  }
});

// ── Generated module sync ───────────────────────────────────

describe('rules.data.ts', () => {
  it('is exactly what generate-rules-module.mjs renders from rules/*.json', () => {
    const onDisk = readFileSync(join(ROOT, 'src', 'regex', 'rules.data.ts'), 'utf8');
    expect(onDisk).toBe(render());
  });

  it('embeds all 18 packs in the canonical order', () => {
    expect(RULES_DATA.map((p) => p.region)).toEqual([
      'universal', 'gb', 'pl', 'de', 'fr', 'es', 'pt', 'se', 'no',
      'it', 'nl', 'be', 'at', 'ch', 'ie', 'dk', 'fi', 'us',
    ]);
  });
});

// ── Loader failure modes ────────────────────────────────────

describe('loader', () => {
  const rule = {
    id: 'regex:zz:test',
    entityType: 'OTHER' as const,
    pattern: '\\d+',
    flags: 'g',
    confidence: 0.5,
    domains: ['general' as const],
    description: 'test rule',
  };

  it('throws on an unknown validator name', () => {
    expect(() =>
      loadRegexRules([{ region: 'zz', rules: [{ ...rule, validate: 'noSuchValidator' }] }]),
    ).toThrow(/unknown validator "noSuchValidator"/);
  });

  it('throws on a pattern that does not compile', () => {
    expect(() =>
      loadRegexRules([{ region: 'zz', rules: [{ ...rule, pattern: '(unclosed' }] }]),
    ).toThrow(/does not compile/);
  });
});

// ── Metadata parity with the pre-T018 TS modules ────────────

interface BaselineRule {
  id: string;
  entityType: string;
  pattern: string;
  flags: string;
  confidence: number;
  domains: string[];
  description: string;
  examples?: string[];
  falsePositiveNotes?: string;
  validate?: string;
  region: string;
}

describe('metadata parity with pre-T018 exports', () => {
  const baseline: BaselineRule[] = JSON.parse(
    readFileSync(join(ROOT, 'tests', 'regex', 'fixtures', 'metadata-baseline.json'), 'utf8'),
  );

  it('rule count and order are unchanged', () => {
    expect(ALL_REGEX_RULES.map((r) => r.detector)).toEqual(baseline.map((b) => b.id));
  });

  baseline.forEach((expected, i) => {
    it(`${expected.id}: all metadata identical`, () => {
      const actual = ALL_REGEX_RULES[i];
      expect(actual.detector).toBe(expected.id);
      expect(actual.type).toBe(expected.entityType);
      expect(actual.pattern.source).toBe(expected.pattern);
      expect(actual.pattern.flags).toBe(expected.flags);
      expect(actual.confidence).toBe(expected.confidence);
      expect(actual.region).toBe(expected.region);
      expect(actual.domains).toEqual(expected.domains);
      expect(actual.description).toBe(expected.description);
      expect(actual.examples).toEqual(expected.examples);
      expect(actual.falsePositiveNotes).toBe(expected.falsePositiveNotes);
      if (expected.validate !== undefined) {
        // Same registry function, not merely "some" validator
        expect(actual.validate).toBe(VALIDATORS[expected.validate]);
      } else {
        expect(actual.validate).toBeUndefined();
      }
    });
  });
});
