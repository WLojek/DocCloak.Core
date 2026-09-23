/**
 * GLiNER PII Base provider (T122).
 *
 * knowledgator/gliner-pii-base-v1.0: deberta-v3-small backbone, zero-shot
 * custom labels, span_mode "markerV0". Unlike the token_level small/edge
 * models (gliner.ts), the ONNX graph takes span enumeration inputs
 * (span_idx + span_mask) and emits span-level logits shaped
 * [batch, num_words, max_width, num_classes] - one score per candidate
 * (start word, width) pair per label. Verified against the pinned model in
 * Node WASM: inputs [input_ids, attention_mask, words_mask, text_lengths,
 * span_idx (int64), span_mask (bool)], output [logits].
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
import type { DetectedEntity, DetectionProvider, ProgressCallback } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification } from '../model-loader.ts';
import { fetchModelBlob, retryAsync } from '../model-loader.ts';
import {
  DEFAULT_PII_LABELS,
  greedySelect,
  mapLabelToEntityType,
  sigmoid,
  splitWords,
  type RawSpan,
} from './gliner.ts';

// ── Model config ──────────────────────────────────────────
// Supply-chain pinning (T116): the model is fetched from an immutable
// commit revision, never from mutable resolve/main, and the downloaded
// blob is verified against a pinned SHA-256. A model update is a
// deliberate act: bump GLINER_BASE_MODEL_REVISION and
// GLINER_BASE_MODEL_SHA256 together in a reviewed commit and update
// documentation/model-provenance.md.
// Revision: main of knowledgator/gliner-pii-base-v1.0; pinned and hashed
// 2026-08-26 (T122).
export const GLINER_BASE_MODEL_REVISION = '61726e0ad791dcab3e29339bbec3ad42ded65641';
/** SHA-256 of onnx/model_quint8.onnx (196,757,174 bytes) at GLINER_BASE_MODEL_REVISION. */
export const GLINER_BASE_MODEL_SHA256 = '0514c8fd86d0513ce5351a3267f132b57d5bcd8f99a90d43cde1228092881d19';
export const GLINER_BASE_MODEL_URL = `https://huggingface.co/knowledgator/gliner-pii-base-v1.0/resolve/${GLINER_BASE_MODEL_REVISION}/onnx/model_quint8.onnx`;
const DEFAULT_MODEL_URL = GLINER_BASE_MODEL_URL;
const DEFAULT_TOKENIZER_HF = 'knowledgator/gliner-pii-base-v1.0';
const DEFAULT_MODEL_NAME = 'GLiNER PII Base';
const CUSTOM_LABELS_STORAGE_KEY = 'doccloak-custom-labels';

// Special token ids of the deberta-v3-small vocab (vocab_size 128003).
// Verified against the repo's tokenizer_config.json at the pinned
// revision - these differ from the ettin ids used by gliner.ts.
const CLS_TOKEN_ID = 1;       // [CLS]
const SEP_TOKEN_ID = 2;       // [SEP]
const ENT_TOKEN_ID = 128001;  // <<ENT>> (class_token_index in gliner_config.json)
const SEP_PROMPT_TOKEN_ID = 128002; // <<SEP>> (prompt separator, not [SEP])

/** max_width from the repo's gliner_config.json: spans cover 1..12 words. */
export const GLINER_BASE_MAX_WIDTH = 12;
const DEFAULT_THRESHOLD = 0.35;
const MAX_WORDS_PER_CHUNK = 150;
const CHUNK_OVERLAP = 40;

// ── Span enumeration (markerV0) ───────────────────────────

export interface SpanIndices {
  /** Flattened (start, end) word pairs, shape [1, numSpans, 2]. */
  spanIdx: BigInt64Array;
  /** 1 for valid spans (end < textLength), 0 for padding, shape [1, numSpans]. */
  spanMask: Uint8Array;
  numSpans: number;
}

/**
 * Enumerate all candidate word spans exactly like the python GLiNER
 * SpanProcessor: start-major, width-minor - for every start word i, the
 * pairs (i, i+0) .. (i, i+maxWidth-1). Spans that would run past the end
 * of the text are masked out and their indices zeroed (mirroring
 * span_idx * span_mask in the python collate).
 */
export function buildSpanIndices(textLength: number, maxWidth: number = GLINER_BASE_MAX_WIDTH): SpanIndices {
  const numSpans = textLength * maxWidth;
  const spanIdx = new BigInt64Array(numSpans * 2);
  const spanMask = new Uint8Array(numSpans);
  for (let start = 0; start < textLength; start++) {
    for (let width = 0; width < maxWidth; width++) {
      const flat = start * maxWidth + width;
      const end = start + width;
      if (end < textLength) {
        spanIdx[flat * 2] = BigInt(start);
        spanIdx[flat * 2 + 1] = BigInt(end);
        spanMask[flat] = 1;
      }
      // invalid spans stay (0, 0) with mask 0
    }
  }
  return { spanIdx, spanMask, numSpans };
}

/**
 * Decode markerV0 span logits (shape [1, numWords, maxWidth, numClasses])
 * into raw character spans: sigmoid per (start, width, class) cell,
 * threshold, then map word indices to character offsets. Non-overlap
 * selection (greedySelect) happens at the caller across chunks.
 */
export function decodeSpanLogits(
  logits: Float32Array,
  dims: readonly number[],
  textLength: number,
  labels: string[],
  threshold: number,
  charStarts: number[],
  charEnds: number[],
  fullText: string,
): RawSpan[] {
  const maxWidth = dims[2];
  const numClasses = dims[3];
  const spans: RawSpan[] = [];
  for (let start = 0; start < textLength; start++) {
    for (let width = 0; width < maxWidth; width++) {
      const end = start + width;
      if (end >= textLength) break;
      const base = (start * maxWidth + width) * numClasses;
      for (let cls = 0; cls < numClasses && cls < labels.length; cls++) {
        const prob = sigmoid(logits[base + cls]);
        if (prob < threshold) continue;
        const charStart = charStarts[start];
        const charEnd = charEnds[end];
        spans.push([fullText.slice(charStart, charEnd), charStart, charEnd, labels[cls], prob]);
      }
    }
  }
  return spans;
}

// ── Provider ──────────────────────────────────────────────
export class GlinerBaseProvider implements DetectionProvider {
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

  /** Get the combined list of all active labels (built-in + custom). */
  private getActiveLabels(): string[] {
    return [...DEFAULT_PII_LABELS, ...this.customLabels];
  }

  /** Get user-defined custom labels. */
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

  /** Restore custom labels from the injected KV store on startup. */
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

      // Cache note (T122): the BardS.ai blob is deliberately NOT evicted -
      // bardsai stays selectable as a legacy provider.

      // Load tokenizer and model in parallel (skip tokenizer if already loaded from a prior session)
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, DEFAULT_MODEL_URL, (downloaded, total) => this.progressCallback?.(downloaded, total), {
          sha256: GLINER_BASE_MODEL_SHA256,
          onVerified: (verification) => {
            this.verification = verification;
            console.info(`[DocCloak] Model verified: ${this._name} SHA-256 ${verification.sha256.slice(0, 12)}... matches the published hash (see documentation/model-provenance.md)`);
          },
        }),
      ];
      if (!this.tokenizer) {
        tasks.push(
          retryAsync(() => this.env.loadTokenizer(DEFAULT_TOKENIZER_HF), 'Tokenizer download').then((t: unknown) => {
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

  async detect(text: string, onProgress?: (progress: number) => void): Promise<DetectedEntity[]> {
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
        detector: `gliner-base:${label}`,
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

    const { spanIdx, spanMask, numSpans } = buildSpanIndices(textLength);

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds.map(BigInt)), [1, seqLen]),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(BigInt)), [1, seqLen]),
      words_mask: new ort.Tensor('int64', BigInt64Array.from(wordsMask.map(BigInt)), [1, seqLen]),
      text_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(textLength)]), [1, 1]),
      span_idx: new ort.Tensor('int64', spanIdx, [1, numSpans, 2]),
      span_mask: new ort.Tensor('bool', spanMask, [1, numSpans]),
    };

    const results = await this.session.run(feeds);

    const outputName = this.session.outputNames[0] || 'logits';
    const output = results[outputName];
    const logits = output.data as Float32Array;

    // markerV0: logits shape [1, num_words, max_width, num_classes]
    return decodeSpanLogits(
      logits,
      output.dims,
      textLength,
      labels,
      this.threshold,
      charStarts,
      charEnds,
      fullText,
    );
  }

}
