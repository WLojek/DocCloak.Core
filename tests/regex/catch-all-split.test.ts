// T230: a catch-all regex span (universal:long_number, confidence 0.5) yields
// to the specific detections it overlaps instead of swallowing them.
import { describe, it, expect } from 'vitest';
import { detectEntities, detectWithRegex, splitCatchAlls } from '../../src/pipeline.ts';
import type { DetectedEntity } from '../../src/types.ts';

function run(text: string, region = 'pl', ml: DetectedEntity[] = []) {
  return detectEntities(text, ml, detectWithRegex(text, region)).map((e) => `${e.type}:${e.value}`);
}

describe('splitCatchAlls', () => {
  it('a PESEL cell followed by a phone cell gives SSN + PHONE, not one merged SSN', () => {
    const row = '2 Anna Nowak 90050598761 512 987 654 anna@x.pl Warszawa';
    expect(run(row)).toEqual(['SSN:90050598761', 'PHONE:512 987 654', 'EMAIL:anna@x.pl']);
    // region all: the foreign phone/ID rules on the same spans change nothing
    expect(run(row, 'all')).toEqual(['SSN:90050598761', 'PHONE:512 987 654', 'EMAIL:anna@x.pl']);
  });

  it('re-runs the rule on the leftovers so an unknown long number next to a phone is still caught', () => {
    expect(run('nr 123456789012 512 987 654 koniec')).toEqual(['SSN:123456789012', 'PHONE:512 987 654']);
    expect(run('nr 512 987 654 123456789012 koniec')).toEqual(['PHONE:512 987 654', 'SSN:123456789012']);
  });

  it('leaves a catch-all alone when nothing specific overlaps it', () => {
    expect(run('numer sprawy 123456789012 z dnia')).toEqual(['SSN:123456789012']);
  });

  it('leaves a catch-all alone when only a low-confidence span overlaps it', () => {
    const text = 'numer 123456789012 koniec';
    const weak: DetectedEntity = { type: 'OTHER', value: '123456', start: 6, end: 12, confidence: 0.6, detector: 'ml' };
    const regex = detectWithRegex(text, 'pl');
    const split = splitCatchAlls(text, [weak, ...regex]);
    expect(split.filter((e) => e.detector === 'regex:universal:long_number').map((e) => e.value)).toEqual(['123456789012']);
  });

  it('a specific ML span wins over the catch-all covering it, the rest of the run stays covered', () => {
    const text = 'numer 123456789012 512 987 654 koniec';
    const ml: DetectedEntity = { type: 'PHONE', value: '512 987 654', start: 19, end: 30, confidence: 0.92, detector: 'ml' };
    expect(run(text, 'pl', [ml])).toEqual(['SSN:123456789012', 'PHONE:512 987 654']);
  });

  it('returns exact offsets for the leftovers', () => {
    const text = 'nr 123456789012 512 987 654 koniec';
    const out = detectEntities(text, [], detectWithRegex(text, 'pl'));
    for (const e of out) expect(text.slice(e.start, e.end)).toBe(e.value);
  });

  it('does not touch non-regex or high-confidence entities', () => {
    const text = 'Jan Kowalski 512 987 654';
    const person: DetectedEntity = { type: 'PERSON', value: 'Jan Kowalski', start: 0, end: 12, confidence: 0.4, detector: 'ml' };
    const regex = detectWithRegex(text, 'pl');
    const split = splitCatchAlls(text, [person, ...regex]);
    expect(split).toContainEqual(person);
    expect(split.filter((e) => e.detector === 'regex:pl:phone')).toHaveLength(1);
  });
});
