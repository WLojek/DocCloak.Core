/**
 * BardS.ai EU PII v2 / v3 provider (T240).
 *
 * bardsai/eu-pii-anonimization-multilang-v2 and -v3 (Apache-2.0): ModernBERT
 * token classifiers fine-tuned from mmBERT-base (22 layers, 256k vocabulary,
 * 8192 positions), 24 EU languages, the 35 entity types of v1 in BIO tags
 * (v3 adds DATE_TIME and URL). Official dynamic-int8 ONNX, ~309 MB.
 *
 * Nothing of v1's decoding carries over: the tokenizer is a Gemma-style BPE
 * where every number starts with a lone "▁" token (v1's "first sub-token
 * of a word" picks that token, which the model labels O), and the label ids
 * interleave B and I. This follows the model card's word-level decoder
 * (pii_detector.py): 512-token windows overlapping by 128, token
 * probabilities averaged per character over the windows, one label per
 * word from the mean of its tokens with B and I pooled per type, neighbours
 * of the same type merged unless the next word looks like a new entity,
 * format checks, and every regex e-mail taken as EMAIL_ADDRESS. Ported from
 * the research prototype, which matched the Python decoder on 112 of 112
 * corpus documents fed the same onnxruntime-web logits.
 *
 * transformers.js 4.2.0 tokenizes runs of two or more spaces differently
 * from the Python tokenizer (its Metaspace ignores `split`), so the text is
 * tokenized piece by piece between spaces and the lone "▁" tokens Python
 * emits are put back; offsets come from walking the token strings (0 id and
 * 0 offset mismatches against Python on 564 texts).
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { DetectedEntity, DetectionProvider, EntityType, ProgressCallback } from '../types.ts';
import { throwIfAborted } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification, TokenizerFiles, TokenizerFileSpec } from '../model-loader.ts';
import { fetchModelBlob, loadPinnedTokenizer } from '../model-loader.ts';
import { LABEL_TO_ENTITY_TYPE } from './bardsai.ts';

export type BardsaiV2VariantId = 'v2' | 'v3';

interface BardsaiV2Variant {
  id: BardsaiV2VariantId;
  name: string;
  /**
   * Default span threshold (T240 sweep on the 14-language corpus, cached
   * predictions): v3 keeps F1 91.6 at 0.5 (91.8 with none) while 0.5 drops
   * the low-scored junk a court header produces ("DE", "COMMERCE" at
   * 0.31-0.37) that propagation would spread through the document; v2's
   * scores run lower (F1 89.4 with none, 88.2 at 0.3, 82.1 at 0.5).
   */
  threshold: number;
  repo: string;
  model: TokenizerFileSpec;
  tokenizer: TokenizerFiles;
  /** Types after the 35 alphabetical ones (B then I each), in id order. */
  extraTypes: string[];
}

// Pinned 2026-11-02 (T240). v2: the model files last changed 2026-10-19;
// v3: published 2026-10-27. Both share tokenizer.json.
const V2 = 'https://huggingface.co/bardsai/eu-pii-anonimization-multilang-v2/resolve/07a9a69b0d75c551f5f9450b290f864bfc7dfb51';
const V3 = 'https://huggingface.co/bardsai/eu-pii-anonimization-multilang-v3/resolve/091984b5fbce4c161abc4776ed0f4e3206e1b374';
const TOKENIZER_JSON_SHA256 = '609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f';
const TOKENIZER_JSON_SIZE = 34_363_188;

export const BARDSAI_V2_VARIANTS: Record<BardsaiV2VariantId, BardsaiV2Variant> = {
  v2: {
    id: 'v2',
    name: 'BardS.ai EU PII v2',
    threshold: 0.3,
    repo: 'bardsai/eu-pii-anonimization-multilang-v2',
    model: { url: `${V2}/onnx/model_quantized.onnx`, sha256: '1ee975af537a3ae507769703c03fc83880cce7e2706bc6d2dc1fd9db861acfa1', size: 308_618_574 },
    tokenizer: [
      { url: `${V2}/tokenizer.json`, sha256: TOKENIZER_JSON_SHA256, size: TOKENIZER_JSON_SIZE },
      { url: `${V2}/tokenizer_config.json`, sha256: '14b147f2a4f939d9b12ab36e9633917040dd948fa78ce283b03402e4cf2c9cba', size: 574 },
    ],
    extraTypes: [],
  },
  v3: {
    id: 'v3',
    name: 'BardS.ai EU PII v3',
    threshold: 0.5,
    repo: 'bardsai/eu-pii-anonimization-multilang-v3',
    model: { url: `${V3}/onnx/model_quantized.onnx`, sha256: '762c851fd948915cc40c5b226f0c8d19dd3a48064a171368fbc56ba97a8d1ce5', size: 308_593_401 },
    tokenizer: [
      { url: `${V3}/tokenizer.json`, sha256: TOKENIZER_JSON_SHA256, size: TOKENIZER_JSON_SIZE },
      { url: `${V3}/tokenizer_config.json`, sha256: '02055b886266b1a475bc324da83e273fe96e4974002f9d970f26e94aa73e5885', size: 573 },
    ],
    extraTypes: ['DATE_TIME', 'URL'],
  },
};

/** The 35 types of v1, alphabetical: config.json id 2k+1 is B-type_k, 2k+2 is I-type_k. */
const BASE_TYPES = Object.keys(LABEL_TO_ENTITY_TYPE).sort();
const ENTITY_TYPE: Record<string, EntityType> = { ...LABEL_TO_ENTITY_TYPE, DATE_TIME: 'DATE', URL: 'OTHER' };

const BOS_ID = 2;
const EOS_ID = 1;
const META = '▁';
const MAX_LEN = 512;
const STRIDE = 128;

// ── Label table ────────────────────────────────────────────

interface LabelTable {
  types: string[];
  /** Per class: its column (type index, or types.length for O) and whether it is a B tag. */
  column: Int32Array;
  isB: Float64Array;
}

export function bardsaiV2Labels(extraTypes: string[]): LabelTable {
  const ordered = [...BASE_TYPES, ...extraTypes];
  const n = 1 + 2 * ordered.length;
  const types = [...ordered].sort();
  const column = new Int32Array(n);
  const isB = new Float64Array(n);
  column[0] = types.length;
  ordered.forEach((type, k) => {
    column[1 + 2 * k] = types.indexOf(type);
    column[2 + 2 * k] = types.indexOf(type);
    isB[1 + 2 * k] = 1;
  });
  return { types, column, isB };
}

// ── Tokenization with offsets ──────────────────────────────

const BYTE_TOKEN = /^<0x([0-9A-F]{2})>$/;

function utf8Length(lead: number): number {
  return lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tokenizer = any;

/**
 * Ids of the whole text without <bos>/<eos>, as Python's tokenizer gives
 * them, and per token the UTF-16 index of the first non-space character it
 * covers (-1 for whitespace and the lone "▁" that stands for a space).
 */
export function tokenizeWithOffsets(tok: Tokenizer, metaId: number, text: string): { ids: number[]; starts: number[] } {
  const ids: number[] = [];
  const starts: number[] = [];
  const pieces: Array<[number, number, number]> = [];
  const spaces = / +/g;
  let pieceStart = 0;
  let m: RegExpExecArray | null;
  while ((m = spaces.exec(text)) !== null) {
    pieces.push([pieceStart, m.index, m[0].length]);
    pieceStart = m.index + m[0].length;
  }
  pieces.push([pieceStart, text.length, 0]);
  let spacesBefore = 0;
  for (const [ps, pe, spacesAfter] of pieces) {
    const piece = text.slice(ps, pe);
    if (piece.length === 0) { spacesBefore += spacesAfter; continue; }
    const strs: string[] = tok.tokenize(piece);
    const pids: number[] = Array.from(tok.encode(piece, { add_special_tokens: false }) as ArrayLike<number>);
    if (strs.length !== pids.length) throw new Error('BardS.ai v2: tokenize and encode disagree');
    const extra = Math.max(0, spacesBefore - (strs[0]?.startsWith(META) ? 1 : 0));
    for (let k = 0; k < extra; k++) { ids.push(metaId); starts.push(-1); }
    let pos = 0;
    let pendingBytes = 0;
    let charStart = -1;
    for (let t = 0; t < strs.length; t++) {
      const s = strs[t];
      ids.push(pids[t]);
      const byte = BYTE_TOKEN.exec(s);
      if (byte) {
        const b = parseInt(byte[1], 16);
        if (pendingBytes === 0) { pendingBytes = utf8Length(b); charStart = pos; }
        starts.push(ps + charStart);
        if (--pendingBytes === 0) pos += String.fromCodePoint(piece.codePointAt(charStart)!).length;
        continue;
      }
      const body = s.startsWith(META) ? s.slice(1) : s;
      if (body.length === 0) {
        // A lone "▁": a real space before the piece counts for nothing; one the
        // tokenizer prepends (text start, after a newline token) counts for the next word.
        const real = t === 0 && spacesBefore > 0;
        starts.push(!real && pos < piece.length && !/\s/.test(piece[pos]) ? ps + pos : -1);
        continue;
      }
      if (!piece.startsWith(body, pos)) throw new Error(`BardS.ai v2: token offsets lost sync at ${ps + pos}`);
      starts.push(/^\s+$/.test(body) ? -1 : ps + pos + (body.length - body.trimStart().length));
      pos += body.length;
    }
    if (pos !== piece.length) throw new Error('BardS.ai v2: token offsets did not cover the text');
    spacesBefore = spacesAfter;
  }
  for (let k = 0; k < spacesBefore; k++) { ids.push(metaId); starts.push(-1); }
  return { ids, starts };
}

/** Windows of 510 content tokens sharing STRIDE tokens (Hugging Face overflow windows). */
export function bardsaiV2Windows(n: number): Array<[number, number]> {
  const cap = MAX_LEN - 2;
  const step = cap - STRIDE;
  const out: Array<[number, number]> = [];
  for (let s = 0; ; s += step) {
    out.push([s, Math.min(n, s + cap)]);
    if (s + cap >= n) break;
  }
  return out;
}

// ── Word decoder (pii_detector.py) ─────────────────────────

const WORD_RE = /[^\s,;|"<>()[\]{}*^]+/gu;
const LEAD_TRIM = new Set(['(', '[', '{', '<', '"', "'", '«', '„']);
const TAIL_TRIM = new Set([')', ']', '}', '>', '"', "'", '»', '.', ',', ';', ':', '!', '?']);
const W = '[\\p{L}\\p{N}_]';
const EMAIL_RE = /(?<![\p{L}\p{N}_.+-])[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.[A-Za-z]{2,}(?![\p{L}\p{N}_-])/gu;
const URLISH_RE = new RegExp(`(https?://|www\\.|${W}\\.[a-zA-Z]{2,}(?!${W})|/${W})`, 'iu');
const ID_TYPES = new Set(['PERSON_IDENTIFIER', 'BANK_ACCOUNT_IDENTIFIER', 'PAYMENT_CARD', 'ACCOUNT_IDENTIFIER', 'DOCUMENT_IDENTIFIER', 'VEHICLE_IDENTIFIER']);
const GAP_OK = /^[ ,\-/.()]*$/u;

interface DecodedSpan { start: number; end: number; label: string; score: number }

function formatOk(text: string, start: number, end: number, type: string): boolean {
  const value = text.slice(start, end);
  const digits = (value.match(/\p{Nd}/gu) ?? []).length;
  if (type === 'IDENTIFYING_LINK' || type === 'URL') return URLISH_RE.test(value);
  if (type === 'PHONE_NUMBER') return digits >= 5;
  if (ID_TYPES.has(type)) return digits >= 2;
  return true;
}

/**
 * Words labelled from the per-character sums of token probabilities: acc
 * [chars x columns], cnt (tokens starting at the character), bmass (their
 * B probability).
 */
export function decodeWords(text: string, types: string[], acc: Float64Array, cnt: Float64Array, bmass: Float64Array): DecodedSpan[] {
  const cols = types.length + 1;
  const oCol = types.length;
  const spans: Array<{ start: number; end: number; label: string; scores: number[] }> = [];
  for (const m of text.matchAll(WORD_RE)) {
    let ws = m.index!;
    let we = ws + m[0].length;
    while (ws < we && LEAD_TRIM.has(text[ws])) ws++;
    while (we > ws && TAIL_TRIM.has(text[we - 1])) we--;
    if (we <= ws) continue;
    const v = new Float64Array(cols);
    let c = 0;
    let first = -1;
    for (let i = ws; i < we; i++) {
      if (cnt[i] > 0) {
        if (first < 0) first = i;
        c += cnt[i];
        for (let k = 0; k < cols; k++) v[k] += acc[i * cols + k];
      }
    }
    if (first < 0) continue;
    let best = 0;
    for (let k = 1; k < cols; k++) if (v[k] > v[best]) best = k;
    if (best === oCol) continue;
    const score = v[best] / c;
    const startsAsB = bmass[first] / Math.max(cnt[first], 1);
    const label = types[best];
    const prev = spans[spans.length - 1];
    const gap = prev ? text.slice(prev.end, ws) : '';
    if (prev && prev.label === label && GAP_OK.test(gap) && !gap.includes('\n\n') && startsAsB < 0.5) {
      prev.end = we;
      prev.scores.push(score);
    } else {
      spans.push({ start: ws, end: we, label, scores: [score] });
    }
  }
  let out: DecodedSpan[] = spans
    .filter((s) => formatOk(text, s.start, s.end, s.label))
    .map((s) => ({ start: s.start, end: s.end, label: s.label, score: s.scores.reduce((a, b) => a + b, 0) / s.scores.length }));
  const emails = [...text.matchAll(EMAIL_RE)].map((e) => [e.index!, e.index! + e[0].length] as const);
  if (emails.length > 0) {
    out = out
      .filter((o) => !emails.some(([a, b]) => o.start < b && a < o.end))
      .concat(emails.map(([a, b]) => ({ start: a, end: b, label: 'EMAIL_ADDRESS', score: 1 })));
  }
  // DocCloak post-rule: the decoder trims a legal form's final "." ("S.A.", "Sp. z o.o.").
  for (const o of out) {
    if (o.label === 'ORGANIZATION_NAME' && text[o.end] === '.') o.end++;
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ── Provider ──────────────────────────────────────────────

export class BardsaiV2Provider implements DetectionProvider {
  private readonly env: CoreEnv;
  private readonly variant: BardsaiV2Variant;
  private readonly labels: LabelTable;
  private readonly modelOverride?: TokenizerFileSpec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null;
  private metaId = 0;
  private session: ort.InferenceSession | null = null;
  private loading = false;
  private loadError: Error | null = null;
  private loadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private progressCallback: ProgressCallback | null = null;
  private threshold: number;
  private verification: ModelVerification | null = null;

  constructor(env: CoreEnv, options: { variant?: BardsaiV2VariantId; modelOverride?: TokenizerFileSpec } = {}) {
    this.env = env;
    this.variant = BARDSAI_V2_VARIANTS[options.variant ?? 'v2'];
    this.labels = bardsaiV2Labels(this.variant.extraTypes);
    this.threshold = this.variant.threshold;
    this.modelOverride = options.modelOverride;
  }

  get name(): string { return this.variant.name; }
  getVerification(): ModelVerification | null { return this.verification; }
  isLoaded(): boolean { return this.session !== null && this.tokenizer !== null; }
  isLoading(): boolean { return this.loading; }
  onProgress(callback: ProgressCallback): void { this.progressCallback = callback; }
  setThreshold(value: number): void { this.threshold = Math.max(0.05, Math.min(0.95, value)); }
  getThreshold(): number { return this.threshold; }

  async load(): Promise<void> {
    if (this.isLoaded()) return;
    if (this.loadError) throw this.loadError;
    if (this.loading) {
      return new Promise<void>((resolve, reject) => { this.loadWaiters.push({ resolve, reject }); });
    }
    this.loading = true;
    try {
      ort.env.wasm.wasmPaths = this.env.wasm.paths;
      ort.env.wasm.numThreads = this.env.wasm.numThreads ?? 1;
      const loaderEnv: ModelLoaderEnv = { cache: this.env.modelCache, fetch: this.env.fetch, persistStorage: this.env.persistStorage };
      const model = this.modelOverride ?? this.variant.model;
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, model.url, (d, t) => this.progressCallback?.(d, t), {
          sha256: model.sha256,
          size: model.size,
          onVerified: (verification) => {
            this.verification = verification;
            console.info(`[DocCloak] Model verified: ${this.name} SHA-256 ${verification.sha256.slice(0, 12)}... matches the published hash`);
          },
        }),
      ];
      if (!this.tokenizer) {
        tasks.push(loadPinnedTokenizer(this.env, this.variant.tokenizer, this.variant.repo).then((t: unknown) => { this.tokenizer = t; }));
      }
      const [modelBlob] = await Promise.all(tasks) as [Blob];
      const meta: number[] = Array.from(this.tokenizer.encode(META, { add_special_tokens: false }) as ArrayLike<number>);
      if (meta.length !== 1) throw new Error('BardS.ai v2: the tokenizer has no single "▁" token');
      this.metaId = meta[0];
      const bytes = new Uint8Array(await modelBlob.arrayBuffer());
      this.session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      console.info(`[DocCloak] Model loaded: ${this.name} | inputs: [${this.session.inputNames.join(', ')}] | outputs: [${this.session.outputNames.join(', ')}]`);
      this.loading = false;
      this.loadWaiters.forEach((w) => w.resolve());
      this.loadWaiters.length = 0;
    } catch (err) {
      this.session = null;
      this.loadError = err instanceof Error ? err : new Error(String(err));
      this.loading = false;
      this.loadWaiters.forEach((w) => w.reject(this.loadError!));
      this.loadWaiters.length = 0;
      throw this.loadError;
    }
  }

  release(): void {
    if (this.session) {
      void this.session.release();
      this.session = null;
    }
    this.loading = false;
    this.loadError = null;
  }

  async detect(text: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]> {
    throwIfAborted(signal);
    if (!this.isLoaded()) await this.load();
    if (!this.session || !this.tokenizer) return [];
    if (!text.trim()) return [];
    onProgress?.(0);

    const { ids, starts } = tokenizeWithOffsets(this.tokenizer, this.metaId, text);
    const { types, column, isB } = this.labels;
    const cols = types.length + 1;
    const numClasses = column.length;
    const acc = new Float64Array(text.length * cols);
    const cnt = new Float64Array(text.length);
    const bmass = new Float64Array(text.length);
    const windows = bardsaiV2Windows(ids.length);
    const p = new Float64Array(numClasses);
    for (let wi = 0; wi < windows.length; wi++) {
      throwIfAborted(signal);
      const [a, b] = windows[wi];
      // One window per run, never padded: padding moves the int8 model's logits.
      const winIds = [BOS_ID, ...ids.slice(a, b), EOS_ID];
      const out = await this.session.run({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(winIds, (v) => BigInt(v)), [1, winIds.length]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(winIds.length).fill(1n), [1, winIds.length]),
      });
      const logits = out.logits.data as Float32Array;
      for (let j = 1; j < winIds.length - 1; j++) {
        const s = starts[a + j - 1];
        if (s < 0) continue;
        const o = j * numClasses;
        let max = -Infinity;
        for (let l = 0; l < numClasses; l++) if (logits[o + l] > max) max = logits[o + l];
        let z = 0;
        for (let l = 0; l < numClasses; l++) { p[l] = Math.exp(logits[o + l] - max); z += p[l]; }
        for (let l = 0; l < numClasses; l++) {
          const q = p[l] / z;
          acc[s * cols + column[l]] += q;
          bmass[s] += q * isB[l];
        }
        cnt[s] += 1;
      }
      onProgress?.((wi + 1) / windows.length);
      await new Promise((r) => setTimeout(r, 0));
    }

    return decodeWords(text, types, acc, cnt, bmass)
      .filter((s) => s.score >= this.threshold)
      .map((s) => ({
        type: ENTITY_TYPE[s.label] ?? 'OTHER',
        value: text.slice(s.start, s.end),
        start: s.start,
        end: s.end,
        confidence: s.score,
        detector: `bardsai-${this.variant.id}:${s.label}`,
      }));
  }
}
