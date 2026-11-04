/**
 * OpenAI Privacy Filter provider (T242).
 *
 * openai/privacy-filter: a 1.4B-parameter mixture-of-experts token classifier
 * (8 layers, 128 experts, top-4 routing, about 50M parameters per token), 8
 * PII categories tagged BIOES (33 classes), byte-level BPE tokenizer
 * (o200k). Apache-2.0. The 4-bit ONNX export needs WebGPU: q4f16 (809 MB)
 * where the adapter has `shader-f16`, q4 (917 MB) otherwise. The CPU kernels
 * of the onnxruntime-web/webgpu build lack GatherBlockQuantized, so WASM is
 * not offered in the browser; the eval harness runs a graph with that one
 * node replaced (`graphOverride`).
 *
 * Decoding follows the official code (github.com/openai/privacy-filter,
 * opf/_core/decoding.py and spans.py): log-softmax per token, a constrained
 * BIOES Viterbi over the whole document with the six transition biases of
 * viterbi_calibration.json (all 0.0 at the pinned commit), token spans to
 * character spans through UTF-8 byte offsets, whitespace trimmed, spans kept
 * left to right without overlap. The model gives no confidences; a span's
 * confidence here is the mean probability of its category over its tokens.
 *
 * Long texts: windows of 1024 tokens with 256 tokens of context on each side
 * (only each window's own tokens are kept), then one Viterbi pass. On a
 * 7,312-token document this gave exactly the spans of a single pass.
 *
 * Environment-agnostic like the other providers: bytes come through
 * fetchModelBlob (pinned SHA-256 + size, blob cache), the tokenizer through
 * CoreEnv.buildTokenizer.
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { DetectedEntity, DetectionProvider, EntityType, ProgressCallback } from '../types.ts';
import { throwIfAborted } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification, TokenizerFiles, TokenizerFileSpec } from '../model-loader.ts';
import { fetchModelBlob, loadPinnedTokenizer } from '../model-loader.ts';

// ── Model config ──────────────────────────────────────────
// Pinned 2026-11-02 (T242): main of openai/privacy-filter, last modified
// 2026-04-22. Hashes measured against the resolve/<commit> URLs.
export const OPENAI_PF_REVISION = '7ffa9a043d54d1be65afb281eddf0ffbe629385b';
const BASE = `https://huggingface.co/openai/privacy-filter/resolve/${OPENAI_PF_REVISION}`;

/** One ONNX variant: the graph and its external weights file. */
export interface PrivacyFilterVariant {
  id: 'q4f16' | 'q4';
  graph: TokenizerFileSpec;
  data: TokenizerFileSpec;
  /** The initializers' `location`: ONNX Runtime matches externalData by this name. */
  dataPath: string;
}

export const OPENAI_PF_VARIANTS: Record<'q4f16' | 'q4', PrivacyFilterVariant> = {
  q4f16: {
    id: 'q4f16',
    graph: { url: `${BASE}/onnx/model_q4f16.onnx`, sha256: 'eaae4e83cf1345a60abe333ed882b55fe5775d1dfbf34b9b269e5e5416f45e5b', size: 165_744 },
    data: { url: `${BASE}/onnx/model_q4f16.onnx_data`, sha256: '6d4dde787e03ace283c45d4e32a94eec32b6cfcc242e7219bea96f5b4c13569d', size: 809_061_992 },
    dataPath: 'model_q4f16.onnx_data',
  },
  q4: {
    id: 'q4',
    graph: { url: `${BASE}/onnx/model_q4.onnx`, sha256: '8f7dee8b46d096f052b359375dfba5d983cc4d18c44a783bf548615c472f8dea', size: 160_219 },
    data: { url: `${BASE}/onnx/model_q4.onnx_data`, sha256: 'f30998e28c71c5374cc7e8b7de8f0f83e981592c0c2d652d2ad4928454dbb496', size: 917_120_144 },
    dataPath: 'model_q4.onnx_data',
  },
};

export const OPENAI_PF_TOKENIZER_FILES: TokenizerFiles = [
  { url: `${BASE}/tokenizer.json`, sha256: '0614fe83cadab421296e664e1f48f4261fa8fef6e03e63bb75c20f38e37d07d3', size: 27_868_174 },
  { url: `${BASE}/tokenizer_config.json`, sha256: '6c14af9ce1a284d3c3c5146b26efe4cd589c68e1dd4e9d94455606ec911ba774', size: 234 },
];
const TOKENIZER_HF = 'openai/privacy-filter';
const MODEL_NAME = 'OpenAI Privacy Filter';
const DEFAULT_THRESHOLD = 0.5;
/** Tokens each window keeps, and the context it sees on each side (§1.10 of the research). */
const WINDOW_CORE = 1024;
const WINDOW_MARGIN = 256;

/** id2label of config.json: O, then B/I/E/S for each category in this order. */
const CATEGORIES = [
  'account_number', 'private_address', 'private_date', 'private_email',
  'private_person', 'private_phone', 'private_url', 'secret',
] as const;
const NUM_CLASSES = 1 + 4 * CATEGORIES.length;
const TAGS = ['B', 'I', 'E', 'S'] as const;

/**
 * viterbi_calibration.json at the pinned commit: one "default" operating
 * point whose six transition biases are all 0.0.
 */
const TRANSITION_BIASES = {
  backgroundStay: 0,
  backgroundToStart: 0,
  insideToContinue: 0,
  insideToEnd: 0,
  endToBackground: 0,
  endToStart: 0,
};

/** Class index -> tag ('B' | 'I' | 'E' | 'S', null for O) and category (0 = O, 1..8). */
function classInfo(c: number): { tag: (typeof TAGS)[number] | null; category: number } {
  if (c === 0) return { tag: null, category: 0 };
  return { tag: TAGS[(c - 1) % 4], category: Math.floor((c - 1) / 4) + 1 };
}

const NEG = -1e9;

interface Transitions {
  start: Float64Array;
  end: Float64Array;
  trans: Float64Array;
}

/** Allowed BIOES transitions with their biases; everything else is -1e9 (forbidden). */
export function buildTransitions(biases = TRANSITION_BIASES): Transitions {
  const n = NUM_CLASSES;
  const start = new Float64Array(n).fill(NEG);
  const end = new Float64Array(n).fill(NEG);
  const trans = new Float64Array(n * n).fill(NEG);
  for (let i = 0; i < n; i++) {
    const a = classInfo(i);
    const aOut = a.category === 0 || a.tag === 'E' || a.tag === 'S';
    if (a.category === 0 || a.tag === 'B' || a.tag === 'S') start[i] = 0;
    if (aOut) end[i] = 0;
    for (let j = 0; j < n; j++) {
      const b = classInfo(j);
      const bStarts = b.tag === 'B' || b.tag === 'S';
      if (aOut) {
        if (b.category !== 0 && !bStarts) continue;
        if (a.category === 0) trans[i * n + j] = b.category === 0 ? biases.backgroundStay : biases.backgroundToStart;
        else trans[i * n + j] = b.category === 0 ? biases.endToBackground : biases.endToStart;
      } else {
        // B-x or I-x continues only into I-x or E-x of the same category.
        if (b.category !== a.category || (b.tag !== 'I' && b.tag !== 'E')) continue;
        trans[i * n + j] = b.tag === 'I' ? biases.insideToContinue : biases.insideToEnd;
      }
    }
  }
  return { start, end, trans };
}

/** In place: logits [T*C] -> log-probabilities per row. */
function logSoftmaxRows(x: Float32Array, rows: number, cols: number): void {
  for (let t = 0; t < rows; t++) {
    const o = t * cols;
    let max = -Infinity;
    for (let c = 0; c < cols; c++) if (x[o + c] > max) max = x[o + c];
    let sum = 0;
    for (let c = 0; c < cols; c++) sum += Math.exp(x[o + c] - max);
    const lse = max + Math.log(sum);
    for (let c = 0; c < cols; c++) x[o + c] -= lse;
  }
}

/** Constrained Viterbi over log-probabilities [T*C]; returns the class path. */
export function viterbi(logp: Float32Array, rows: number, tables: Transitions): number[] {
  const n = NUM_CLASSES;
  if (rows === 0) return [];
  let scores = new Float64Array(n);
  let next = new Float64Array(n);
  for (let c = 0; c < n; c++) scores[c] = logp[c] + tables.start[c];
  const back = new Int32Array(Math.max(0, rows - 1) * n);
  for (let t = 1; t < rows; t++) {
    for (let j = 0; j < n; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i < n; i++) {
        const v = scores[i] + tables.trans[i * n + j];
        if (v > best) { best = v; arg = i; }
      }
      next[j] = best + logp[t * n + j];
      back[(t - 1) * n + j] = arg;
    }
    [scores, next] = [next, scores];
  }
  let last = 0;
  let best = -Infinity;
  for (let c = 0; c < n; c++) {
    const v = scores[c] + tables.end[c];
    if (v > best) { best = v; last = c; }
  }
  const path = new Array<number>(rows);
  path[rows - 1] = last;
  for (let t = rows - 2; t >= 0; t--) {
    last = back[t * n + last];
    path[t] = last;
  }
  return path;
}

/** Token spans [category, firstToken, endToken) from a class path, as opf's labels_to_spans. */
export function labelsToSpans(path: number[]): Array<[number, number, number]> {
  const spans: Array<[number, number, number]> = [];
  let cur: number | null = null;
  let st = 0;
  let prev = -1;
  for (let idx = 0; idx < path.length; idx++) {
    const { tag, category } = classInfo(path[idx]);
    if (category === 0) {
      if (cur !== null) spans.push([cur, st, idx]);
      cur = null;
    } else if (tag === 'S') {
      if (cur !== null) spans.push([cur, st, prev + 1]);
      spans.push([category, idx, idx + 1]);
      cur = null;
    } else if (tag === 'B') {
      if (cur !== null) spans.push([cur, st, prev + 1]);
      cur = category;
      st = idx;
    } else if (tag === 'I') {
      if (cur === null || cur !== category) {
        if (cur !== null) spans.push([cur, st, prev + 1]);
        cur = category;
        st = idx;
      }
    } else {
      if (cur === null || cur !== category) {
        if (cur !== null) spans.push([cur, st, prev + 1]);
        spans.push([category, idx, idx + 1]);
      } else {
        spans.push([cur, st, idx + 1]);
      }
      cur = null;
    }
    prev = idx;
  }
  if (cur !== null) spans.push([cur, st, prev + 1]);
  return spans;
}

// ── Byte-level token offsets ───────────────────────────────

/** GPT-2 byte-level alphabet inverted: the character a byte is written as -> the byte. */
const UNICODE_TO_BYTE: ReadonlyMap<string, number> = (() => {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + extra); extra++; }
  }
  const map = new Map<string, number>();
  bs.forEach((b, i) => map.set(String.fromCodePoint(cs[i]), b));
  return map;
})();

const encoder = new TextEncoder();

/** UTF-8 byte length of one token string (byte-level characters, or a special token's own text). */
function tokenByteLength(token: string): number {
  let n = 0;
  for (const ch of token) {
    if (!UNICODE_TO_BYTE.has(ch)) return encoder.encode(token).length;
    n++;
  }
  return n;
}

function bisectRight(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (x < a[m]) hi = m; else lo = m + 1; }
  return lo;
}

function bisectLeft(a: number[], x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * UTF-16 [start, end) of every token, as opf's token_char_ranges: a UTF-8
 * byte cursor over the tokens' bytes; a token holding part of a multi-byte
 * character maps to that whole character.
 */
export function tokenOffsets(text: string, tokens: string[]): { starts: number[]; ends: number[] } {
  const charByteStart: number[] = [];
  const charByteEnd: number[] = [];
  const charUnit: number[] = [];
  let byte = 0;
  let unit = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    charByteStart.push(byte);
    byte += len;
    charByteEnd.push(byte);
    charUnit.push(unit);
    unit += ch.length;
  }
  charUnit.push(unit);
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const b0 = cursor;
    const b1 = cursor + tokenByteLength(token);
    cursor = b1;
    const si = bisectRight(charByteEnd, b0);
    const ei = Math.max(si, bisectLeft(charByteStart, b1));
    starts.push(charUnit[si]);
    ends.push(charUnit[ei]);
  }
  if (cursor !== byte) throw new Error(`OpenAI Privacy Filter: token bytes (${cursor}) do not add up to the text (${byte})`);
  return { starts, ends };
}

// ── Category -> EntityType ────────────────────────────────

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * account_number covers IBANs, cards and national IDs alike (DNI, codice
 * fiscale in the tests): sorted by shape.
 */
export function accountNumberType(value: string): EntityType {
  const compact = value.replace(/[\s-]/g, '');
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/i.test(compact)) return 'IBAN';
  if (/^\d{13,19}$/.test(compact) && luhnValid(compact)) return 'CREDIT_CARD';
  return 'SSN';
}

function entityTypeFor(category: string, value: string): EntityType {
  switch (category) {
    case 'private_person': return 'PERSON';
    case 'private_email': return 'EMAIL';
    case 'private_phone': return 'PHONE';
    case 'private_address': return 'ADDRESS';
    case 'private_date': return 'DATE';
    case 'secret': return 'SECRET';
    case 'account_number': return accountNumberType(value);
    default: return 'OTHER';
  }
}

// ── Provider ──────────────────────────────────────────────

export interface OpenAiPrivacyFilterOptions {
  /** Force a variant; by default q4f16 where the GPU has shader-f16, else q4. */
  variant?: 'q4f16' | 'q4';
  /** 'webgpu' in browsers (default); 'wasm' only with a graph that avoids GatherBlockQuantized (eval). */
  executionProvider?: 'webgpu' | 'wasm';
  /** Replace the variant's graph file (eval: a graph whose embedding lookup the CPU kernels can run). */
  graphOverride?: TokenizerFileSpec;
}

/** Thrown when the browser has no WebGPU adapter: this model does not run there. */
export class WebGpuUnavailableError extends Error {
  constructor(detail: string) {
    super(`OpenAI Privacy Filter needs WebGPU: ${detail}`);
    this.name = 'WebGpuUnavailableError';
  }
}

interface GpuLike {
  requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null>;
}

/** The variant this device should run: q4f16 needs the adapter's shader-f16 feature. */
async function pickVariant(): Promise<'q4f16' | 'q4'> {
  const gpu = (globalThis as { navigator?: { gpu?: GpuLike } }).navigator?.gpu;
  if (!gpu) throw new WebGpuUnavailableError('this browser does not offer it');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new WebGpuUnavailableError('no GPU adapter is available');
  return adapter.features.has('shader-f16') ? 'q4f16' : 'q4';
}

export class OpenAiPrivacyFilterProvider implements DetectionProvider {
  readonly name = MODEL_NAME;

  private readonly env: CoreEnv;
  private readonly options: OpenAiPrivacyFilterOptions;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null;
  private session: ort.InferenceSession | null = null;
  private loading = false;
  private loadError: Error | null = null;
  private loadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private progressCallback: ProgressCallback | null = null;
  private threshold = DEFAULT_THRESHOLD;
  private verification: ModelVerification | null = null;
  private readonly transitions = buildTransitions();
  private variantId: 'q4f16' | 'q4' | null = null;

  constructor(env: CoreEnv, options: OpenAiPrivacyFilterOptions = {}) {
    this.env = env;
    this.options = options;
  }

  getVerification(): ModelVerification | null { return this.verification; }
  /** The ONNX variant in use once loaded ('q4f16' or 'q4'). */
  getVariant(): 'q4f16' | 'q4' | null { return this.variantId; }
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
      const ep = this.options.executionProvider ?? 'webgpu';
      const variantId = this.options.variant ?? (ep === 'webgpu' ? await pickVariant() : 'q4');
      const variant = OPENAI_PF_VARIANTS[variantId];
      const graph = this.options.graphOverride ?? variant.graph;
      ort.env.wasm.wasmPaths = this.env.wasm.paths;
      ort.env.wasm.numThreads = this.env.wasm.numThreads ?? 1;

      const loaderEnv: ModelLoaderEnv = { cache: this.env.modelCache, fetch: this.env.fetch, persistStorage: this.env.persistStorage };
      // One progress total over the weights and the graph (the tokenizer is small next to them).
      const loaded = { graph: 0, data: 0 };
      const total = graph.size + variant.data.size;
      const report = (): void => this.progressCallback?.(loaded.graph + loaded.data, total);
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, graph.url, (d) => { loaded.graph = d; report(); }, { sha256: graph.sha256, size: graph.size }),
        fetchModelBlob(loaderEnv, variant.data.url, (d) => { loaded.data = d; report(); }, {
          sha256: variant.data.sha256,
          size: variant.data.size,
          onVerified: (verification) => {
            this.verification = verification;
            console.info(`[DocCloak] Model verified: ${MODEL_NAME} (${variantId}) SHA-256 ${verification.sha256.slice(0, 12)}... matches the published hash`);
          },
        }),
      ];
      if (!this.tokenizer) {
        tasks.push(loadPinnedTokenizer(this.env, OPENAI_PF_TOKENIZER_FILES, TOKENIZER_HF).then((t: unknown) => { this.tokenizer = t; }));
      }
      const [graphBlob, dataBlob] = await Promise.all(tasks) as [Blob, Blob];
      const graphBytes = new Uint8Array(await graphBlob.arrayBuffer());
      this.session = await ort.InferenceSession.create(graphBytes, {
        executionProviders: [ep],
        // On WebGPU the weights go from this Blob straight into GPU buffers.
        externalData: [{ path: variant.dataPath, data: dataBlob }],
      });
      this.variantId = variantId;
      console.info(`[DocCloak] Model loaded: ${MODEL_NAME} (${variantId}, ${ep}) | inputs: [${this.session.inputNames.join(', ')}] | outputs: [${this.session.outputNames.join(', ')}]`);
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

    // No special tokens are added by this tokenizer: the ids are the text's own tokens.
    const ids: number[] = Array.from(this.tokenizer.encode(text, { add_special_tokens: false }) as ArrayLike<number>);
    const tokens: string[] = this.tokenizer.tokenize(text);
    if (tokens.length !== ids.length) throw new Error(`OpenAI Privacy Filter: ${tokens.length} token strings for ${ids.length} ids`);
    const offsets = tokenOffsets(text, tokens);
    const rows = ids.length;
    const logits = new Float32Array(rows * NUM_CLASSES);
    onProgress?.(0.05);

    const windows = Math.max(1, Math.ceil(rows / WINDOW_CORE));
    for (let w = 0; w < windows; w++) {
      throwIfAborted(signal);
      const coreStart = w * WINDOW_CORE;
      const coreEnd = Math.min(rows, coreStart + WINDOW_CORE);
      const from = Math.max(0, coreStart - WINDOW_MARGIN);
      const to = Math.min(rows, coreEnd + WINDOW_MARGIN);
      const len = to - from;
      const inputIds = new BigInt64Array(len);
      for (let i = 0; i < len; i++) inputIds[i] = BigInt(ids[from + i]);
      const mask = new BigInt64Array(len).fill(1n);
      const out = await this.session.run({
        input_ids: new ort.Tensor('int64', inputIds, [1, len]),
        attention_mask: new ort.Tensor('int64', mask, [1, len]),
      });
      const windowLogits = out.logits;
      const data = windowLogits.data as Float32Array;
      logits.set(data.subarray((coreStart - from) * NUM_CLASSES, (coreEnd - from) * NUM_CLASSES), coreStart * NUM_CLASSES);
      windowLogits.dispose?.();
      onProgress?.(0.05 + 0.9 * ((w + 1) / windows));
      await new Promise((r) => setTimeout(r, 0));
    }

    logSoftmaxRows(logits, rows, NUM_CLASSES);
    const path = viterbi(logits, rows, this.transitions);
    const found: DetectedEntity[] = [];
    for (const [category, first, end] of labelsToSpans(path)) {
      let a = offsets.starts[first];
      let b = offsets.ends[end - 1];
      while (a < b && /\s/u.test(text[a])) a++;
      while (b > a && /\s/u.test(text[b - 1])) b--;
      if (b <= a) continue;
      // Confidence: mean probability of the span's category (its B, I, E and S classes) over its tokens.
      let sum = 0;
      for (let t = first; t < end; t++) {
        const o = t * NUM_CLASSES + 1 + (category - 1) * 4;
        sum += Math.exp(logits[o]) + Math.exp(logits[o + 1]) + Math.exp(logits[o + 2]) + Math.exp(logits[o + 3]);
      }
      const confidence = sum / (end - first);
      if (confidence < this.threshold) continue;
      const name = CATEGORIES[category - 1];
      const value = text.slice(a, b);
      found.push({ type: entityTypeFor(name, value), value, start: a, end: b, confidence, detector: `openai-pf:${name}` });
    }
    // Left to right, longest first, no overlaps (opf's discard of overlapping spans).
    found.sort((x, y) => x.start - y.start || (y.end - y.start) - (x.end - x.start));
    const kept: DetectedEntity[] = [];
    let cursor = 0;
    for (const e of found) {
      if (e.start < cursor) continue;
      kept.push(e);
      cursor = e.end;
    }
    onProgress?.(1);
    return kept;
  }
}
