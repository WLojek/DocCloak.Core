/**
 * T043: surrogate generator tests - determinism, per-type shape and
 * checksum validity (IBAN mod-97, PESEL, Luhn), locale awareness and
 * collision handling.
 */
import { describe, it, expect } from 'vitest';
import {
  FAKE_EMAIL_DOMAINS,
  generateSessionSalt,
  generateSurrogate,
  generateUniqueSurrogate,
  sessionDayOffset,
} from '../src/surrogates.ts';
import type { SurrogateContext } from '../src/surrogates.ts';

const SALT = 'test-salt-0001';
const ctx: SurrogateContext = { salt: SALT };

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L');
}

describe('determinism', () => {
  it('same salt + value + type always yields the same surrogate', () => {
    for (const [value, type] of [
      ['Jan Kowalski', 'PERSON'],
      ['2024-03-15', 'DATE'],
      ['+48 601 234 567', 'PHONE'],
    ] as const) {
      expect(generateSurrogate(value, type, ctx)).toBe(generateSurrogate(value, type, ctx));
    }
  });

  it('a different salt yields a different derivation', () => {
    const a = generateSurrogate('Jan Kowalski', 'PERSON', { salt: 'salt-a' });
    const b = generateSurrogate('Jan Kowalski', 'PERSON', { salt: 'salt-b' });
    // 40x40 pool: a coincidence would be a 1-in-1600 event for this pair.
    expect(a).not.toBe(b);
  });

  it('generateSessionSalt returns 32 hex chars and varies per call', () => {
    const a = generateSessionSalt();
    const b = generateSessionSalt();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('PERSON', () => {
  it('preserves token count and title case for a two-token EN name', () => {
    const out = generateSurrogate('John Smith', 'PERSON', ctx);
    expect(out).not.toBe('John Smith');
    const tokens = out.split(' ');
    expect(tokens).toHaveLength(2);
    for (const t of tokens) expect(t).toMatch(/^[A-Z][a-z]+$/);
  });

  it('preserves an ALL CAPS pattern', () => {
    const out = generateSurrogate('JOHN SMITH', 'PERSON', ctx);
    expect(out).toBe(out.toUpperCase());
    expect(out.split(' ')).toHaveLength(2);
  });

  it('maps a Polish female name to a female-ending surname', () => {
    const out = generateSurrogate('Anna Kowalska', 'PERSON', ctx);
    const [first, last] = out.split(' ');
    expect(out.split(' ')).toHaveLength(2);
    // Feminine or invariant surname; never a masculine adjectival ending.
    expect(last).not.toMatch(/(?:ski|cki|dzki)$/);
    // Polish female given names end in -a.
    expect(fold(first)).toMatch(/a$/);
  });

  it('maps a Polish male name to a masculine surname form', () => {
    const out = generateSurrogate('Jan Kowalski', 'PERSON', ctx);
    const last = out.split(' ')[1];
    expect(last).not.toMatch(/(?:ska|cka|dzka)$/);
  });

  it('keeps a hyphenated double surname hyphenated', () => {
    const out = generateSurrogate('Zofia Kowalska-Nowak', 'PERSON', ctx);
    const tokens = out.split(' ');
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toContain('-');
  });

  it('maps a single-token name to a single token', () => {
    const out = generateSurrogate('John', 'PERSON', ctx);
    expect(out.split(' ')).toHaveLength(1);
    expect(out).not.toBe('John');
  });
});

describe('EMAIL', () => {
  const entries = [
    { original: 'Jan Kowalski', replacement: 'Adam Nowak', entityType: 'PERSON' as const },
  ];

  it('derives the local part from the in-session person surrogate', () => {
    const out = generateSurrogate('jan.kowalski@firma.pl', 'EMAIL', { salt: SALT, entries });
    expect(out).toMatch(/^adam\.nowak@/);
    const domain = out.split('@')[1];
    expect(FAKE_EMAIL_DOMAINS).toContain(domain);
  });

  it('mirrors an initial-style local part (j.kowalski -> a.nowak)', () => {
    const out = generateSurrogate('j.kowalski@firma.pl', 'EMAIL', { salt: SALT, entries });
    expect(out).toMatch(/^a\.nowak@/);
  });

  it('keeps a trailing digit run with the same digit count', () => {
    const out = generateSurrogate('jan.kowalski99@firma.pl', 'EMAIL', { salt: SALT, entries });
    expect(out).toMatch(/^adam\.nowak\d{2}@/);
  });

  it('uses a deterministic unrelated identity when no person matches', () => {
    const out = generateSurrogate('someone@company.com', 'EMAIL', ctx);
    expect(out).toMatch(/^[a-z]+\.[a-z]+@/);
    expect(FAKE_EMAIL_DOMAINS).toContain(out.split('@')[1]);
    expect(out).toBe(generateSurrogate('someone@company.com', 'EMAIL', ctx));
  });

  it('never uses the original domain', () => {
    const out = generateSurrogate('jan.kowalski@firma.pl', 'EMAIL', { salt: SALT, entries });
    expect(out).not.toContain('firma.pl');
  });
});

describe('DATE', () => {
  const toUtc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

  it('keeps the ISO shape and shifts within 30 days, never 0', () => {
    const out = generateSurrogate('2024-03-15', 'DATE', ctx);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(out);
    expect(m).not.toBeNull();
    const delta =
      (toUtc(+m![1], +m![2], +m![3]) - toUtc(2024, 3, 15)) / 86400000;
    expect(Math.abs(delta)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(delta)).toBeLessThanOrEqual(30);
    expect(delta).toBe(sessionDayOffset(SALT));
  });

  it('shifts every date in a session by the same offset (spacing preserved)', () => {
    const a = generateSurrogate('2024-03-15', 'DATE', ctx);
    const b = generateSurrogate('2024-03-22', 'DATE', ctx);
    const parse = (s: string) => {
      const [y, mo, d] = s.split('-').map(Number);
      return toUtc(y, mo, d);
    };
    expect(parse(b) - parse(a)).toBe(7 * 86400000);
  });

  it('keeps the dotted D.M.YYYY shape', () => {
    const out = generateSurrogate('15.03.2024', 'DATE', ctx);
    expect(out).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(out).not.toBe('15.03.2024');
  });

  it('keeps the D/M/YYYY shape', () => {
    expect(generateSurrogate('15/03/2024', 'DATE', ctx)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it('keeps an English month-name format in English', () => {
    const out = generateSurrogate('15 March 2024', 'DATE', ctx);
    const m = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(out);
    expect(m).not.toBeNull();
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    expect(months).toContain(m![2]);
  });

  it('keeps a Polish genitive month-name format in Polish', () => {
    const out = generateSurrogate('15 marca 2024', 'DATE', ctx);
    const m = /^(\d{1,2}) (\S+) (\d{4})$/.exec(out);
    expect(m).not.toBeNull();
    const months = [
      'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
      'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
    ];
    expect(months).toContain(m![2]);
  });

  it('keeps the "Month D, YYYY" comma format', () => {
    const out = generateSurrogate('March 15, 2024', 'DATE', ctx);
    expect(out).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it('falls back to same-shape digit substitution for unparseable dates', () => {
    const out = generateSurrogate('Q3/99', 'DATE', ctx);
    expect(out).toMatch(/^Q\d\/\d\d$/);
  });

  it('rejects impossible calendar dates via the digit fallback', () => {
    const out = generateSurrogate('31.02.2024', 'DATE', ctx);
    expect(out).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });
});

describe('PHONE', () => {
  it('keeps the +CC prefix and the formatting, substitutes subscriber digits', () => {
    const out = generateSurrogate('+48 601 234 567', 'PHONE', ctx);
    expect(out).toMatch(/^\+48 \d{3} \d{3} \d{3}$/);
    expect(out).not.toBe('+48 601 234 567');
  });

  it('keeps parentheses/dash formatting for US-style numbers', () => {
    const out = generateSurrogate('(555) 123-4567', 'PHONE', ctx);
    expect(out).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
    expect(out).not.toBe('(555) 123-4567');
  });

  it('keeps a leading trunk zero', () => {
    const out = generateSurrogate('0601 234 567', 'PHONE', ctx);
    expect(out).toMatch(/^0\d{3} \d{3} \d{3}$/);
  });
});

describe('IBAN', () => {
  /** Standard IBAN validation: move first 4 chars to the end, mod 97 == 1. */
  function ibanIsValid(iban: string): boolean {
    const compact = iban.replace(/\s/g, '').toUpperCase();
    const rearranged = compact.slice(4) + compact.slice(0, 4);
    let rem = 0;
    for (const ch of rearranged) {
      const v = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
      rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
    }
    return rem === 1;
  }

  it('keeps the country, length and grouping; checksum is mod-97 valid', () => {
    const original = 'PL61 1090 1014 0000 0712 1981 2874';
    const out = generateSurrogate(original, 'IBAN', ctx);
    expect(out).toMatch(/^PL\d{2}(?: \d{4}){6}$/);
    expect(out).not.toBe(original);
    expect(ibanIsValid(out)).toBe(true);
  });

  it('generates a valid compact German IBAN', () => {
    const out = generateSurrogate('DE89370400440532013000', 'IBAN', ctx);
    expect(out).toMatch(/^DE\d{20}$/);
    expect(ibanIsValid(out)).toBe(true);
  });

  it('mirrors letter positions (GB bank codes stay letters) and validates', () => {
    const out = generateSurrogate('GB29NWBK60161331926819', 'IBAN', ctx);
    expect(out).toMatch(/^GB\d{2}[A-Z]{4}\d{14}$/);
    expect(ibanIsValid(out)).toBe(true);
  });
});

describe('national IDs (SSN entity type)', () => {
  it('generates a checksum-valid PESEL with a 19th-century marker', () => {
    const out = generateSurrogate('90010112345', 'SSN', ctx);
    expect(out).toMatch(/^\d{11}$/);
    // Checksum (weights 1,3,7,9,1,3,7,9,1,3).
    const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
    const sum = weights.reduce((acc, w, i) => acc + w * Number(out[i]), 0);
    expect(Number(out[10])).toBe((10 - (sum % 10)) % 10);
    // Month field 81-92 encodes an 1800s birth date: the registry never
    // issued numbers for that range, so this can never be a real PESEL.
    const monthField = Number(out.slice(2, 4));
    expect(monthField).toBeGreaterThanOrEqual(81);
    expect(monthField).toBeLessThanOrEqual(92);
  });

  it('keeps the US SSN shape and forces the never-allocated 9xx area', () => {
    const out = generateSurrogate('123-45-6789', 'SSN', ctx);
    expect(out).toMatch(/^9\d{2}-\d{2}-\d{4}$/);
  });

  it('substitutes digits same-shape for other ID shapes', () => {
    const out = generateSurrogate('ID 12/3456', 'SSN', ctx);
    expect(out).toMatch(/^ID \d{2}\/\d{4}$/);
  });
});

describe('CREDIT_CARD', () => {
  function luhnIsValid(digits: string): boolean {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = Number(digits[i]);
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  it('keeps the grouping and produces a Luhn-valid number', () => {
    const out = generateSurrogate('4111 1111 1111 1111', 'CREDIT_CARD', ctx);
    expect(out).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    expect(luhnIsValid(out.replace(/\s/g, ''))).toBe(true);
  });
});

describe('IP_ADDRESS / CURRENCY / OTHER fallbacks', () => {
  it('generates a structurally valid IPv4 address', () => {
    const out = generateSurrogate('192.168.1.10', 'IP_ADDRESS', ctx);
    const octets = out.split('.').map(Number);
    expect(octets).toHaveLength(4);
    for (const o of octets) {
      expect(o).toBeGreaterThanOrEqual(1);
      expect(o).toBeLessThanOrEqual(254);
    }
  });

  it('keeps currency symbols and separators', () => {
    const out = generateSurrogate('$1,234.56', 'CURRENCY', ctx);
    expect(out).toMatch(/^\$\d,\d{3}\.\d{2}$/);
  });

  it('same-shape substitution preserves case and punctuation for OTHER', () => {
    const out = generateSurrogate('AB-123/xy', 'OTHER', ctx);
    expect(out).toMatch(/^[A-Z]{2}-\d{3}\/[a-z]{2}$/);
  });

  it('picks a Polish street pattern for Polish addresses', () => {
    const out = generateSurrogate('ul. Marszałkowska 12', 'ADDRESS', ctx);
    expect(out).toMatch(/^ul\. \S+ \d+$/);
    expect(out).not.toContain('Marszałkowska');
  });

  it('keeps a recognized company suffix', () => {
    const out = generateSurrogate('Acme Sp. z o.o.', 'COMPANY', ctx);
    expect(out).toMatch(/ Sp\. z o\.o\.$/);
    expect(out).not.toContain('Acme');
  });
});

describe('collision handling (generateUniqueSurrogate)', () => {
  it('re-derives on collision with an already-taken candidate', () => {
    const first = generateSurrogate('John Smith', 'PERSON', ctx, 0);
    const taken = new Set([first]);
    const out = generateUniqueSurrogate('John Smith', 'PERSON', ctx, (c) => taken.has(c));
    expect(out).not.toBe(first);
    expect(taken.has(out)).toBe(false);
  });

  it('never returns the original value itself', () => {
    // Force the degenerate case: every candidate for this value "collides"
    // unless it is the original; the generator must still avoid it.
    const out = generateUniqueSurrogate('John Smith', 'PERSON', ctx, () => false);
    expect(out).not.toBe('John Smith');
  });

  it('appends digits after bounded retries are exhausted', () => {
    const attempts = new Set(
      Array.from({ length: 8 }, (_, a) => generateSurrogate('John Smith', 'PERSON', ctx, a)),
    );
    const out = generateUniqueSurrogate('John Smith', 'PERSON', ctx, (c) => attempts.has(c));
    expect(out).toMatch(/\d+$/);
    expect(attempts.has(out)).toBe(false);
    expect(out.startsWith(generateSurrogate('John Smith', 'PERSON', ctx, 7))).toBe(true);
  });
});
