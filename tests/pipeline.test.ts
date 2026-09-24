import { describe, it, expect } from 'vitest';
import type { DetectedEntity } from '../src/types.ts';
import {
  trimSpanPunctuation,
  detectWithRegex,
  resolveOverlaps,
  filterFalsePositives,
  propagateEntities,
  detectEntities,
  PERSON_SHORT_STOPLIST,
  COMMON_WORD_NAMES,
} from '../src/pipeline.ts';

// Cross-checked against DocCloak.Cli/doccloak/core/engine.py, which
// implements the same algorithms (propagation confidence 0.95, term
// thresholds >= 2 whole value / >= 4 word part, start -> longer ->
// confidence overlap ordering). T181 (security pass 2026-09) lowered the
// whole-value threshold from 3 to 2 and made the false-positive filter
// script-aware; engine.py is reconciled separately.

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
  it('drops non-PERSON values whose trimmed length is below 3', () => {
    const short = entity('XY', 0, { type: 'OTHER' });
    const padded = entity(' A ', 10, { type: 'COMPANY' });
    const kept = entity('Ann', 20, { type: 'OTHER' });
    expect(filterFalsePositives([short, padded, kept])).toEqual([kept]);
  });

  it('keeps everything at length 3 or more', () => {
    const three = entity('Ann', 0);
    const long = entity('Annabel', 10);
    const other = entity('Acme', 20, { type: 'COMPANY' });
    expect(filterFalsePositives([three, long, other])).toEqual([three, long, other]);
  });

  it('keeps two-character Latin PERSON values (R2)', () => {
    const names = ['Li', 'Ng', 'Bo', 'Al'].map((v, i) => entity(v, i * 10));
    expect(filterFalsePositives(names)).toEqual(names);
  });

  it('keeps initials like "J." as PERSON', () => {
    const initial = entity('J.', 0);
    expect(filterFalsePositives([initial])).toEqual([initial]);
  });

  it('rejects one-character PERSON values and the two-letter title/suffix stoplist', () => {
    const rejected = ['a', 'x', 'Mr', 'Dr', 'MS', 'jr', 'Sr', 'St', 'II', 'IV', 'VI', 'No', 'Re', 'CC']
      .map((v, i) => entity(v, i * 10));
    expect(filterFalsePositives(rejected)).toEqual([]);
    expect([...PERSON_SHORT_STOPLIST].sort()).toEqual(
      ['cc', 'dr', 'ii', 'iv', 'jr', 'mr', 'ms', 'no', 're', 'sr', 'st', 'vi'],
    );
  });

  it('keeps two-character CJK values for every type and rejects single characters', () => {
    const han = entity('王伟', 0);
    const han2 = entity('李娜', 10);
    const hangul = entity('김민', 20, { type: 'OTHER' });
    const kana = entity('さくら', 30, { type: 'COMPANY' });
    const thai = entity('สม', 40, { type: 'OTHER' });
    const single = entity('王', 50);
    const singleOther = entity('李', 60, { type: 'OTHER' });
    expect(filterFalsePositives([han, han2, hangul, kana, thai, single, singleOther]))
      .toEqual([han, han2, hangul, kana, thai]);
  });

  it('still drops two-character non-PERSON Latin values', () => {
    expect(filterFalsePositives([entity('XY', 0, { type: 'OTHER' }), entity('ab', 5, { type: 'COMPANY' })])).toEqual([]);
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

  it('propagates two-character values with exact case only', () => {
    const text = 'Jo met Al. Then Jo and Al left, jo and AL stayed.';
    const detected = [entity('Jo', 0), entity('Al', 7)];
    const result = propagateEntities(text, detected);
    expect(result.map((e) => [e.value, e.start])).toEqual([['Jo', 16], ['Al', 23]]);
  });

  it('never propagates one-character values', () => {
    const text = 'X met Y. Then X and Y left.';
    const detected = [entity('X', 0), entity('Y', 6)];
    expect(propagateEntities(text, detected)).toEqual([]);
  });

  it('does not match a two-character term inside a longer word (Li vs Lisbon)', () => {
    const text = 'Li flew to Lisbon. Li liked Lisbon and Li returned.';
    const detected = [entity('Li', 0)];
    const result = propagateEntities(text, detected);
    expect(result.map((e) => e.start)).toEqual([19, 39]);
    expect(result.every((e) => e.value === 'Li')).toBe(true);
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
    const text = 'Mr saw XY happen.';
    // "Mr" is on the two-letter PERSON stoplist: filtered as an ML entity.
    const ml = [entity('Mr', 0)];
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

// ── T181: propagation boundaries, case handling, offsets ──

describe('propagateEntities (T181 boundaries and case)', () => {
  function at(text: string, value: string, occurrence = 0): number {
    let idx = -1;
    let from = 0;
    for (let n = 0; n <= occurrence; n++) {
      idx = text.indexOf(value, from);
      if (idx === -1) throw new Error(`"${value}" occurrence ${occurrence} not in text`);
      from = idx + 1;
    }
    return idx;
  }

  it('skips a lowercase common-word mention of a PERSON: "Bill paid the bill" yields one replacement', () => {
    const text = 'Bill paid the bill yesterday.';
    const detected = [entity('Bill', 0)];
    expect(propagateEntities(text, detected)).toEqual([]);
    const result = detectEntities(text, detected, []);
    expect(result.filter((e) => e.type === 'PERSON')).toHaveLength(1);
  });

  it('applies the common-word guard to word parts of multi-word names', () => {
    const text = 'Mark Green signed. Please mark the box and Green-light it.';
    const detected = [entity('Mark Green', 0)];
    const values = propagateEntities(text, detected).map((e) => e.value);
    // "mark" is lowercase and a common word: skipped. "Green" is capitalised:
    // propagated. (The sub-spans inside the original detection are re-emitted
    // as in the pre-T181 behaviour and dropped later by resolveOverlaps.)
    expect(values).not.toContain('mark');
    expect(values.filter((v) => v === 'Green')).toHaveLength(2);
  });

  it('still propagates lowercase mentions of ordinary names ("thanks john"; golden prop-03)', () => {
    const text = 'John Smith fixed it, thanks john. And thanks smith too.';
    const detected = [entity('John Smith', 0)];
    const result = propagateEntities(text, detected);
    expect(result).toContainEqual({
      type: 'PERSON', value: 'john', start: at(text, 'john'), end: at(text, 'john') + 4, confidence: 0.95, detector: 'propagated',
    });
    expect(result).toContainEqual({
      type: 'PERSON', value: 'smith', start: at(text, 'smith'), end: at(text, 'smith') + 5, confidence: 0.95, detector: 'propagated',
    });
  });

  it('propagates ALL-CAPS and Capitalised variants of a common-word name', () => {
    const text = 'Bill signed. BILL countersigned. Later Bill left and Mark arrived; mark arrived too.';
    const detected = [entity('Bill', 0), entity('Mark', at(text, 'Mark'))];
    const values = propagateEntities(text, detected).map((e) => e.value);
    expect(values).toEqual(['BILL', 'Bill']);
  });

  it('propagates an ALL-CAPS variant of a full name', () => {
    const text = 'John Smith signed here. JOHN SMITH countersigned.';
    const detected = [entity('John Smith', 0)];
    const result = propagateEntities(text, detected);
    expect(result).toContainEqual({
      type: 'PERSON', value: 'JOHN SMITH', start: at(text, 'JOHN SMITH'), end: at(text, 'JOHN SMITH') + 10, confidence: 0.95, detector: 'propagated',
    });
  });

  it('does not apply the common-word guard to non-PERSON types', () => {
    const text = 'Rose Ltd hired. Contact rose ltd now.';
    const detected = [entity('Rose Ltd', 0, { type: 'COMPANY', detector: 'gliner:company' })];
    const values = propagateEntities(text, detected).map((e) => e.value);
    expect(values).toContain('rose ltd');
  });

  it('exposes the per-language common-word lists (EN list as specified)', () => {
    expect(COMMON_WORD_NAMES.en).toEqual([
      'bill', 'mark', 'will', 'may', 'art', 'grace', 'hope', 'rose', 'jack', 'sue',
      'pat', 'chase', 'dawn', 'june', 'carol', 'guy', 'rich', 'frank', 'ray', 'don',
      'bob', 'jay', 'gene',
    ]);
    expect(COMMON_WORD_NAMES.pl.length).toBeGreaterThan(0);
    expect(COMMON_WORD_NAMES.de.length).toBeGreaterThan(0);
    for (const list of Object.values(COMMON_WORD_NAMES)) {
      for (const word of list) expect(word).toBe(word.toLowerCase());
    }
  });

  it('applies the PL and DE lists to lowercase mentions', () => {
    const text = 'Adam Lis wrote. Then the lis (a fox) ran. Karl Klein wrote; a klein detail.';
    const detected = [entity('Adam Lis', 0), entity('Karl Klein', at(text, 'Karl Klein'))];
    const values = propagateEntities(text, detected).map((e) => e.value);
    expect(values).not.toContain('lis');
    expect(values).not.toContain('klein');
  });

  it('keeps exact offsets after Turkish dotted İ (R8)', () => {
    const text = 'İstanbul İzmir İçel: Jan Kowalski. Later Kowalski and jan kowalski again.';
    const detected = [entity('Jan Kowalski', at(text, 'Jan Kowalski'))];
    const result = propagateEntities(text, detected);
    for (const e of result) {
      expect(text.slice(e.start, e.end)).toBe(e.value);
    }
    expect(result.map((e) => [e.value, e.start])).toEqual([
      ['jan kowalski', at(text, 'jan kowalski')],
      // word-part sub-span inside the original detection (dropped later by resolveOverlaps)
      ['Kowalski', at(text, 'Kowalski', 0)],
      ['Kowalski', at(text, 'Kowalski', 1)],
      ['kowalski', at(text, 'kowalski')],
    ]);
  });

  it('treats typographic quotes, markdown and brackets as boundaries (R8)', () => {
    const text = 'Łukasz here. „Łukasz” *Łukasz* _Łukasz_ [Łukasz] <Łukasz> «Łukasz» #Łukasz @Łukasz';
    const detected = [entity('Łukasz', 0)];
    const result = propagateEntities(text, detected);
    expect(result).toHaveLength(8);
    expect(result.every((e) => e.value === 'Łukasz')).toBe(true);
  });

  it('uses Unicode letters and digits as non-boundaries', () => {
    const text = 'Anna met Annaé and Anna1 and ÉAnna and Anna.';
    const detected = [entity('Anna', 0)];
    const result = propagateEntities(text, detected);
    expect(result.map((e) => e.start)).toEqual([at(text, 'Anna', 4)]);
  });

  it('propagates CJK names glued to surrounding characters', () => {
    const text = '王伟：会议由王伟主持，李娜记录。李娜同意。';
    const detected = [entity('王伟', 0), entity('李娜', at(text, '李娜'))];
    const result = propagateEntities(text, detected);
    expect(result.map((e) => [e.value, e.start])).toEqual([
      ['王伟', at(text, '王伟', 1)],
      ['李娜', at(text, '李娜', 1)],
    ]);
  });

  it('escapes regex metacharacters in terms', () => {
    const text = 'Acme (EU) Ltd. signed. Acme (EU) Ltd. again.';
    const detected = [entity('Acme (EU) Ltd.', 0, { type: 'COMPANY', detector: 'gliner:company' })];
    const result = propagateEntities(text, detected);
    expect(result.some((e) => e.value === 'Acme (EU) Ltd.' && e.start === at(text, 'Acme (EU) Ltd.', 1))).toBe(true);
  });
});

// ── T181: Unicode-aware ends of postal/city rules (R10) ────

describe('detectWithRegex postal rules end on non-ASCII letters (R10)', () => {
  const cases: Array<[string, string, string]> = [
    ['00-950 Łódź', 'pl', '00-950 Łódź'],
    ['89-100 Nakło nad Notecią', 'pl', '89-100 Nakło nad Notecią'],
    ['43-300 Bielsko-Biała', 'pl', '43-300 Bielsko-Biała'],
    ['211 22 Malmö', 'se', '211 22 Malmö'],
    ['80331 München', 'de', '80331 München'],
    ['1000 Bruxelles-Capitale', 'be', '1000 Bruxelles-Capitale'],
  ];
  for (const [text, region, expected] of cases) {
    it(`"${text}" (${region}) is matched in full`, () => {
      const found = detectWithRegex(`Adres: ${text}, dalej.`, region);
      const address = found.filter((e) => e.type === 'ADDRESS').map((e) => e.value);
      expect(address).toContain(expected);
      expect(address.some((v) => v.endsWith(expected.slice(0, -1)) && v !== expected)).toBe(false);
    });
  }

  it('does not end a postal match on whitespace before punctuation', () => {
    const found = detectWithRegex('Adresse: 10115 Berlin (Mitte), Deutschland', 'de');
    const values = found.filter((e) => e.type === 'ADDRESS').map((e) => e.value);
    expect(values).toContain('10115 Berlin');
    expect(values.some((v) => /\s$/.test(v))).toBe(false);
  });
});

describe('trimSpanPunctuation (T204)', () => {
  const e = (value: string, start: number, type: DetectedEntity['type'] = 'PERSON'): DetectedEntity =>
    ({ type, value, start, end: start + value.length, confidence: 0.9, detector: 'bardsai:PERSON' });

  it('drops a trailing comma, period or closing bracket and moves end', () => {
    const [a, b, c] = trimSpanPunctuation([e('Anna Nowak,', 14), e('jan@example.com.', 40, 'EMAIL'), e('(Warszawa)', 70, 'ADDRESS')]);
    expect(a).toMatchObject({ value: 'Anna Nowak', start: 14, end: 24 });
    expect(b).toMatchObject({ value: 'jan@example.com', start: 40, end: 55 });
    expect(c).toMatchObject({ value: 'Warszawa', start: 71, end: 79 });
  });

  it('keeps inner punctuation and abbreviations that end before the boundary', () => {
    const [a] = trimSpanPunctuation([e('Kowalski Sp. z o.o.,', 0, 'COMPANY')]);
    expect(a.value).toBe('Kowalski Sp. z o.o');
    const [b] = trimSpanPunctuation([e('Anna Nowak', 3)]);
    expect(b).toMatchObject({ value: 'Anna Nowak', start: 3, end: 13 });
  });

  it('drops a span that is punctuation only', () => {
    expect(trimSpanPunctuation([e(',', 5), e('...', 9)])).toEqual([]);
  });

  it('applies to ML spans inside detectEntities but not to regex spans', () => {
    const text = 'Umowa: Anna Nowak, PESEL 85010212345.';
    const ml = [e('Anna Nowak,', 7)];
    const regex: DetectedEntity[] = [{ type: 'SSN', value: '85010212345', start: 25, end: 36, confidence: 1, detector: 'regex:pl:pesel' }];
    const out = detectEntities(text, ml, regex);
    expect(out.map((x) => x.value)).toEqual(['Anna Nowak', '85010212345']);
    expect(text.slice(out[0].start, out[0].end)).toBe('Anna Nowak');
  });
});
