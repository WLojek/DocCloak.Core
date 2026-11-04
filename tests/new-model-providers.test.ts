/**
 * Decoding pieces of the T240-T242 providers (BardS.ai v2/v3, GLiNER2
 * Privacy Filter, OpenAI Privacy Filter). Inference itself needs the real
 * models: parity with the research references was checked in Node with
 * onnxruntime-web (OpenAI 12/12 sentences identical, BardS.ai v2 12/12,
 * GLiNER2 every kept span in the reference). Here the pure functions and the
 * load guards, with onnxruntime-web mocked.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('onnxruntime-web/webgpu', () => ({
  env: { wasm: {} },
  InferenceSession: { create: vi.fn() },
  Tensor: class {},
}));

import {
  accountNumberType,
  buildTransitions,
  labelsToSpans,
  OpenAiPrivacyFilterProvider,
  tokenOffsets,
  viterbi,
  WebGpuUnavailableError,
} from '../src/providers/openai-privacy-filter.ts';
import { bardsaiV2Labels, bardsaiV2Windows, decodeWords, tokenizeWithOffsets } from '../src/providers/bardsai-v2.ts';
import { gliner2EntityType, gliner2Schema, gliner2Words } from '../src/providers/gliner2.ts';
import { memoryBlobCache, memoryKV } from '../src/env.ts';

// ── OpenAI Privacy Filter ─────────────────────────────────

/** Class ids: 0 = O; category c (1-based), tag B/I/E/S -> 1 + (c-1)*4 + {0,1,2,3}. */
const cls = (category: number, tag: 'B' | 'I' | 'E' | 'S'): number => 1 + (category - 1) * 4 + 'BIES'.indexOf(tag);
const PERSON = 5; // private_person

/** Log-probabilities [rows x 33]: each row gives the listed classes their probability, the rest share what is left. */
function logProbs(rows: Array<Record<number, number>>): Float32Array {
  const out = new Float32Array(rows.length * 33);
  rows.forEach((row, t) => {
    const given = Object.values(row).reduce((a, b) => a + b, 0);
    const rest = (1 - given) / (33 - Object.keys(row).length);
    for (let c = 0; c < 33; c++) out[t * 33 + c] = Math.log(row[c] ?? rest);
  });
  return out;
}

describe('OpenAI Privacy Filter decoding (T242)', () => {
  it('Viterbi never takes a forbidden transition: an I after O becomes a valid span', () => {
    // Argmax alone would read O, I-person, I-person, O: not a valid BIOES sequence.
    const lp = logProbs([
      { 0: 0.9 },
      { [cls(PERSON, 'I')]: 0.6, [cls(PERSON, 'B')]: 0.3 },
      { [cls(PERSON, 'I')]: 0.6, [cls(PERSON, 'E')]: 0.3 },
      { 0: 0.9 },
    ]);
    const path = viterbi(lp, 4, buildTransitions());
    expect(path.map((c) => (c === 0 ? 'O' : 'BIES'[(c - 1) % 4]))).toEqual(['O', 'B', 'E', 'O']);
    expect(labelsToSpans(path)).toEqual([[PERSON, 1, 3]]);
  });

  it('labels_to_spans: B..E, S, an open span at the end, and an E of another category', () => {
    expect(labelsToSpans([cls(PERSON, 'B'), cls(PERSON, 'I'), cls(PERSON, 'E'), 0])).toEqual([[PERSON, 0, 3]]);
    expect(labelsToSpans([cls(4, 'S'), 0, cls(PERSON, 'B'), cls(PERSON, 'I')])).toEqual([[4, 0, 1], [PERSON, 2, 4]]);
    expect(labelsToSpans([cls(PERSON, 'B'), cls(2, 'E')])).toEqual([[PERSON, 0, 1], [2, 1, 2]]);
  });

  it('token offsets: a token holding part of a multi-byte letter maps to that whole letter', () => {
    // "żx": ż is C5 BC in UTF-8, written in byte-level BPE as "Å" "¼"; the tokens split it.
    expect(tokenOffsets('żx', ['Å', '¼x'])).toEqual({ starts: [0, 0], ends: [1, 2] });
    // Plain ASCII with the byte-level space "Ġ", and an emoji (two UTF-16 units).
    expect(tokenOffsets('a b', ['a', 'Ġb'])).toEqual({ starts: [0, 1], ends: [1, 3] });
    expect(tokenOffsets('😀a', ['ðŁĺĢ', 'a'])).toEqual({ starts: [0, 2], ends: [2, 3] });
  });

  it('throws when token bytes do not add up to the text', () => {
    expect(() => tokenOffsets('ab', ['a'])).toThrow(/do not add up/);
  });

  it('account_number is sorted by shape: IBAN, Luhn card, else an ID', () => {
    expect(accountNumberType('FR76 3000 6000 0112 3456 7890 189')).toBe('IBAN');
    expect(accountNumberType('4111 1111 1111 1111')).toBe('CREDIT_CARD');
    expect(accountNumberType('4111 1111 1111 1112')).toBe('SSN');
    expect(accountNumberType('12345678Z')).toBe('SSN');
  });

  it('refuses to load without WebGPU, before downloading anything', async () => {
    const fetchFn = vi.fn();
    const provider = new OpenAiPrivacyFilterProvider({
      kv: memoryKV(), modelCache: memoryBlobCache(), fetch: fetchFn as unknown as typeof fetch, wasm: { paths: '/' },
    });
    const gpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
    expect(gpu).toBeUndefined();
    await expect(provider.load()).rejects.toBeInstanceOf(WebGpuUnavailableError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ── BardS.ai v2 / v3 ──────────────────────────────────────

describe('BardS.ai v2/v3 decoding (T240)', () => {
  it('label table: B and I interleave per type, v3 appends DATE_TIME and URL', () => {
    const v2 = bardsaiV2Labels([]);
    expect(v2.column.length).toBe(71);
    expect(v2.types[v2.column[1]]).toBe('ACCOUNT_IDENTIFIER');
    expect(v2.isB[1]).toBe(1);
    expect(v2.types[v2.column[2]]).toBe('ACCOUNT_IDENTIFIER');
    expect(v2.isB[2]).toBe(0);
    expect(v2.types[v2.column[3]]).toBe('AUTH_SECRET');
    expect(v2.types[v2.column[69]]).toBe('VEHICLE_IDENTIFIER');
    expect(v2.column[0]).toBe(v2.types.length);
    const v3 = bardsaiV2Labels(['DATE_TIME', 'URL']);
    expect(v3.column.length).toBe(75);
    expect(v3.types[v3.column[71]]).toBe('DATE_TIME');
    expect(v3.types[v3.column[74]]).toBe('URL');
    expect(v3.isB[73]).toBe(1);
  });

  it('windows: 510 content tokens sharing 128 with the next', () => {
    expect(bardsaiV2Windows(300)).toEqual([[0, 300]]);
    expect(bardsaiV2Windows(1000)).toEqual([[0, 510], [382, 892], [764, 1000]]);
  });

  it('tokenizes piece by piece so double spaces give the lone "▁" tokens, with offsets', () => {
    const vocab: Record<string, number> = { '▁': 9, '▁Jan': 10, '▁Kowal': 11, 'ski': 12, '1': 13, '2': 14 };
    const pieces: Record<string, string[]> = { Jan: ['▁Jan'], Kowalski: ['▁Kowal', 'ski'], '12': ['▁', '1', '2'] };
    const tok = {
      tokenize: (piece: string) => pieces[piece],
      encode: (piece: string) => pieces[piece].map((s) => vocab[s]),
    };
    const { ids, starts } = tokenizeWithOffsets(tok, 9, 'Jan  Kowalski 12');
    // "Jan", then a real space as a lone "▁" (offset -1), "▁Kowal" "ski", "▁" "1" "2".
    expect(ids).toEqual([10, 9, 11, 12, 9, 13, 14]);
    expect(starts).toEqual([0, -1, 5, 10, -1, 14, 15]);
  });

  it('word decoder: merges a name, keeps an e-mail from the regex, re-attaches a legal form\'s dot', () => {
    const text = 'Jan Kowalski, ABC Sp. z o.o. jan@x.pl';
    const { types } = bardsaiV2Labels([]);
    const cols = types.length + 1;
    const acc = new Float64Array(text.length * cols);
    const cnt = new Float64Array(text.length);
    const bmass = new Float64Array(text.length);
    const mark = (from: number, to: number, type: string | null, b: number): void => {
      for (let i = from; i < to; i++) {
        if (text[i] === ' ') continue;
        acc[i * cols + (type ? types.indexOf(type) : types.length)] += 1;
        cnt[i] += 1;
        bmass[i] += b;
      }
    };
    mark(0, 3, 'PERSON_NAME', 1);           // Jan (begins)
    mark(4, 12, 'PERSON_NAME', 0);          // Kowalski (continues)
    mark(14, 27, 'ORGANIZATION_NAME', 0);   // ABC Sp. z o.o
    mark(27, 28, null, 0);                  // the final dot
    mark(29, 37, null, 0);                  // the e-mail, read as O by the "model"
    const spans = decodeWords(text, types, acc, cnt, bmass);
    expect(spans.map((s) => [s.label, text.slice(s.start, s.end)])).toEqual([
      ['PERSON_NAME', 'Jan Kowalski'],
      ['ORGANIZATION_NAME', 'ABC Sp. z o.o.'],
      ['EMAIL_ADDRESS', 'jan@x.pl'],
    ]);
  });
});

// ── GLiNER2 ───────────────────────────────────────────────

describe('GLiNER2 input (T241)', () => {
  it('words are lowercased with their original offsets, and a final "." is added', () => {
    const words = gliner2Words('Jean DUPONT, jean.dupont@ex.fr');
    expect(words.map((w) => w.word)).toEqual(['jean', 'dupont', ',', 'jean.dupont@ex.fr', '.']);
    expect(words[1]).toEqual({ word: 'dupont', start: 5, end: 11 });
    expect(words[4].start).toBe(30);
    expect(gliner2Words('Fin.').map((w) => w.word)).toEqual(['fin', '.']);
  });

  it('schema: ( [P] entities ( [E] label ... ) ) [SEP_TEXT], markers at [P] and each [E]', () => {
    const { items, markers } = gliner2Schema(['person', 'email']);
    expect(items).toEqual(['(', '[P]', 'entities', '(', '[E]', 'person', '[E]', 'email', ')', ')', '[SEP_TEXT]']);
    expect(markers).toEqual([1, 4, 6]);
  });

  it('maps its labels to DocCloak types, custom labels to OTHER', () => {
    expect(gliner2EntityType('person')).toBe('PERSON');
    expect(gliner2EntityType('company')).toBe('COMPANY');
    expect(gliner2EntityType('national_id_number')).toBe('SSN');
    expect(gliner2EntityType('iban')).toBe('IBAN');
    expect(gliner2EntityType('project codename')).toBe('OTHER');
  });
});
