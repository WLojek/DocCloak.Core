import { describe, it, expect } from 'vitest';
import type { DetectedEntity } from '../src/types.ts';
import {
  detectWithRegex,
  resolveOverlaps,
  filterFalsePositives,
  propagateEntities,
  detectEntities,
} from '../src/pipeline.ts';

// Cross-checked against DocCloak.Cli/doccloak/core/engine.py, which
// implements the same algorithms (propagation confidence 0.95, term
// thresholds >= 3 whole value / >= 4 word part, start -> longer ->
// confidence overlap ordering).

function entity(
  value: string,
  start: number,
  overrides: Partial<DetectedEntity> = {},
): DetectedEntity {
  return {
    type: 'PERSON',
    value,
    start,
    end: start + value.length,
    confidence: 0.9,
    detector: 'gliner:person',
    ...overrides,
  };
}

// ── resolveOverlaps ────────────────────────────────────────

describe('resolveOverlaps', () => {
  it('keeps non-overlapping entities and sorts them by start', () => {
    const b = entity('Bob', 20);
    const a = entity('Alice', 0);
    const result = resolveOverlaps([b, a]);
    expect(result).toEqual([a, b]);
  });

  it('prefers the earlier start among overlapping entities', () => {
    const early = entity('John Sm', 0);
    const late = entity('Smith', 5, { confidence: 0.99 });
    expect(resolveOverlaps([late, early])).toEqual([early]);
  });

  it('prefers the longer span when starts are equal', () => {
    const short = entity('John', 0, { confidence: 0.99 });
    const long = entity('John Smith', 0, { confidence: 0.5 });
    expect(resolveOverlaps([short, long])).toEqual([long]);
  });

  it('prefers higher confidence when start and length are equal', () => {
    const low = entity('John', 0, { confidence: 0.6, detector: 'a' });
    const high = entity('John', 0, { confidence: 0.8, detector: 'b' });
    expect(resolveOverlaps([low, high])).toEqual([high]);
  });

  it('allows adjacent (touching, non-overlapping) entities', () => {
    const first = entity('John', 0);
    const second = entity('Smith', 4);
    expect(resolveOverlaps([second, first])).toEqual([first, second]);
  });
});

// ── filterFalsePositives ───────────────────────────────────

describe('filterFalsePositives', () => {
  it('drops values whose trimmed length is below 3', () => {
    const short = entity('Jo', 0);
    const padded = entity(' A ', 10);
    const kept = entity('Ann', 20);
    expect(filterFalsePositives([short, padded, kept])).toEqual([kept]);
  });

  it('keeps everything at length 3 or more', () => {
    const three = entity('Ann', 0);
    const long = entity('Annabel', 10);
    expect(filterFalsePositives([three, long])).toEqual([three, long]);
  });
});

// ── propagateEntities ──────────────────────────────────────

describe('propagateEntities', () => {
  it('propagates a whole value of >= 3 chars with confidence 0.95 and detector "propagated"', () => {
    const text = 'Ann wrote a memo. Later Ann signed it.';
    const detected = [entity('Ann', 0)];
    const result = propagateEntities(text, detected);
    expect(result).toEqual([
      {
        type: 'PERSON',
        value: 'Ann',
        start: 24,
        end: 27,
        confidence: 0.95,
        detector: 'propagated',
      },
    ]);
  });

  it('does not propagate values shorter than 3 chars', () => {
    const text = 'Jo met Al. Then Jo and Al left.';
    const detected = [entity('Jo', 0), entity('Al', 7)];
    expect(propagateEntities(text, detected)).toEqual([]);
  });

  it('propagates word parts of a multi-word value only when >= 4 chars', () => {
    // "Jan" (3 chars) is below the 4-char word-part threshold; "Kowalski" is not.
    const text = 'Jan Kowalski met Jan and Kowalski.';
    const detected = [entity('Jan Kowalski', 0)];
    const result = propagateEntities(text, detected);
    // Note: the word-part term also re-emits the "Kowalski" sub-span inside
    // the original detection (4:12 differs from the seen key 0:12); the final
    // resolveOverlaps pass in detectEntities drops that one. engine.py
    // behaves identically.
    expect(result).toEqual([
      {
        type: 'PERSON',
        value: 'Kowalski',
        start: 4,
        end: 12,
        confidence: 0.95,
        detector: 'propagated',
      },
      {
        type: 'PERSON',
        value: 'Kowalski',
        start: 25,
        end: 33,
        confidence: 0.95,
        detector: 'propagated',
      },
    ]);
    // Standalone "Jan" (below the 4-char word-part threshold) is never a term.
    expect(result.some((e) => e.value === 'Jan')).toBe(false);
  });

  it('strips trailing punctuation from word parts before propagating', () => {
    const text = 'Acme Corp. hired. Corp announced.';
    const detected = [entity('Acme Corp.', 0, { type: 'COMPANY', detector: 'gliner:company' })];
    const result = propagateEntities(text, detected);
    expect(result).toContainEqual({
      type: 'COMPANY',
      value: 'Corp',
      start: 18,
      end: 22,
      confidence: 0.95,
      detector: 'propagated',
    });
  });

  it('requires word boundaries: no match inside a larger word', () => {
    const text = 'Ann met Joanna and Annette.';
    const detected = [entity('Ann', 0)];
    // "ann" occurs inside "Joanna" and "Annette" but neither is boundary-delimited.
    expect(propagateEntities(text, detected)).toEqual([]);
  });

  it('treats punctuation and dashes as boundaries', () => {
    const text = 'Smith wrote it. Smith-Jones (Smith) "Smith" x';
    const detected = [entity('Smith', 0)];
    const starts = propagateEntities(text, detected).map((e) => e.start);
    expect(starts).toEqual([16, 29, 37]);
  });

  it('matches case-insensitively but keeps the original text slice as value', () => {
    const text = 'KOWALSKI called. Kowalski answered.';
    const detected = [entity('Kowalski', 17)];
    const result = propagateEntities(text, detected);
    expect(result).toEqual([
      {
        type: 'PERSON',
        value: 'KOWALSKI',
        start: 0,
        end: 8,
        confidence: 0.95,
        detector: 'propagated',
      },
    ]);
  });

  it('does not re-emit spans already detected', () => {
    const text = 'Ann and Ann';
    const detected = [entity('Ann', 0), entity('Ann', 8)];
    expect(propagateEntities(text, detected)).toEqual([]);
  });
});

// ── detectWithRegex ────────────────────────────────────────

describe('detectWithRegex', () => {
  const email = 'Mail john@example.com today.';
  // Valid PESEL: weighted checksum of 4405140135 yields check digit 9.
  const pesel = 'PESEL: 44051401359.';

  it('detects a universal rule with span, confidence and detector from the rule', () => {
    const result = detectWithRegex(email);
    expect(result).toContainEqual({
      type: 'EMAIL',
      value: 'john@example.com',
      start: 5,
      end: 21,
      confidence: 0.95,
      detector: 'regex:universal:email',
    });
  });

  it('applies validators (invalid PESEL checksum is rejected)', () => {
    const result = detectWithRegex('PESEL: 44051401358.', 'pl');
    expect(result.some((e) => e.detector === 'regex:pl:pesel')).toBe(false);
  });

  it('includes regional rules for the matching region and for "all"', () => {
    for (const region of ['pl', 'all']) {
      const result = detectWithRegex(pesel, region);
      expect(result).toContainEqual({
        type: 'SSN',
        value: '44051401359',
        start: 7,
        end: 18,
        confidence: 0.9,
        detector: 'regex:pl:pesel',
      });
    }
  });

  it('excludes other regions but keeps universal rules', () => {
    const result = detectWithRegex(`${email} ${pesel}`, 'gb');
    expect(result.some((e) => e.detector === 'regex:pl:pesel')).toBe(false);
    expect(result.some((e) => e.detector === 'regex:universal:email')).toBe(true);
  });
});

// ── detectEntities (pure merge) ────────────────────────────

describe('detectEntities', () => {
  it('returns [] for blank text', () => {
    expect(detectEntities('   ', [entity('Ann', 0)], [])).toEqual([]);
  });

  it('merges ML and regex results, resolves overlaps and propagates', () => {
    const text = 'Contact John Smith at john@example.com. Smith called again.';
    const ml = [entity('John Smith', 8)];
    const regex = detectWithRegex(text);
    const result = detectEntities(text, ml, regex);

    expect(result).toEqual([
      entity('John Smith', 8),
      {
        type: 'EMAIL',
        value: 'john@example.com',
        start: 22,
        end: 38,
        confidence: 0.95,
        detector: 'regex:universal:email',
      },
      {
        type: 'PERSON',
        value: 'Smith',
        start: 40,
        end: 45,
        confidence: 0.95,
        detector: 'propagated',
      },
    ]);
  });

  it('applies the false-positive filter to ML entities only', () => {
    const text = 'Jo saw XY happen.';
    const ml = [entity('Jo', 0)];
    // Synthetic 2-char regex entity: the filter must not touch it.
    const regex = [entity('XY', 7, { type: 'OTHER', confidence: 0.8, detector: 'regex:test' })];
    const result = detectEntities(text, ml, regex);
    expect(result).toEqual(regex);
  });

  it('drops overlapping duplicates between ML and regex (same span, higher confidence wins)', () => {
    const text = 'Reach me: john@example.com';
    const ml = [
      entity('john@example.com', 10, { type: 'OTHER', confidence: 0.6, detector: 'gliner:other' }),
    ];
    const regex = detectWithRegex(text);
    const result = detectEntities(text, ml, regex);
    expect(result).toEqual([
      {
        type: 'EMAIL',
        value: 'john@example.com',
        start: 10,
        end: 26,
        confidence: 0.95,
        detector: 'regex:universal:email',
      },
    ]);
  });
});
