/**
 * GLiNER2 Privacy Filter provider (T241).
 *
 * fastino/gliner2-privacy-filter-PII-multi (Apache-2.0): a GLiNER2 span model
 * on mDeBERTa-v3-base, trained on 42 PII labels in English, French, Spanish,
 * German, Italian, Portuguese and Dutch. Zero-shot: the labels are part of
 * the input, so custom labels work. Fastino publishes no ONNX; two community
 * exports of the same weights are offered (both checked weight by weight
 * against the official checkpoint and span by span against the gliner2
 * package in the T241 research):
 *
 * - 'okasi-q8' (okasi/gliner2-privacy-filter-pii-multi-onnx, ~550 MB): 8-bit
 *   MatMulNBits, fp16 embedding, graph + external data. The published graph
 *   bakes 7 labels in; DocCloak serves a 1 MB derived graph that takes the
 *   label positions as an input (`schema_positions`) and reads okasi's
 *   weights file unchanged.
 * - 'yethdev' (yethdev/gliner2-pii-onnx, ~446 MB): one file, int8
 *   embedding, fp16 weights, labels as an input natively, count gate inside.
 *
 * Inference follows gliner2 2.1.0 (processor.py, inference/runtime.py):
 * the text is split into lowercased words, prefixed by the schema prompt
 * `( [P] entities ( [E] label ... ) ) [SEP_TEXT]`, each item tokenized on
 * its own; the model scores every span of up to 8 words against every
 * label; a count head that predicts 0 entities silences the chunk; spans at
 * or above the threshold are kept per label without overlap. Chunks stay
 * within the encoder's 512 training positions, prompt included.
 */

import * as ort from 'onnxruntime-web/webgpu';
import type { DetectedEntity, DetectionProvider, EntityType, ProgressCallback } from '../types.ts';
import { throwIfAborted } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification, TokenizerFiles, TokenizerFileSpec } from '../model-loader.ts';
import { fetchModelBlob, loadPinnedTokenizer } from '../model-loader.ts';
import { greedySelect, type RawSpan } from './gliner.ts';

// ── Model config ──────────────────────────────────────────
// Pinned 2026-11-02 (T241). The base model's tokenizer (fastino, commit of
// 2026-09-28) is the canonical one for both exports.
const FASTINO_REVISION = '1cb4166094dc58fa8d836429f060d6c95f62b495';
const FASTINO = `https://huggingface.co/fastino/gliner2-privacy-filter-PII-multi/resolve/${FASTINO_REVISION}`;
export const GLINER2_TOKENIZER_FILES: TokenizerFiles = [
  { url: `${FASTINO}/tokenizer.json`, sha256: 'f6df10ec83bea993035b2dd7c39345a3d4fcf23421c2adb6cb4ffc1e6d1bc4b5', size: 16_020_604 },
  { url: `${FASTINO}/tokenizer_config.json`, sha256: '233beed1f1095cccfc7907cde31a8d90a0c6aa4fdfaf6493f8e55fd162e81ae6', size: 711 },
];
const TOKENIZER_HF = 'fastino/gliner2-privacy-filter-PII-multi';

const OKASI = 'https://huggingface.co/okasi/gliner2-privacy-filter-pii-multi-onnx/resolve/9b451660064ee7e4e8367642633e9d390ea31465';
const YETHDEV = 'https://huggingface.co/yethdev/gliner2-pii-onnx/resolve/7d82c70220c2b0891d4bda612402602b63be1c61';

export type Gliner2VariantId = 'okasi-q8' | 'yethdev';

export interface Gliner2Variant {
  id: Gliner2VariantId;
  name: string;
  /** The graph; a path without a scheme is a DocCloak-served asset (CoreEnv.assetBaseUrl). */
  graph: TokenizerFileSpec;
  /** External weights, matched by ONNX Runtime through `dataPath`. */
  data?: TokenizerFileSpec & { dataPath: string };
}

export const GLINER2_VARIANTS: Record<Gliner2VariantId, Gliner2Variant> = {
  'okasi-q8': {
    id: 'okasi-q8',
    name: 'GLiNER2 Privacy Filter',
    // okasi's model_q8.onnx with the baked label positions turned into the
    // `schema_positions` input (scratchpad research, patch_okasi_dynamic_labels.py).
    graph: { url: 'models/gliner2/model_q8_dynlabels.onnx', sha256: '0e01699516d6ea4d616087dba83b004afb5a20d35494e4cc7b13a8ae2a6a222d', size: 1_009_556 },
    data: { url: `${OKASI}/model_q8.onnx.data`, sha256: '55aa98140705a476aea88ad53abf24967066e2460ffe57ef7dc86f4fad87eeff', size: 533_282_304, dataPath: 'model_q8.onnx.data' },
  },
  yethdev: {
    id: 'yethdev',
    name: 'GLiNER2 Privacy Filter (yethdev)',
    graph: { url: `${YETHDEV}/model.quantized.onnx`, sha256: '489edc522a34b8c6a0630c4710998abf0227b11acf45600ba2bce95bcd943930', size: 446_391_629 },
  },
};

const DEFAULT_THRESHOLD = 0.5;
const CUSTOM_LABELS_STORAGE_KEY = 'doccloak-custom-labels';
const MAX_WIDTH = 8;
/** The encoder was trained at 512 positions; prompt and words share them. */
const MAX_TOKENS = 512;
const CHUNK_OVERLAP_WORDS = 50;

/**
 * Built-in labels: trained label names of the model card plus three it
 * reads zero-shot ("company": 0.999 on "ALTAMIR GERANCE"; "date" and
 * "money_amount", which the corpus counts as personal data). Addresses are
 * asked for whole and in parts: the parts win where they score higher and
 * still cover the address. On the 14-language corpus this set gave F1 95.5
 * against 83.1 for the trained names alone (T241, eval/results
 * multilang-gliner2-pii-yethdev-labB.json). "vehicle_registration_number"
 * (zero-shot) found the 5 French, Italian and German plates of the test kit
 * where "license_plate" found 1; corpus F1 unchanged (labE).
 */
export const GLINER2_DEFAULT_LABELS = [
  'person', 'company', 'email', 'phone_number', 'address', 'street_address', 'city', 'postal_code',
  'date', 'date_of_birth', 'money_amount', 'national_id_number', 'tax_id', 'passport_number',
  'iban', 'bank_account', 'card_number', 'ip_address', 'vehicle_registration_number',
];

export function gliner2EntityType(label: string): EntityType {
  switch (label) {
    case 'person': return 'PERSON';
    case 'company': return 'COMPANY';
    case 'email': return 'EMAIL';
    case 'phone_number': return 'PHONE';
    case 'address': case 'street_address': case 'city': case 'postal_code': return 'ADDRESS';
    case 'date': case 'date_of_birth': return 'DATE';
    case 'money_amount': return 'CURRENCY';
    case 'national_id_number': case 'tax_id': case 'passport_number': case 'drivers_license_number': return 'SSN';
    case 'iban': case 'bank_account': return 'IBAN';
    case 'card_number': return 'CREDIT_CARD';
    case 'ip_address': return 'IP_ADDRESS';
    case 'password': return 'SECRET';
    default: return 'OTHER';
  }
}

// ── Words (gliner2 WhitespaceTokenSplitter, lower=True) ───
const WORD_CHAR = '[\\p{L}\\p{N}_\\p{M}\\u200c\\u200d]';
const WORD_RE = new RegExp(
  `(?:https?://[^\\s]+|www\\.[^\\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}|@[a-z0-9_]+|${WORD_CHAR}+(?:[-_]${WORD_CHAR}+)*|\\S`,
  'giu',
);

export interface Gliner2Word { word: string; start: number; end: number }

/**
 * Lowercased words with their offsets in `text`. gliner2 first appends "."
 * to a text that does not end in . ! or ?; that dot is a word of its own.
 */
export function gliner2Words(text: string): Gliner2Word[] {
  const norm = !text ? '.' : /[.!?]$/.test(text) ? text : `${text}.`;
  const words: Gliner2Word[] = [];
  for (const m of norm.matchAll(WORD_RE)) words.push({ word: m[0].toLowerCase(), start: m.index!, end: m.index! + m[0].length });
  return words;
}

/** Schema items before the text: ( [P] entities ( [E] l1 ... [E] lK ) ) [SEP_TEXT]. */
export function gliner2Schema(labels: string[]): { items: string[]; markers: number[] } {
  const items = ['(', '[P]', 'entities', '('];
  const markers = [1];
  for (const label of labels) {
    markers.push(items.length);
    items.push('[E]', label);
  }
  items.push(')', ')', '[SEP_TEXT]');
  return { items, markers };
}

// ── Provider ──────────────────────────────────────────────

export interface Gliner2Options {
  variant?: Gliner2VariantId;
  /** Replace the variant's graph file (eval: the derived graph from a local path). */
  graphOverride?: TokenizerFileSpec;
}

export class Gliner2Provider implements DetectionProvider {
  private readonly env: CoreEnv;
  private readonly variant: Gliner2Variant;
  private readonly graphOverride?: TokenizerFileSpec;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null;
  private session: ort.InferenceSession | null = null;
  private loading = false;
  private loadError: Error | null = null;
  private loadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private progressCallback: ProgressCallback | null = null;
  private threshold = DEFAULT_THRESHOLD;
  private customLabels: string[] = [];
  private verification: ModelVerification | null = null;
  /** Token ids per word or schema item (words repeat a lot in documents). */
  private readonly idCache = new Map<string, number[]>();

  constructor(env: CoreEnv, options: Gliner2Options = {}) {
    this.env = env;
    this.variant = GLINER2_VARIANTS[options.variant ?? 'okasi-q8'];
    this.graphOverride = options.graphOverride;
  }

  get name(): string { return this.variant.name; }
  getVerification(): ModelVerification | null { return this.verification; }
  isLoaded(): boolean { return this.session !== null && this.tokenizer !== null; }
  isLoading(): boolean { return this.loading; }
  onProgress(callback: ProgressCallback): void { this.progressCallback = callback; }
  setThreshold(value: number): void { this.threshold = Math.max(0.05, Math.min(0.95, value)); }
  getThreshold(): number { return this.threshold; }
  getCustomLabels(): string[] { return [...this.customLabels]; }

  async setCustomLabels(labels: string[]): Promise<void> {
    this.customLabels = labels.map((l) => l.trim()).filter((l) => l.length > 0);
    try {
      await this.env.kv.set(CUSTOM_LABELS_STORAGE_KEY, JSON.stringify(this.customLabels));
    } catch { /* KV unavailable in a worker: the engine passes the labels */ }
  }

  private activeLabels(): string[] {
    const labels = [...GLINER2_DEFAULT_LABELS];
    for (const l of this.customLabels) if (!labels.includes(l)) labels.push(l);
    return labels;
  }

  /** Absolute URL of a file; a DocCloak-served asset resolves against CoreEnv.assetBaseUrl or the page. */
  private resolveUrl(url: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    const base = this.env.assetBaseUrl ?? (globalThis as { location?: { href: string } }).location?.href;
    if (!base) throw new Error(`${this.name}: no base URL for the DocCloak-served file ${url} (set CoreEnv.assetBaseUrl)`);
    return new URL(url, base).href;
  }

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
      const graph = this.graphOverride ?? this.variant.graph;
      const data = this.variant.data;
      const loaded = { graph: 0, data: 0 };
      const total = graph.size + (data?.size ?? 0);
      const report = (): void => this.progressCallback?.(loaded.graph + loaded.data, total);
      const onVerified = (verification: ModelVerification): void => {
        this.verification = verification;
        console.info(`[DocCloak] Model verified: ${this.name} SHA-256 ${verification.sha256.slice(0, 12)}... matches the pinned hash`);
      };
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, this.resolveUrl(graph.url), (d) => { loaded.graph = d; report(); }, {
          sha256: graph.sha256, size: graph.size, ...(data ? {} : { onVerified }),
        }),
        data
          ? fetchModelBlob(loaderEnv, data.url, (d) => { loaded.data = d; report(); }, { sha256: data.sha256, size: data.size, onVerified })
          : Promise.resolve(null),
      ];
      if (!this.tokenizer) {
        tasks.push(loadPinnedTokenizer(this.env, GLINER2_TOKENIZER_FILES, TOKENIZER_HF).then((t: unknown) => { this.tokenizer = t; }));
      }
      const [graphBlob, dataBlob] = await Promise.all(tasks) as [Blob, Blob | null];
      const graphBytes = new Uint8Array(await graphBlob.arrayBuffer());
      this.session = await ort.InferenceSession.create(graphBytes, {
        executionProviders: ['wasm'],
        ...(data && dataBlob ? { externalData: [{ path: data.dataPath, data: dataBlob }] } : {}),
      });
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

  private ids(item: string): number[] {
    let ids = this.idCache.get(item);
    if (!ids) {
      ids = Array.from(this.tokenizer.encode(item, { add_special_tokens: false }) as ArrayLike<number>);
      if (this.idCache.size > 100_000) this.idCache.clear();
      this.idCache.set(item, ids);
    }
    return ids;
  }

  async detect(text: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]> {
    throwIfAborted(signal);
    if (!this.isLoaded()) await this.load();
    if (!this.session || !this.tokenizer) return [];
    if (!text.trim()) return [];
    onProgress?.(0);

    const labels = this.activeLabels();
    const schema = gliner2Schema(labels);
    const promptIds: number[] = [];
    const schemaPos: number[] = [];
    schema.items.forEach((item, i) => {
      if (i === schema.markers[schemaPos.length]) schemaPos.push(promptIds.length);
      promptIds.push(...this.ids(item));
    });
    const words = gliner2Words(text);
    const wordIds = words.map((w) => this.ids(w.word));
    const budget = MAX_TOKENS - promptIds.length;
    if (budget < 16) throw new Error(`${this.name}: too many labels (${labels.length}) for the 512-token input`);

    // Word chunks that fit the token budget, overlapping by CHUNK_OVERLAP_WORDS.
    const chunks: Array<[number, number]> = [];
    for (let from = 0; from < words.length;) {
      let to = from;
      let used = 0;
      while (to < words.length && used + Math.max(1, wordIds[to].length) <= budget) { used += Math.max(1, wordIds[to].length); to++; }
      if (to === from) to = from + 1;
      chunks.push([from, to]);
      if (to >= words.length) break;
      from = Math.max(from + 1, to - CHUNK_OVERLAP_WORDS);
    }

    const all: RawSpan[] = [];
    for (let c = 0; c < chunks.length; c++) {
      throwIfAborted(signal);
      const [from, to] = chunks[c];
      all.push(...await this.inferChunk(text, words.slice(from, to), wordIds.slice(from, to), promptIds, schemaPos, labels));
      onProgress?.((c + 1) / chunks.length);
      await new Promise((r) => setTimeout(r, 0));
    }

    return greedySelect(all).map(([value, start, end, label, score]) => ({
      type: gliner2EntityType(label),
      value,
      start,
      end,
      confidence: score,
      detector: `gliner2:${label}`,
    }));
  }

  private async inferChunk(
    text: string,
    words: Gliner2Word[],
    wordIds: number[][],
    promptIds: number[],
    schemaPos: number[],
    labels: string[],
  ): Promise<RawSpan[]> {
    const ids = [...promptIds];
    const wordPos: number[] = [];
    for (const w of wordIds) {
      wordPos.push(ids.length);
      ids.push(...w);
    }
    const S = ids.length;
    const L = words.length;
    const K = labels.length;
    const i64 = (values: number[]): BigInt64Array => BigInt64Array.from(values, (v) => BigInt(v));
    const common = {
      input_ids: new ort.Tensor('int64', i64(ids), [1, S]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(S).fill(1n), [1, S]),
    };
    // prob(k, i, w): label k, span from word i, width w + 1.
    let prob: (k: number, i: number, w: number) => number;
    if (this.variant.id === 'okasi-q8') {
      const out = await this.session!.run({
        ...common,
        text_word_indices: new ort.Tensor('int64', i64(wordPos), [1, L]),
        text_word_counts: new ort.Tensor('int64', i64([L]), [1]),
        schema_positions: new ort.Tensor('int64', i64(schemaPos), [1, K + 1]),
      });
      // The count head predicting 0 entities silences the chunk (gliner2 does the same).
      if (argmax(out.count_logits.data as Float32Array) === 0) return [];
      const scores = out.span_scores.data as Float32Array;
      prob = (k, i, w) => scores[(k * L + i) * MAX_WIDTH + w];
    } else {
      const out = await this.session!.run({
        ...common,
        text_word_indices: new ort.Tensor('int64', i64(wordPos), [L]),
        schema_special_indices: new ort.Tensor('int64', i64(schemaPos), [K + 1]),
      });
      const probs = out.span_probs.data as Float32Array; // count gate applied in the graph
      prob = (k, i, w) => probs[(i * MAX_WIDTH + w) * K + k];
    }

    const spans: RawSpan[] = [];
    for (let k = 0; k < K; k++) {
      const candidates: RawSpan[] = [];
      for (let i = 0; i < L; i++) {
        for (let w = 0; w < MAX_WIDTH && i + w < L; w++) {
          const p = prob(k, i, w);
          if (p < this.threshold) continue;
          // The dot gliner2 appends to the text is past its end: clamp.
          const start = Math.min(words[i].start, text.length);
          const end = Math.min(words[i + w].end, text.length);
          let a = start;
          let b = end;
          while (a < b && /\s/u.test(text[a])) a++;
          while (b > a && /\s/u.test(text[b - 1])) b--;
          if (b <= a) continue;
          candidates.push([text.slice(a, b), a, b, labels[k], p]);
        }
      }
      // Per label: best first, no overlap with a span already kept for that label.
      spans.push(...greedySelect(candidates));
    }
    return spans;
  }
}

function argmax(values: Float32Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}
