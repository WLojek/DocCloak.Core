/**
 * T100 UK region pack tests: NINO prefix rules (including the near-miss
 * prefixes HMRC excludes), the NHS mod-11 check digit, the best-effort
 * driving licence date-block validator, and the UK surrogate stand-ins
 * (checksum-valid 999-range NHS numbers, QQ-prefixed NINOs).
 */
import { describe, it, expect } from 'vitest';
import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { VALIDATORS } from '../../src/regex/validators.ts';
import { generateSurrogate } from '../../src/surrogates.ts';
import type { SurrogateContext } from '../../src/surrogates.ts';

const nino = VALIDATORS.nino;
const nhs = VALIDATORS.nhs;
const ukDrivingLicence = VALIDATORS.ukDrivingLicence;

const ctx: SurrogateContext = { salt: 'test-salt-t100' };

function nhsIsValid(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length !== 10) return false;
  const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * weights[i];
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(d[9]);
}

describe('nino validator (HMRC prefix rules)', () => {
  it('accepts well-formed NINOs', () => {
    expect(nino('AB123456C')).toBe(true);
    expect(nino('AB 12 34 56 C')).toBe(true);
    expect(nino('CE123456C')).toBe(true);
    expect(nino('ab 12 34 56 c')).toBe(true); // rule flags are gi
  });

  it('rejects every excluded prefix pair (near-miss negatives)', () => {
    for (const prefix of ['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']) {
      expect(nino(`${prefix}123456C`), prefix).toBe(false);
    }
  });

  it('rejects invalid first letters D, F, I, Q, U, V', () => {
    for (const first of ['D', 'F', 'I', 'Q', 'U', 'V']) {
      expect(nino(`${first}A123456C`), first).toBe(false);
    }
  });

  it('rejects invalid second letters D, F, I, O, Q, U, V', () => {
    for (const second of ['D', 'F', 'I', 'O', 'Q', 'U', 'V']) {
      expect(nino(`A${second}123456C`), second).toBe(false);
    }
  });

  it('regression: second letter V is excluded (was missing pre-T100)', () => {
    expect(nino('AV123456C')).toBe(false);
  });
});

describe('nhs validator (mod-11 check digit)', () => {
  it('accepts valid NHS numbers in both groupings', () => {
    expect(nhs('943 476 5919')).toBe(true);
    expect(nhs('9434765919')).toBe(true);
  });

  it('rejects a wrong check digit (near-miss negative)', () => {
    expect(nhs('943 476 5918')).toBe(false);
    expect(nhs('943 476 5910')).toBe(false);
  });

  it('rejects the whole check-digit-10 class (no valid final digit)', () => {
    // 999000000: weighted sum 243, 243 % 11 == 1, so the check digit
    // computes to 10, which the NHS spec declares invalid outright.
    for (let final = 0; final <= 9; final++) {
      expect(nhs(`999000000${final}`), String(final)).toBe(false);
    }
  });

  it('rejects wrong lengths', () => {
    expect(nhs('943476591')).toBe(false);
    expect(nhs('94347659199')).toBe(false);
  });
});

describe('ukDrivingLicence validator (encoded date-of-birth block)', () => {
  it('accepts plausible driver numbers (male and female month encodings)', () => {
    expect(ukDrivingLicence('MORGA657054SM9IJ')).toBe(true); // month 57 -> 7
    expect(ukDrivingLicence('SMITH 751125 JM9AB')).toBe(true); // month 51 -> 1
  });

  it('rejects impossible month fields', () => {
    expect(ukDrivingLicence('MORGA630054SM9IJ')).toBe(false); // month 30
    expect(ukDrivingLicence('MORGA650154SM9IJ')).toBe(false); // month 50 (female 0)
    expect(ukDrivingLicence('MORGA600154SM9IJ')).toBe(false); // month 00
    expect(ukDrivingLicence('MORGA663154SM9IJ')).toBe(false); // month 63
  });

  it('rejects impossible day fields', () => {
    expect(ukDrivingLicence('MORGA657324SM9IJ')).toBe(false); // day 32
    expect(ukDrivingLicence('MORGA657004SM9IJ')).toBe(false); // day 00
  });

  it('rejects wrong lengths', () => {
    expect(ukDrivingLicence('MORGA657054SM9I')).toBe(false);
  });
});

describe('gb rules wiring', () => {
  it('the gb pack ships NINO, NHS, passport, and driving licence detectors', () => {
    const gbIds = new Set(
      ALL_REGEX_RULES.filter((r) => r.region === 'gb').map((r) => r.detector),
    );
    for (const id of [
      'regex:gb:nino', 'regex:gb:nhs', 'regex:gb:passport', 'regex:gb:driving_licence',
    ]) {
      expect(gbIds.has(id), id).toBe(true);
    }
  });

  it('the driving licence pattern does not match near-miss shapes', () => {
    const rule = ALL_REGEX_RULES.find((r) => r.detector === 'regex:gb:driving_licence')!;
    for (const nearMiss of [
      'MORGA65705SM9IJ', // 5-digit date block
      'morga657054sm9ij', // lowercase (licences print uppercase)
      'MORGA657054SM9I1', // digit where check chars belong
    ]) {
      rule.pattern.lastIndex = 0;
      expect(rule.pattern.exec(nearMiss), nearMiss).toBeNull();
    }
  });
});

describe('UK surrogate stand-ins', () => {
  it('NHS surrogates are mod-11 valid, keep the grouping, and sit in the 999 test range', () => {
    const out = generateSurrogate('943 476 5919', 'SSN', ctx);
    expect(out).toMatch(/^999 \d{3} \d{4}$/);
    expect(out).not.toBe('943 476 5919');
    expect(nhsIsValid(out)).toBe(true);
  });

  it('compact NHS surrogates stay compact and valid', () => {
    const out = generateSurrogate('9434765919', 'SSN', ctx);
    expect(out).toMatch(/^999\d{7}$/);
    expect(nhsIsValid(out)).toBe(true);
  });

  it('NINO surrogates keep the shape but use the reserved QQ example prefix', () => {
    const out = generateSurrogate('AB 12 34 56 C', 'SSN', ctx);
    expect(out).toMatch(/^QQ \d{2} \d{2} \d{2} [A-D]$/);
  });

  it('compact and lowercase NINOs keep their spacing and case', () => {
    expect(generateSurrogate('CE123456C', 'SSN', ctx)).toMatch(/^QQ\d{6}[A-D]$/);
    expect(generateSurrogate('ce123456c', 'SSN', ctx)).toMatch(/^qq\d{6}[a-d]$/);
  });

  it('QQ-prefixed stand-ins can never pass the nino validator (never real)', () => {
    const out = generateSurrogate('AB 12 34 56 C', 'SSN', ctx);
    expect(nino(out)).toBe(false);
  });

  it('UK surrogates are deterministic per salt', () => {
    expect(generateSurrogate('943 476 5919', 'SSN', ctx))
      .toBe(generateSurrogate('943 476 5919', 'SSN', ctx));
    expect(generateSurrogate('AB 12 34 56 C', 'SSN', ctx))
      .toBe(generateSurrogate('AB 12 34 56 C', 'SSN', ctx));
    const other: SurrogateContext = { salt: 'another-salt' };
    expect(generateSurrogate('943 476 5919', 'SSN', other))
      .not.toBe(generateSurrogate('943 476 5919', 'SSN', ctx));
  });
});
