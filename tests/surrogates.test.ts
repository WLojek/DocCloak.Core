/**
 * T043: surrogate generator tests - determinism, per-type shape and
 * checksum validity (IBAN mod-97, PESEL, Luhn), locale awareness and
 * collision handling.
 */
import { describe, it, expect } from 'vitest';
import {
  FAKE_EMAIL_DOMAINS,
  detectSurrogateLocale,
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

describe('PERSON locales beyond EN/PL (T073)', () => {
  it('locale detection: distinctive characters and name pools decide', () => {
    expect(detectSurrogateLocale('Hans M\u00fcller')).toBe('de');
    expect(detectSurrogateLocale('Fran\u00e7ois Dubois')).toBe('fr');
    expect(detectSurrogateLocale('Jos\u00e9 Garc\u00eda')).toBe('es');
    expect(detectSurrogateLocale('Giuseppe Rossi')).toBe('it');
    expect(detectSurrogateLocale('Ji\u0159\u00ed Nov\u00e1k')).toBe('cs');
    expect(detectSurrogateLocale('\u041e\u043b\u0435\u043d\u0430 \u0428\u0435\u0432\u0447\u0435\u043d\u043a\u043e')).toBe('uk');
    expect(detectSurrogateLocale('Jo\u00e3o Silva')).toBe('pt');
    expect(detectSurrogateLocale('Femke Bakker')).toBe('nl');
    expect(detectSurrogateLocale('Jan Kowalski')).toBe('pl');
    expect(detectSurrogateLocale('John Smith')).toBe('en');
  });

  it('surrogates stay in the original locale (round-trip property)', () => {
    for (const [name, locale] of [
      ['Hans M\u00fcller', 'de'],
      ['Marie Lefebvre', 'fr'],
      ['Carmen Rodr\u00edguez', 'es'],
      ['Giovanni Bianchi', 'it'],
      ['Kate\u0159ina Svobodov\u00e1', 'cs'],
      ['\u0422\u0430\u0440\u0430\u0441 \u041a\u043e\u0432\u0430\u043b\u0435\u043d\u043a\u043e', 'uk'],
      ['Tiago Ferreira', 'pt'],
      ['Anouk Dijkstra', 'nl'],
    ] as const) {
      const out = generateSurrogate(name, 'PERSON', ctx);
      expect(out).not.toBe(name);
      expect(out.split(' ')).toHaveLength(2);
      expect(detectSurrogateLocale(out)).toBe(locale);
    }
  });

  it('Czech female names get -ov\u00e1 / -\u00e1 surnames', () => {
    const out = generateSurrogate('Kate\u0159ina Svobodov\u00e1', 'PERSON', ctx);
    expect(out.split(' ')[1]).toMatch(/(?:ov\u00e1|\u00e1)$/u);
  });

  it('Ukrainian surrogates stay Cyrillic and gender-consistent', () => {
    const female = generateSurrogate('\u041e\u043b\u0435\u043d\u0430 \u0428\u0435\u0432\u0447\u0435\u043d\u043a\u043e', 'PERSON', ctx);
    expect(female).toMatch(/^[\u0400-\u04ff\u2019' -]+$/u);
    // Never a masculine adjectival surname for a female given name.
    expect(female.split(' ')[1]).not.toMatch(/(?:\u0441\u044c\u043a\u0438\u0439|\u0446\u044c\u043a\u0438\u0439)$/u);
  });
});

describe('Nordic + CJK locales (T073 web-parity)', () => {
  it('Nordic names map to same-locale fakes', () => {
    for (const [name, locale] of [
      ['Sven Bergstr\u00f6m', 'sv'],
      ['Bj\u00f8rn Haugen', 'no'],
      ['Mette S\u00f8rensen', 'da'],
      ['Juha Virtanen', 'fi'],
    ] as const) {
      const out = generateSurrogate(name, 'PERSON', ctx);
      expect(out).not.toBe(name);
      expect(out.split(' ')).toHaveLength(2);
      expect(detectSurrogateLocale(out)).toBe(locale);
    }
  });

  it('Japanese names: kana or 2-char surname prefix decides; output is Japanese-composed', () => {
    expect(detectSurrogateLocale('\u7530\u4e2d\u592a\u90ce')).toBe('ja'); // kanji-only, surname prefix
    expect(detectSurrogateLocale('\u3055\u304f\u3089')).toBe('ja'); // kana
    const out = generateSurrogate('\u7530\u4e2d\u592a\u90ce', 'PERSON', ctx);
    expect(out).not.toBe('\u7530\u4e2d\u592a\u90ce');
    expect(out).toMatch(/^[\u3040-\u30ff\u4e00-\u9fff]+$/u); // no space, CJK only
  });

  it('Chinese names: 1-char surname prefix decides; given-name length mirrored', () => {
    expect(detectSurrogateLocale('\u738b\u4f1f')).toBe('zh');
    const out = generateSurrogate('\u738b\u4f1f', 'PERSON', ctx);
    expect(out).not.toBe('\u738b\u4f1f');
    expect(out).toMatch(/^[\u4e00-\u9fff]{2}$/u); // 2 chars in, 2 chars out
    const out3 = generateSurrogate('\u674e\u79c0\u82f1', 'PERSON', ctx);
    expect(out3).toMatch(/^[\u4e00-\u9fff]{3}$/u);
  });

  it('an unknown Han-script name still resolves via the script fallback', () => {
    expect(detectSurrogateLocale('\u94b1\u6d69\u7136')).toBe('zh'); // surname not in pool
  });

  it('CJK dates (2024\u5e743\u670815\u65e5) shift and keep the format', () => {
    const out = generateSurrogate('2024\u5e743\u670815\u65e5', 'DATE', ctx);
    expect(out).not.toBe('2024\u5e743\u670815\u65e5');
    expect(out).toMatch(/^\d{4}\u5e74\d{1,2}\u6708\d{1,2}\u65e5$/u);
  });

  it('Nordic and Finnish dates keep their language', () => {
    const fi = generateSurrogate('15 maaliskuuta 2024', 'DATE', ctx);
    expect(fi).toMatch(/^\d{1,2} \p{Ll}+ \d{4}$/u);
    expect(fi).not.toBe('15 maaliskuuta 2024');
    const da = generateSurrogate('15 marts 2024', 'DATE', ctx);
    expect(da).toMatch(/^\d{1,2} \p{Ll}+ \d{4}$/u);
  });

  it('Nordic and CJK addresses follow their locale formats', () => {
    expect(generateSurrogate('Storgatan 5', 'ADDRESS', ctx)).toMatch(/v\u00e4gen \d+$/);
    expect(generateSurrogate('Kirkeveien 3', 'ADDRESS', ctx)).toMatch(/veien \d+$/);
    expect(generateSurrogate('M\u00f8llevej 8', 'ADDRESS', ctx)).toMatch(/vej \d+$/);
    expect(generateSurrogate('Mannerheiminkatu 10', 'ADDRESS', ctx)).toMatch(/katu \d+$/);
    expect(generateSurrogate('\u685c\u753a3\u4e01\u76ee', 'ADDRESS', ctx)).toMatch(/\u4e01\u76ee$/u);
    expect(generateSurrogate('\u4e2d\u5c71\u8def88\u53f7', 'ADDRESS', ctx)).toMatch(/\u53f7$/u);
  });

  it('Nordic and CJK company suffixes decide the pool; bare AB/AS need a space', () => {
    expect(generateSurrogate('Volvex AB', 'COMPANY', ctx)).toMatch(/ AB$/);
    expect(generateSurrogate('Fjellkraft AS', 'COMPANY', ctx)).toMatch(/ AS$/);
    expect(generateSurrogate('Danske Byg A/S', 'COMPANY', ctx)).toMatch(/ A\/S$/);
    expect(generateSurrogate('Metsola Oy', 'COMPANY', ctx)).toMatch(/ Oyj?$/);
    // CJK suffixes attach without a space and stay attached.
    const ja = generateSurrogate('\u7530\u4e2d\u5546\u4e8b\u682a\u5f0f\u4f1a\u793e', 'COMPANY', ctx);
    expect(ja).toMatch(/^[\u3040-\u30ff\u4e00-\u9fff]+\u682a\u5f0f\u4f1a\u793e$/u);
    const zh = generateSurrogate('\u534e\u4fe1\u79d1\u6280\u6709\u9650\u516c\u53f8', 'COMPANY', ctx);
    expect(zh).toMatch(/^[\u4e00-\u9fff]+\u6709\u9650\u516c\u53f8$/u);
    // 'SAAB' must NOT shed a bare 'AB' suffix.
    const saab = generateSurrogate('SAAB', 'COMPANY', ctx);
    expect(saab).not.toMatch(/ AB$/);
  });
});

describe('localized DATE / ADDRESS / COMPANY (T073)', () => {
  it('German and French month-name dates keep their language and case', () => {
    const de = generateSurrogate('15 M\u00e4rz 2024', 'DATE', ctx);
    expect(de).not.toBe('15 M\u00e4rz 2024');
    expect(de).toMatch(/^\d{1,2} [A-Z\u00c4\u00d6\u00dc][\p{Ll}\u00e4\u00f6\u00fc]+ \d{4}$/u);
    const fr = generateSurrogate('15 ao\u00fbt 2024', 'DATE', ctx);
    expect(fr).toMatch(/^\d{1,2} \p{Ll}+ \d{4}$/u);
  });

  it('Ukrainian genitive dates shift and stay Ukrainian', () => {
    const uk = generateSurrogate('15 \u0431\u0435\u0440\u0435\u0437\u043d\u044f 2024', 'DATE', ctx);
    expect(uk).not.toBe('15 \u0431\u0435\u0440\u0435\u0437\u043d\u044f 2024');
    expect(uk).toMatch(/^\d{1,2} [\u0400-\u04ff]+ \d{4}$/u);
  });

  it('addresses follow the locale format signalled by the keyword', () => {
    expect(generateSurrogate('Hauptstra\u00dfe 5', 'ADDRESS', ctx)).toMatch(/stra\u00dfe \d+$/u);
    expect(generateSurrogate('12 rue de Rivoli', 'ADDRESS', ctx)).toMatch(/^\d+ rue /);
    expect(generateSurrogate('Calle Mayor 3', 'ADDRESS', ctx)).toMatch(/^Calle /);
    expect(generateSurrogate('Via Nazionale 10', 'ADDRESS', ctx)).toMatch(/^Via /);
    expect(generateSurrogate('\u0432\u0443\u043b. \u0417\u0435\u043b\u0435\u043d\u0430 98', 'ADDRESS', ctx)).toMatch(/^\u0432\u0443\u043b\. [\u0400-\u04ff]+ \d+$/u);
    expect(generateSurrogate('Rua Augusta 12', 'ADDRESS', ctx)).toMatch(/^Rua /);
    expect(generateSurrogate('Kerkstraat 4', 'ADDRESS', ctx)).toMatch(/straat \d+$/);
    expect(generateSurrogate('ul. Polna 7', 'ADDRESS', ctx)).toMatch(/^ul\. /);
  });

  it('legal-form suffixes choose the company pool and are kept verbatim', () => {
    expect(generateSurrogate('Musterbau GmbH', 'COMPANY', ctx)).toMatch(/ GmbH$/);
    expect(generateSurrogate('Databene s.r.o.', 'COMPANY', ctx)).toMatch(/ s\.r\.o\.$/);
    expect(generateSurrogate('Innovex S.r.l.', 'COMPANY', ctx)).toMatch(/ S\.r\.l\.$/);
    const uk = generateSurrogate('\u0411\u0443\u0434\u0456\u043d\u0432\u0435\u0441\u0442 \u0422\u041e\u0412', 'COMPANY', ctx);
    expect(uk).toMatch(/[\u0400-\u04ff]+ \u0422\u041e\u0412$/u);
    expect(generateSurrogate('Ambar Unipessoal Lda.', 'COMPANY', ctx)).toMatch(/ Lda\.$/);
    expect(generateSurrogate('Kaasgroothandel B.V.', 'COMPANY', ctx)).toMatch(/ B\.V\.$/);
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

describe('pool hygiene (T182, audit R3/R4)', () => {
  // A surrogate becomes a restore key. Dictionary words and very short
  // names fire on ordinary prose ("Bob" for "Bo", "the martin paper"), so
  // no alphabetic pool may contain them. The removed entries were
  // replaced at the same index, so every surrogate that never drew a
  // removed entry is unchanged.
  const STOPLIST = new Set([
    'white', 'green', 'king', 'young', 'hill', 'scott', 'baker', 'post', 'bos', 'vos', 'kok',
    'long', 'short', 'best', 'bright', 'wood', 'stone', 'hall', 'fox', 'wolf', 'lane', 'price',
    'rice', 'brown', 'miller', 'walker', 'martin', 'lee', 'mark', 'carol', 'frank', 'bent',
    'lone', 'tone', 'urban', 'lien', 'petit', 'roux', 'iris', 'richter', 'koch', 'bauer',
    'fischer', 'roman', 'král', 'król',
  ]);
  const SAMPLES = [
    'John Smith', 'Mary Jones', 'Jan Kowalski', 'Anna Nowak', 'Hans Müller', 'Ursula Weber',
    'Jean Dubois', 'Marie Leroy', 'José García', 'Carmen López', 'Giuseppe Rossi',
    'Maria Russo', 'Jiří Novák', 'Kateřina Svobodová',
    'Тарас Коваленко',
    'Олена Шевченко',
    'João Silva', 'Catarina Santos', 'Daan Jansen', 'Sanne Visser', 'Erik Andersson',
    'Kerstin Nilsson', 'Knut Hansen', 'Ingrid Haugen', 'Jens Nielsen', 'Mette Jensen',
    'Juha Virtanen', 'Tiina Mäkinen',
  ] as const;

  it('never emits a dictionary-word or three-letter-or-shorter token (300 salts per sample)', () => {
    for (const name of SAMPLES) {
      for (let i = 0; i < 300; i++) {
        const out = generateSurrogate(name, 'PERSON', { salt: `hygiene-${i}` });
        for (const token of out.split(/[\s-]+/)) {
          expect(token.length, `${name} -> ${out}`).toBeGreaterThan(3);
          // Unfolded on purpose: an accented key ("Martín") never matches
          // the English word, so it is not a restore hazard.
          expect(STOPLIST.has(token.toLowerCase()), `${name} -> ${out}`).toBe(false);
        }
      }
    }
  });

  it('keeps surrogates for originals that never drew a removed entry (same-index refill)', () => {
    // Values captured with this salt BEFORE the T182 pool edit; each draws
    // only entries that stayed at their index, so they must not move.
    // (Names that did draw a removed entry moved on purpose, e.g.
    // "JOHN SMITH": SCOTT NELSON -> DOUGLAS NELSON.)
    expect(generateSurrogate('Jan Kowalski', 'PERSON', ctx)).toBe('Jacek Mazur');
    expect(generateSurrogate('John Smith', 'PERSON', ctx)).toBe('Jonathan Clark');
    expect(generateSurrogate('Hans Müller', 'PERSON', ctx)).toBe('Peter Lange');
    expect(generateSurrogate('Anouk Dijkstra', 'PERSON', ctx)).toBe('Lieke Hendriks');
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
