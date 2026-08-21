/**
 * T101 US region pack tests: SSN structural-invalidity rules (000/666/9xx
 * area, 00 group, 0000 serial), the SSN/ITIN 9xx-area disambiguation, EIN
 * valid-prefix classes, the ABA routing 3-7-1 checksum and DEA/NPI
 * validators, and the US surrogate stand-ins (never-issued 9xx SSN areas
 * with non-ITIN groups, never-assigned EIN prefixes, checksum-valid
 * 99-prefixed routing numbers).
 */
import { describe, it, expect } from 'vitest';
import { ALL_REGEX_RULES, REGEX_REGIONS } from '../../src/regex/index.ts';
import { VALIDATORS } from '../../src/regex/validators.ts';
import { generateSurrogate } from '../../src/surrogates.ts';
import type { SurrogateContext } from '../../src/surrogates.ts';

const aba = VALIDATORS.aba;
const dea = VALIDATORS.dea;
const npi = VALIDATORS.npi;

const ctx: SurrogateContext = { salt: 'test-salt-t101' };

function findRule(id: string) {
  const rule = ALL_REGEX_RULES.find((r) => r.detector === id);
  if (!rule) throw new Error(`rule ${id} not found`);
  return rule;
}

function ruleMatches(id: string, value: string): boolean {
  const rule = findRule(id);
  rule.pattern.lastIndex = 0;
  return rule.pattern.exec(value) !== null;
}

/** Independent 3-7-1 checksum reimplementation for stand-in proofs. */
function abaIsValid(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 9) return false;
  const n = d.split('').map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

/** The IRS ITIN group ranges (4th-5th digits): 50-65, 70-88, 90-92, 94-99. */
function isItinGroup(group: number): boolean {
  return (
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    (group >= 94 && group <= 99)
  );
}

describe('aba validator (3-7-1 weighted mod-10 checksum)', () => {
  it('accepts checksum-valid routing numbers', () => {
    expect(aba('021000021')).toBe(true); // rule example
    expect(aba('011000015')).toBe(true); // rule example
    expect(aba('026009593')).toBe(true);
  });

  it('rejects an off-by-one check digit (near-miss negatives)', () => {
    expect(aba('021000022')).toBe(false);
    expect(aba('011000016')).toBe(false);
    expect(aba('026009594')).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(aba('02100002')).toBe(false);
    expect(aba('0210000210')).toBe(false);
  });
});

describe('dea validator (registrant checksum)', () => {
  it('accepts checksum-valid DEA numbers', () => {
    expect(dea('BJ1234563')).toBe(true); // (1+3+5) + 2*(2+4+6) = 33 -> 3
    expect(dea('AS9876547')).toBe(true); // (9+7+5) + 2*(8+6+4) = 57 -> 7
  });

  it('rejects a wrong check digit (near-miss negative)', () => {
    expect(dea('BJ1234567')).toBe(false);
    expect(dea('AS9876540')).toBe(false);
  });

  it('rejects invalid registrant-type first letters', () => {
    for (const first of ['I', 'N', 'O', 'Q', 'V', 'Z']) {
      expect(dea(`${first}J1234563`), first).toBe(false);
    }
  });
});

describe('npi validator (Luhn over the 80840 prefix)', () => {
  it('accepts the CMS example NPI', () => {
    expect(npi('1234567893')).toBe(true); // rule example
  });

  it('rejects every other final digit (near-miss negatives)', () => {
    for (let final = 0; final <= 9; final++) {
      if (final === 3) continue;
      expect(npi(`123456789${final}`), String(final)).toBe(false);
    }
  });

  it('rejects wrong lengths', () => {
    expect(npi('123456789')).toBe(false);
    expect(npi('12345678931')).toBe(false);
  });
});

describe('us:ssn structural invalidity rules', () => {
  it('matches SSA-valid hyphenated SSNs', () => {
    expect(ruleMatches('regex:us:ssn', '123-45-6789')).toBe(true);
    expect(ruleMatches('regex:us:ssn', '001-01-0001')).toBe(true);
    expect(ruleMatches('regex:us:ssn', '899-99-9999')).toBe(true);
  });

  it('rejects the never-issued areas 000, 666, and 900-999', () => {
    expect(ruleMatches('regex:us:ssn', '000-12-3456')).toBe(false);
    expect(ruleMatches('regex:us:ssn', '666-12-3456')).toBe(false);
    expect(ruleMatches('regex:us:ssn', '900-12-3456')).toBe(false);
    expect(ruleMatches('regex:us:ssn', '999-12-3456')).toBe(false);
  });

  it('rejects the 00 group and the 0000 serial', () => {
    expect(ruleMatches('regex:us:ssn', '123-00-4567')).toBe(false);
    expect(ruleMatches('regex:us:ssn', '123-45-0000')).toBe(false);
  });
});

describe('us:itin / us:ssn disambiguation (overlapping 9-digit shapes)', () => {
  it('an ITIN (9xx area, valid group) matches only the itin rule', () => {
    expect(ruleMatches('regex:us:itin', '912-70-1234')).toBe(true);
    expect(ruleMatches('regex:us:ssn', '912-70-1234')).toBe(false);
  });

  it('an SSN never matches the itin rule (itin requires a 9xx area)', () => {
    expect(ruleMatches('regex:us:itin', '123-45-6789')).toBe(false);
  });

  it('a 9xx area with a non-ITIN group matches neither rule', () => {
    for (const value of ['912-45-1234', '912-66-1234', '912-89-1234', '912-93-1234']) {
      expect(ruleMatches('regex:us:ssn', value), value).toBe(false);
      expect(ruleMatches('regex:us:itin', value), value).toBe(false);
    }
  });

  it('the itin rule covers every valid group range boundary', () => {
    for (const group of ['50', '65', '70', '88', '90', '92', '94', '99']) {
      expect(ruleMatches('regex:us:itin', `912-${group}-1234`), group).toBe(true);
    }
  });
});

describe('us:ein valid-prefix classes', () => {
  it('matches EINs with assigned campus prefixes', () => {
    expect(ruleMatches('regex:us:ein', '12-3456789')).toBe(true);
    expect(ruleMatches('regex:us:ein', '01-2345678')).toBe(true);
    expect(ruleMatches('regex:us:ein', '98-7654321')).toBe(true);
  });

  it('rejects never-assigned campus prefixes', () => {
    for (const prefix of ['00', '07', '08', '09', '17', '19', '28', '49', '69', '70', '78', '89', '96', '97']) {
      expect(ruleMatches('regex:us:ein', `${prefix}-1234567`), prefix).toBe(false);
    }
  });
});

describe('us:routing prefix classes', () => {
  it('rejects prefixes outside the assigned 00-12/21-32/61-72/80 ranges', () => {
    for (const value of ['131000025', '330000025', '600000025', '810000025', '990000021']) {
      expect(ruleMatches('regex:us:routing', value), value).toBe(false);
    }
  });
});

describe('us rules wiring', () => {
  it('the us pack ships SSN, ITIN, EIN, routing, DEA, and NPI detectors', () => {
    const usIds = new Set(
      ALL_REGEX_RULES.filter((r) => r.region === 'us').map((r) => r.detector),
    );
    for (const id of [
      'regex:us:ssn', 'regex:us:itin', 'regex:us:ein',
      'regex:us:routing', 'regex:us:dea', 'regex:us:npi',
    ]) {
      expect(usIds.has(id), id).toBe(true);
    }
  });

  it('us is selectable in the region picker list', () => {
    expect(REGEX_REGIONS.includes('us')).toBe(true);
  });
});

describe('US surrogate stand-ins', () => {
  it('SSN stand-ins keep the 3-2-4 shape and use a never-issued 9xx area', () => {
    const out = generateSurrogate('123-45-6789', 'SSN', ctx);
    expect(out).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
    expect(out).not.toBe('123-45-6789');
  });

  it('SSN stand-ins are provably neither an SSN nor an ITIN', () => {
    for (const original of ['123-45-6789', '078-05-1120', '532-88-1421']) {
      const out = generateSurrogate(original, 'SSN', ctx);
      const group = Number(out.slice(4, 6));
      expect(isItinGroup(group), out).toBe(false);
      expect(group).toBeGreaterThanOrEqual(1); // 00 is not a real-looking group
      expect(ruleMatches('regex:us:ssn', out), out).toBe(false);
      expect(ruleMatches('regex:us:itin', out), out).toBe(false);
    }
  });

  it('bare 9-digit SSN shapes get the same 9xx + non-ITIN-group guarantee', () => {
    const out = generateSurrogate('123456789', 'SSN', ctx);
    expect(out).toMatch(/^9\d{8}$/);
    expect(isItinGroup(Number(out.slice(3, 5)))).toBe(false);
  });

  it('EIN stand-ins keep the 2-7 shape and use a never-assigned prefix', () => {
    const unassigned = new Set([
      '07', '08', '09', '17', '18', '19', '28', '29',
      '49', '69', '70', '78', '79', '89', '96', '97',
    ]);
    for (const original of ['12-3456789', '87-6543210']) {
      const out = generateSurrogate(original, 'SSN', ctx);
      expect(out).toMatch(/^\d{2}-\d{7}$/);
      expect(unassigned.has(out.slice(0, 2)), out).toBe(true);
      expect(ruleMatches('regex:us:ein', out), out).toBe(false);
    }
  });

  it('routing stand-ins pass the ABA checksum but use the never-assigned 99 prefix', () => {
    for (const original of ['021000021', '011000015', '026009593']) {
      const out = generateSurrogate(original, 'OTHER', ctx);
      expect(out).toMatch(/^99\d{7}$/);
      expect(out).not.toBe(original);
      expect(abaIsValid(out), out).toBe(true);
      expect(aba(out), out).toBe(true);
      // The 99 prefix sits outside every assigned range, so the routing
      // rule itself refuses the stand-in: provably never a real number.
      expect(ruleMatches('regex:us:routing', out), out).toBe(false);
    }
  });

  it('OTHER values that are not checksum-valid routing numbers keep same-shape treatment', () => {
    // 123456789 fails the 3-7-1 checksum (sum 159), so no 99 forcing.
    expect(generateSurrogate('123456789', 'OTHER', ctx)).toMatch(/^\d{9}$/);
    expect(generateSurrogate('REF-1234', 'OTHER', ctx)).toMatch(/^[A-Z]{3}-\d{4}$/);
  });

  it('US surrogates are deterministic per salt', () => {
    expect(generateSurrogate('123-45-6789', 'SSN', ctx))
      .toBe(generateSurrogate('123-45-6789', 'SSN', ctx));
    expect(generateSurrogate('021000021', 'OTHER', ctx))
      .toBe(generateSurrogate('021000021', 'OTHER', ctx));
    const other: SurrogateContext = { salt: 'another-salt' };
    expect(generateSurrogate('123-45-6789', 'SSN', other))
      .not.toBe(generateSurrogate('123-45-6789', 'SSN', ctx));
  });
});
