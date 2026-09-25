/**
 * GLiNER PII Small provider.
 *
 * Environment-agnostic: wasm paths, custom-label persistence (KV), model
 * bytes (blob cache + fetch) and the tokenizer all arrive through the
 * injected CoreEnv. This module never touches import.meta, localStorage,
 * caches, navigator or @huggingface/transformers directly.
 */

// ort 1.29: the /webgpu entry is the non-deprecated build (native WebGPU EP +
// wasm fallback, asyncify binary). The bare entry resolves the deprecated JSEP
// bundle whose wasm exceeds Cloudflare Pages' 25 MiB per-file limit.
import * as ort from 'onnxruntime-web/webgpu';
import type { DetectedEntity, EntityType, DetectionProvider, ProgressCallback } from '../types.ts';
import { throwIfAborted } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification, TokenizerFiles } from '../model-loader.ts';
import { evictModelFromCache, fetchModelBlob, loadPinnedTokenizer } from '../model-loader.ts';

// ── Model config ──────────────────────────────────────────
// Supply-chain pinning (T116): the model is fetched from an immutable
// commit revision, never from mutable resolve/main, and the downloaded
// blob is verified against a pinned SHA-256. A model update is a
// deliberate act: bump GLINER_MODEL_REVISION and GLINER_MODEL_SHA256
// together in a reviewed commit and update
// documentation/model-provenance.md.
// Revision: main of knowledgator/gliner-pii-small-v1.0; pinned and
// hashed 2026-08-26 (T121 swap from gliner-pii-edge-v1.0, +1.3 F1
// drop-in per documentation/model-research-2026-08.md).
export const GLINER_MODEL_REVISION = 'd21aad5b4a7ec82b3d0970fd1ac74a12c087d85e';
/** SHA-256 of onnx/model_quint8.onnx (82,680,500 bytes) at GLINER_MODEL_REVISION. */
export const GLINER_MODEL_SHA256 = '891589426ee96f2748b16439f44fad8c3f97e198e002a6637e58dee989500216';
export const GLINER_MODEL_URL = `https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/${GLINER_MODEL_REVISION}/onnx/model_quint8.onnx`;
const DEFAULT_MODEL_URL = GLINER_MODEL_URL;
/**
 * Tokenizer files at the same pinned commit (T185): fetched through
 * fetchModelBlob with SHA-256 + size, cached next to the model and handed to
 * CoreEnv.buildTokenizer. Hashes re-measured against the resolve/<commit>
 * URLs on 2026-09-24 (documentation/model-provenance.md).
 */
export const GLINER_TOKENIZER_FILES: TokenizerFiles = [
  {
    url: `https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/${GLINER_MODEL_REVISION}/tokenizer.json`,
    sha256: '84b3a9b18f04a0ccd03b72d9f871b7e0bec40fd7021ef50bc30a7c3693c11205',
    size: 3_583_593,
  },
  {
    url: `https://huggingface.co/knowledgator/gliner-pii-small-v1.0/resolve/${GLINER_MODEL_REVISION}/tokenizer_config.json`,
    sha256: '3398f6d1ad4b4c4f9874d390d060a75c58cad5e5ce9b22841b3e40643b4ada27',
    size: 21_214,
  },
];
const TOKENIZER_FILES = GLINER_TOKENIZER_FILES;
/**
 * Superseded download URLs; their cache entries are evicted best-effort on
 * load so stale ~46 MB copies do not linger against the origin quota:
 * the pre-pinning edge resolve/main URL and the pinned edge URL replaced
 * by gliner-pii-small-v1.0 (T121).
 */
const LEGACY_MODEL_URLS = [
  'https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/main/onnx/model_quint8.onnx',
  'https://huggingface.co/knowledgator/gliner-pii-edge-v1.0/resolve/9b7f39b0a2da971a5beea78d35f1539d4009c891/onnx/model_quint8.onnx',
];
/** Hugging Face id for the deprecated CoreEnv.loadTokenizer fallback only. */
const DEFAULT_TOKENIZER_HF = 'knowledgator/gliner-pii-small-v1.0';
const DEFAULT_MODEL_NAME = 'GLiNER PII Small';
const CUSTOM_LABELS_STORAGE_KEY = 'doccloak-custom-labels';

const CLS_TOKEN_ID = 50281;
const SEP_TOKEN_ID = 50282;
const ENT_TOKEN_ID = 50368;
const SEP_PROMPT_TOKEN_ID = 50369; // <<SEP>> (prompt separator, not [SEP])
const DEFAULT_THRESHOLD = 0.35;
const MAX_WORDS_PER_CHUNK = 150;
const CHUNK_OVERLAP = 40;

/**
 * Built-in zero-shot label set, shared with the GLiNER PII Base provider
 * (gliner-base.ts) - the models are from the same zero-shot family, so the
 * same prompt labels work for both.
 */
export const DEFAULT_PII_LABELS = [
  'person name',
  'calendar date',
  'email address', 'phone number', 'ip address',
  'street address', 'city', 'zip code',
  'bank account number', 'credit card number', 'iban',
  'social security number', 'tax id', 'national id number',
  'passport number', 'driver license number',
  'money amount',
  'company name',
];

// ── Label → EntityType mapping ────────────────────────────
/** Shared with gliner-base.ts (same label set, same mapping). */
export function mapLabelToEntityType(label: string): EntityType {
  const l = label.toLowerCase();
  if (l === 'person name') return 'PERSON';
  if (l === 'email address') return 'EMAIL';
  if (l === 'phone number') return 'PHONE';
  if (['social security number', 'national id number', 'tax id', 'passport number', 'driver license number'].includes(l)) return 'SSN';
  if (l === 'credit card number') return 'CREDIT_CARD';
  if (l === 'calendar date') return 'DATE';
  if (l === 'money amount') return 'CURRENCY';
  if (l === 'ip address') return 'IP_ADDRESS';
  if (['iban', 'bank account number'].includes(l)) return 'IBAN';
  if (['street address', 'city', 'zip code'].includes(l)) return 'ADDRESS';
  if (l === 'company name') return 'COMPANY';
  return 'OTHER';
}

// ── Word splitter ─────────────────────────────────────────
// Mirrors GLiNER's WhitespaceTokenSplitter (words, plus standalone
// punctuation); shared with gliner-base.ts (same words_splitter_type).
const WORD_PATTERN = /[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*|\S/gu;

export function splitWords(text: string): { words: string[]; starts: number[]; ends: number[] } {
  const words: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let match: RegExpExecArray | null;
  WORD_PATTERN.lastIndex = 0;
  while ((match = WORD_PATTERN.exec(text)) !== null) {
    words.push(match[0]);
    starts.push(match.index);
    ends.push(WORD_PATTERN.lastIndex);
  }
  return { words, starts, ends };
}

// ── Sigmoid ───────────────────────────────────────────────
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── Greedy non-overlapping span selection ─────────────────
export type RawSpan = [string, number, number, string, number]; // [text, start, end, label, score]

export function greedySelect(spans: RawSpan[]): RawSpan[] {
  const sorted = spans.slice().sort((a, b) => b[4] - a[4]);
  const selected: RawSpan[] = [];
  for (const span of sorted) {
    const overlaps = selected.some(s => span[1] < s[2] && span[2] > s[1]);
    if (!overlaps) selected.push(span);
  }
  return selected.sort((a, b) => a[1] - b[1]);
}

// ── Provider ──────────────────────────────────────────────
export class GlinerProvider implements DetectionProvider {
  private _name = DEFAULT_MODEL_NAME;
  get name(): string { return this._name; }

  private env: CoreEnv;

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

  constructor(env: CoreEnv) {
    this.env = env;
  }

  /**
   * SHA-256 verification result of the served model blob (null until the
   * model has been verified against the pinned hash). Surfaced so the
   * model-status UI can show the positive "Model verified" state.
   */
  getVerification(): ModelVerification | null {
    return this.verification;
  }

  isLoaded(): boolean {
    return this.session !== null && this.tokenizer !== null;
  }

  isLoading(): boolean {
    return this.loading;
  }

  onProgress(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  setThreshold(value: number): void {
    this.threshold = Math.max(0.05, Math.min(0.95, value));
  }

  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Get the combined list of all active labels (built-in + custom).
   */
  private getActiveLabels(): string[] {
    return [...DEFAULT_PII_LABELS, ...this.customLabels];
  }

  /**
   * Get user-defined custom labels.
   */
  getCustomLabels(): string[] {
    return [...this.customLabels];
  }

  /**
   * Set custom labels and persist through the injected KV store. The
   * in-memory list updates synchronously (before the first await), so
   * fire-and-forget callers keep the previous behavior.
   */
  async setCustomLabels(labels: string[]): Promise<void> {
    this.customLabels = labels.filter((l) => l.trim().length > 0);
    try {
      await this.env.kv.set(CUSTOM_LABELS_STORAGE_KEY, JSON.stringify(this.customLabels));
    } catch { /* KV backend unavailable (e.g. storage-less Web Worker) */ }
  }

  /**
   * Restore custom labels from the injected KV store on startup.
   */
  async restoreCustomLabels(): Promise<void> {
    try {
      const saved = await this.env.kv.get(CUSTOM_LABELS_STORAGE_KEY);
      if (saved) {
        this.customLabels = JSON.parse(saved);
      }
    } catch { /* KV backend unavailable in Web Worker - labels are passed via message */ }
  }

  async load(): Promise<void> {
    if (this.isLoaded()) return;
    if (this.loadError) throw this.loadError;
    if (this.loading) {
      return new Promise<void>((resolve, reject) => {
        this.loadWaiters.push({ resolve, reject });
      });
    }

    this.loading = true;
    try {
      ort.env.wasm.wasmPaths = this.env.wasm.paths;
      // Default to single-threaded WASM. ORT's multi-threaded path hangs
      // silently in some cross-origin-isolated browser contexts when spawning
      // pthread workers (model downloads but session.create never resolves).
      ort.env.wasm.numThreads = this.env.wasm.numThreads ?? 1;

      const loaderEnv: ModelLoaderEnv = {
        cache: this.env.modelCache,
        fetch: this.env.fetch,
        persistStorage: this.env.persistStorage,
      };

      // Old cache entries from superseded URLs (pre-pinning resolve/main
      // and the retired edge pin) - drop them so stale copies do not
      // linger against the origin quota.
      for (const legacyUrl of LEGACY_MODEL_URLS) {
        void evictModelFromCache(loaderEnv, legacyUrl);
      }

      // Load tokenizer and model in parallel (skip tokenizer if already loaded from a prior session)
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, DEFAULT_MODEL_URL, (downloaded, total) => this.progressCallback?.(downloaded, total), {
          sha256: GLINER_MODEL_SHA256,
          onVerified: (verification) => {
            this.verification = verification;
            console.info(`[DocCloak] Model verified: ${this._name} SHA-256 ${verification.sha256.slice(0, 12)}... matches the published hash (see documentation/model-provenance.md)`);
          },
        }),
      ];
      if (!this.tokenizer) {
        tasks.push(
          loadPinnedTokenizer(this.env, TOKENIZER_FILES, DEFAULT_TOKENIZER_HF).then((t: unknown) => {
            this.tokenizer = t;
          }),
        );
      }
      const [modelBlob] = await Promise.all(tasks) as [Blob];

      const blobUrl = URL.createObjectURL(modelBlob);
      try {
        this.session = await ort.InferenceSession.create(blobUrl, {
          executionProviders: ['wasm'],
        });
      } finally {
        // ONNX Runtime has already read the data into the WASM heap
        URL.revokeObjectURL(blobUrl);
      }

      console.info(`[DocCloak] Model loaded: ${this._name} | inputs: [${this.session.inputNames.join(', ')}] | outputs: [${this.session.outputNames.join(', ')}]`);

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
      this.session.release();
      this.session = null;
    }
    this.loading = false;
    this.loadError = null;
  }

  async detect(text: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<DetectedEntity[]> {
    throwIfAborted(signal);
    if (!this.isLoaded()) await this.load();
    if (!this.session || !this.tokenizer) return [];

    const { words, starts, ends } = splitWords(text);
    if (words.length === 0) return [];

    // Build prompt tokens once (shared across all chunks)
    const activeLabels = this.getActiveLabels();
    const promptTokens = this.buildPromptTokens(activeLabels);

    const chunkSize = MAX_WORDS_PER_CHUNK;
    const overlap = CHUNK_OVERLAP;

    // Split into chunks if text is too long
    const allSpans: RawSpan[] = [];
    onProgress?.(0);

    if (words.length <= chunkSize) {
      // Single chunk - no splitting needed
      const spans = await this.inferChunk(words, starts, ends, text, promptTokens, activeLabels);
      allSpans.push(...spans);
      onProgress?.(1);
    } else {
      // Count total chunks
      let totalChunks = 0;
      for (let cs = 0; cs < words.length; cs += chunkSize - overlap) {
        totalChunks++;
        if (Math.min(cs + chunkSize, words.length) >= words.length) break;
      }

      // Multiple overlapping chunks
      let chunksDone = 0;
      for (let chunkStart = 0; chunkStart < words.length; chunkStart += chunkSize - overlap) {
        // T222: a cancelled run stops here, before the next inference.
        throwIfAborted(signal);
        const chunkEnd = Math.min(chunkStart + chunkSize, words.length);
        const chunkWords = words.slice(chunkStart, chunkEnd);
        const chunkStarts = starts.slice(chunkStart, chunkEnd);
        const chunkEnds = ends.slice(chunkStart, chunkEnd);

        const spans = await this.inferChunk(chunkWords, chunkStarts, chunkEnds, text, promptTokens, activeLabels);
        allSpans.push(...spans);

        chunksDone++;
        onProgress?.(chunksDone / totalChunks);
        await new Promise((r) => setTimeout(r, 0));

        if (chunkEnd >= words.length) break;
      }
    }

    // Greedy non-overlapping selection across all chunks
    const selected = greedySelect(allSpans);

    return selected
      .filter(([spanText]) => spanText.trim().length >= 2)
      .map(([spanText, start, end, label, score]) => ({
        type: mapLabelToEntityType(label),
        value: spanText,
        start,
        end,
        confidence: score,
        detector: `gliner:${label}`,
      }));
  }

  private buildPromptTokens(labels: string[]): number[] {
    const tokens: number[] = [];
    for (const label of labels) {
      tokens.push(ENT_TOKEN_ID);
      for (const part of label.split(' ')) {
        const subTokens: number[] = this.tokenizer.encode(part).slice(1, -1);
        tokens.push(...subTokens);
      }
    }
    tokens.push(SEP_PROMPT_TOKEN_ID);
    return tokens;
  }

  private async inferChunk(
    words: string[],
    charStarts: number[],
    charEnds: number[],
    fullText: string,
    promptTokens: number[],
    labels: string[],
  ): Promise<RawSpan[]> {
    if (!this.session) return [];

    // Build token sequence: [CLS] + prompt + text words + [SEP]
    const inputIds: number[] = [CLS_TOKEN_ID, ...promptTokens];
    const attentionMask: number[] = new Array(inputIds.length).fill(1);
    const wordsMask: number[] = new Array(inputIds.length).fill(0);

    let wordCounter = 1;
    for (const word of words) {
      const subTokens: number[] = this.tokenizer.encode(word).slice(1, -1);
      for (let j = 0; j < subTokens.length; j++) {
        inputIds.push(subTokens[j]);
        attentionMask.push(1);
        wordsMask.push(j === 0 ? wordCounter : 0);
      }
      wordCounter++;
    }

    inputIds.push(SEP_TOKEN_ID);
    attentionMask.push(1);
    wordsMask.push(0);

    const seqLen = inputIds.length;
    const textLength = words.length;
    const numEntities = labels.length;

    const idToClass: Record<number, string> = {};
    labels.forEach((label, i) => { idToClass[i + 1] = label; });

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [1, seqLen]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, seqLen]),
      words_mask: new ort.Tensor('int64', BigInt64Array.from(wordsMask.map(BigInt)), [1, seqLen]),
      text_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(textLength)]), [1, 1]),
    };

    const results = await this.session.run(feeds);

    const outputName = this.session.outputNames[0] || 'logits';
    const logits = results[outputName].data as Float32Array;

    // Token-based: logits shape [1, num_words, num_entities, 3] (start/end/inside)
    const rawSpans: RawSpan[] = [];
    const selectedStarts: Array<[number, number]> = [];
    const selectedEnds: Array<[number, number]> = [];
    const insideScores: number[][] = Array.from({ length: textLength }, () => Array(numEntities).fill(0));

    for (let token = 0; token < textLength; token++) {
      for (let entity = 0; entity < numEntities; entity++) {
        const base = (token * numEntities + entity) * 3;
        const startProb = sigmoid(logits[base]);
        const endProb = sigmoid(logits[base + 1]);
        const insideProb = sigmoid(logits[base + 2]);

        if (startProb >= this.threshold) selectedStarts.push([token, entity]);
        if (endProb >= this.threshold) selectedEnds.push([token, entity]);
        insideScores[token][entity] = insideProb;
      }
    }

    for (const [startTok, startCls] of selectedStarts) {
      for (const [endTok, endCls] of selectedEnds) {
        if (endTok < startTok || startCls !== endCls) continue;

        const inside = insideScores.slice(startTok, endTok + 1).map(s => s[startCls]);
        if (inside.some(s => s < this.threshold)) continue;

        const score = inside.reduce((a, b) => a + b, 0) / inside.length;
        const charStart = charStarts[startTok];
        const charEnd = charEnds[endTok];
        const spanText = fullText.slice(charStart, charEnd);
        rawSpans.push([spanText, charStart, charEnd, idToClass[startCls + 1], score]);
      }
    }

    return rawSpans;
  }

}
