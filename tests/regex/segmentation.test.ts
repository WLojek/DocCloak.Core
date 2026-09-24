/**
 * T180: line segmentation in detectWithRegex and the `multiline` rule flag.
 *
 * Quadratic street/company rules (R1) used to scan the whole document from
 * every start position. detectWithRegex now runs each rule per line (offsets
 * added back), and only rules flagged `multiline: true` in rules/*.json see
 * the whole text. Today that is private_key_block alone.
 */
import { describe, it, expect } from 'vitest';
import { detectWithRegex, segmentLines } from '../../src/pipeline.ts';
import { ALL_REGEX_RULES } from '../../src/regex/index.ts';
import { loadRegexRules } from '../../src/regex/loader.ts';

describe('segmentLines', () => {
  it('splits on \\n and keeps document-absolute offsets', () => {
    expect(segmentLines('ab\ncd\n\nef')).toEqual([
      { text: 'ab', offset: 0 },
      { text: 'cd', offset: 3 },
      { text: 'ef', offset: 7 },
    ]);
  });

  it('keeps \\r inside the line and handles trailing newlines and empty input', () => {
    expect(segmentLines('ab\r\ncd\n')).toEqual([
      { text: 'ab\r', offset: 0 },
      { text: 'cd', offset: 4 },
    ]);
    expect(segmentLines('')).toEqual([]);
    expect(segmentLines('\n\n')).toEqual([]);
  });
});

describe('multiline rule flag', () => {
  it('is loaded from the JSON and set on private_key_block only', () => {
    const flagged = ALL_REGEX_RULES.filter((r) => r.multiline === true).map((r) => r.detector);
    expect(flagged).toEqual(['regex:universal:private_key_block']);
  });

  it('is passed through by the loader and absent by default', () => {
    const base = {
      id: 'regex:zz:test',
      entityType: 'OTHER' as const,
      pattern: 'a\\s+b',
      flags: 'g',
      confidence: 0.5,
      domains: ['general' as const],
      description: 'test rule',
    };
    const [plain, multi] = loadRegexRules([
      { region: 'zz', rules: [base, { ...base, id: 'regex:zz:multi', multiline: true }] },
    ]);
    expect(plain.multiline).toBeUndefined();
    expect(multi.multiline).toBe(true);
  });
});

describe('detectWithRegex line segmentation', () => {
  it('reports document-absolute spans for matches on later lines', () => {
    const text = 'first line\nsecond line with john@example.com here\nthird 192.168.1.10 end';
    const found = detectWithRegex(text);
    const email = found.find((e) => e.detector === 'regex:universal:email');
    expect(email).toBeDefined();
    expect(email!.start).toBe(text.indexOf('john@example.com'));
    expect(email!.end).toBe(email!.start + 'john@example.com'.length);
    expect(text.slice(email!.start, email!.end)).toBe('john@example.com');
    const ip = found.find((e) => e.type === 'IP_ADDRESS');
    expect(ip).toBeDefined();
    expect(text.slice(ip!.start, ip!.end)).toBe('192.168.1.10');
  });

  it('never lets a non-multiline rule span a line break (\\s in a class does not cross lines)', () => {
    // postal_city is "\d... \s+ letters": with a newline between code and city
    // the whole-text match "00-950\nWarszawa" is no longer produced.
    const found = detectWithRegex('Kod pocztowy: 00-950\nWarszawa jest stolica.', 'pl');
    expect(found.some((e) => e.value.includes('\n'))).toBe(false);
    // Same text on one line still matches as before.
    const oneLine = detectWithRegex('Kod pocztowy: 00-950 Warszawa jest stolica.', 'pl');
    expect(oneLine.some((e) => e.value.startsWith('00-950 Warszawa'))).toBe(true);
  });

  it('runs multiline rules on the whole text: PEM key blocks spanning lines are detected with exact spans', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\nabcdef\n-----END RSA PRIVATE KEY-----';
    const text = `line one\nconfig:\n${key}\ntrailing line`;
    const found = detectWithRegex(text);
    const block = found.filter((e) => e.detector === 'regex:universal:private_key_block');
    expect(block).toHaveLength(1);
    expect(block[0].value).toBe(key);
    expect(block[0].start).toBe(text.indexOf(key));
    expect(text.slice(block[0].start, block[0].end)).toBe(key);
  });

  it('produces the same entities for single-line text as whole-text matching would', () => {
    const text = 'Contact john@example.com or +48 601 234 567, PESEL 44051401359, IBAN PL61109010140000071219812874.';
    const segmented = detectWithRegex(text, 'pl');
    // With no newline there is exactly one segment at offset 0; the output
    // must be the rule-major list the old whole-text loop produced.
    const expected = [];
    for (const rule of ALL_REGEX_RULES.filter((r) => r.region === 'universal' || r.region === 'pl')) {
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(text)) !== null) {
        if (rule.validate && !rule.validate(m[0])) continue;
        expected.push({ type: rule.type, value: m[0], start: m.index, end: m.index + m[0].length, confidence: rule.confidence, detector: rule.detector });
      }
    }
    expect(segmented).toEqual(expected);
  });
});

describe('detectWithRegex performance (R1)', () => {
  // 100 KB of comma-free prose in 200 lines: before T180 this took over a
  // minute for region "all" because 22 street/company/email patterns are
  // quadratic in the length of their input. Per-line matching bounds the
  // cost to the longest line. A single 100 KB line without newlines is
  // still slow until the patterns themselves are bounded (T198).
  const WORDS = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'a', 'lazy', 'dog', 'while',
    'seven', 'green', 'ships', 'sail', 'past', 'quiet', 'harbour', 'towns', 'at', 'dawn'];

  function prose(totalBytes: number, lines: number): string {
    const perLine = Math.ceil(totalBytes / lines);
    const out: string[] = [];
    let i = 0;
    for (let l = 0; l < lines; l++) {
      let line = '';
      while (line.length < perLine) {
        line += (line ? ' ' : '') + WORDS[i++ % WORDS.length];
      }
      out.push(line);
    }
    return out.join('\n');
  }

  // Guards against super-linear regex behaviour (a ReDoS regression costs
  // tens of seconds here), not against slow hardware: the budget is generous
  // because shared CI runners take 3 to 5 times longer than a laptop, and the
  // first call is excluded so rule compilation does not count.
  it('scans 100 KB of prose in 200 lines with region "all" in under 5 s', () => {
    const text = prose(100 * 1024, 200);
    expect(text.length).toBeGreaterThanOrEqual(100 * 1024);
    expect(text.split('\n')).toHaveLength(200);
    detectWithRegex(text.slice(0, 4096), 'all');
    const started = performance.now();
    const found = detectWithRegex(text, 'all');
    const elapsed = performance.now() - started;
    expect(Array.isArray(found)).toBe(true);
    expect(elapsed, `detectWithRegex took ${elapsed.toFixed(0)} ms`).toBeLessThan(5000);
  });
});
