/**
 * BardS.ai EU PII Anonymization Provider
 *
 * XLM-RoBERTa-base fine-tuned for EU PII detection (24 EU languages, natively multilingual).
 * 35 entity types, ~0.3B parameters, quantized ONNX (~279 MB).
 * Model: bardsai/eu-pii-anonimization-multilang
 * Runs in-browser via ONNX Runtime WebAssembly.
 *
 * Environment-agnostic: wasm paths, model bytes (blob cache + fetch) and the
 * tokenizer all arrive through the injected CoreEnv. This module never touches
 * import.meta, caches, navigator or @huggingface/transformers directly.
 */

// ort 1.29: the /webgpu entry is the non-deprecated build (native WebGPU EP +
// wasm fallback, asyncify binary). The bare entry resolves the deprecated JSEP
// bundle whose wasm exceeds Cloudflare Pages' 25 MiB per-file limit.
import * as ort from 'onnxruntime-web/webgpu';
import type { DetectedEntity, DetectionProvider, EntityType, ProgressCallback } from '../types.ts';
import type { CoreEnv } from '../env.ts';
import type { ModelLoaderEnv, ModelVerification, TokenizerFiles } from '../model-loader.ts';
import { evictModelFromCache, fetchModelBlob, loadPinnedTokenizer } from '../model-loader.ts';

// ── Model config ──────────────────────────────────────────
// Supply-chain pinning (T116): the model is fetched from an immutable
// commit revision, never from mutable resolve/main, and the downloaded
// blob is verified against a pinned SHA-256. A model update is a
// deliberate act: bump BARDSAI_MODEL_REVISION and BARDSAI_MODEL_SHA256
// together in a reviewed commit and update
// documentation/model-provenance.md.
// Revision: main of bardsai/eu-pii-anonimization-multilang as of its last
// modification 2026-05-13; pinned and hashed 2026-08-10.
export const BARDSAI_MODEL_REVISION = '0e72e19f030ed4e661b1673e549af8e0dd176386';
/** SHA-256 of onnx/model_quantized.onnx (278,736,360 bytes) at BARDSAI_MODEL_REVISION. */
export const BARDSAI_MODEL_SHA256 = '8c9f555c743ed14eb7e505ff9d9c7785775a1671fd14031af33f424de8bd0e7b';
export const BARDSAI_MODEL_URL = `https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${BARDSAI_MODEL_REVISION}/onnx/model_quantized.onnx`;
const MODEL_URL = BARDSAI_MODEL_URL;
/** Pre-pinning download URL; its cache entry is evicted best-effort on load. */
const LEGACY_MODEL_URL = 'https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/main/onnx/model_quantized.onnx';
/**
 * Tokenizer files at the same pinned commit (T185): fetched through
 * fetchModelBlob with SHA-256 + size, cached next to the model and handed to
 * CoreEnv.buildTokenizer. Hashes re-measured against the resolve/<commit>
 * URLs on 2026-09-24 (documentation/model-provenance.md).
 */
export const BARDSAI_TOKENIZER_FILES: TokenizerFiles = [
  {
    url: `https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${BARDSAI_MODEL_REVISION}/tokenizer.json`,
    sha256: '2464f9721707cb3d5edcf9a3d73454b13e8a7b3bb8fdba94b3de3d843f30e946',
    size: 16_781_584,
  },
  {
    url: `https://huggingface.co/bardsai/eu-pii-anonimization-multilang/resolve/${BARDSAI_MODEL_REVISION}/tokenizer_config.json`,
    sha256: 'c019e3e4f7f901adf680dde303c7d964de86675a13e089bcc0f614d3fce75333',
    size: 314,
  },
];
const TOKENIZER_FILES = BARDSAI_TOKENIZER_FILES;
/** Hugging Face id for the deprecated CoreEnv.loadTokenizer fallback only. */
const TOKENIZER_HF = 'bardsai/eu-pii-anonimization-multilang';
const MODEL_NAME = 'BardS.ai EU PII';
const DEFAULT_THRESHOLD = 0.5;
const MAX_SEQ_LENGTH = 512;
const CHUNK_OVERLAP = 30;

/** id2label - 35 entity types from bardsai eu-pii-anonimization-multilang config.json (69 labels) */
const ID2LABEL: Record<number, string> = {
  0: 'O',
  1: 'B-ACCOUNT_IDENTIFIER', 2: 'B-AUTH_SECRET', 3: 'B-BANK_ACCOUNT_IDENTIFIER',
  4: 'B-BIOMETRIC_DATA', 5: 'B-CONTACT_HANDLE', 6: 'B-CRIMINAL_OFFENCE_DATA',
  7: 'B-DATE_OF_BIRTH', 8: 'B-DEVICE_IDENTIFIER', 9: 'B-DOCUMENT_IDENTIFIER',
  10: 'B-DOCUMENT_REFERENCE', 11: 'B-EMAIL_ADDRESS', 12: 'B-ETHNIC_ORIGIN',
  13: 'B-FINANCIAL_AMOUNT', 14: 'B-GEO_LOCATION', 15: 'B-HEALTH_DATA',
  16: 'B-IDENTIFYING_LINK', 17: 'B-IP_ADDRESS', 18: 'B-LOCATION',
  19: 'B-ORGANIZATION_IDENTIFIER', 20: 'B-ORGANIZATION_NAME', 21: 'B-PAYMENT_CARD',
  22: 'B-PAYMENT_CARD_SECURITY', 23: 'B-PERSON_ALIAS', 24: 'B-PERSON_ATTRIBUTE',
  25: 'B-PERSON_IDENTIFIER', 26: 'B-PERSON_NAME', 27: 'B-PERSON_ROLE_OR_TITLE',
  28: 'B-PHONE_NUMBER', 29: 'B-POLITICAL_OPINION', 30: 'B-POSTAL_ADDRESS',
  31: 'B-PROPER_NAME', 32: 'B-RELIGION_OR_BELIEF', 33: 'B-SEXUAL_ORIENTATION',
  34: 'B-TRADE_UNION_MEMBERSHIP', 35: 'B-VEHICLE_IDENTIFIER',
  36: 'I-ACCOUNT_IDENTIFIER', 37: 'I-AUTH_SECRET', 38: 'I-BANK_ACCOUNT_IDENTIFIER',
  39: 'I-BIOMETRIC_DATA', 40: 'I-CRIMINAL_OFFENCE_DATA', 41: 'I-DATE_OF_BIRTH',
  42: 'I-DEVICE_IDENTIFIER', 43: 'I-DOCUMENT_IDENTIFIER', 44: 'I-DOCUMENT_REFERENCE',
  45: 'I-EMAIL_ADDRESS', 46: 'I-ETHNIC_ORIGIN', 47: 'I-FINANCIAL_AMOUNT',
  48: 'I-GEO_LOCATION', 49: 'I-HEALTH_DATA', 50: 'I-IDENTIFYING_LINK',
  51: 'I-IP_ADDRESS', 52: 'I-LOCATION', 53: 'I-ORGANIZATION_IDENTIFIER',
  54: 'I-ORGANIZATION_NAME', 55: 'I-PAYMENT_CARD', 56: 'I-PAYMENT_CARD_SECURITY',
  57: 'I-PERSON_ATTRIBUTE', 58: 'I-PERSON_IDENTIFIER', 59: 'I-PERSON_NAME',
  60: 'I-PERSON_ROLE_OR_TITLE', 61: 'I-PHONE_NUMBER', 62: 'I-POLITICAL_OPINION',
  63: 'I-POSTAL_ADDRESS', 64: 'I-PROPER_NAME', 65: 'I-RELIGION_OR_BELIEF',
  66: 'I-SEXUAL_ORIENTATION', 67: 'I-TRADE_UNION_MEMBERSHIP', 68: 'I-VEHICLE_IDENTIFIER',
};

/** Map bardsai entity labels → DocCloak EntityType */
const LABEL_TO_ENTITY_TYPE: Record<string, EntityType> = {
  PERSON_NAME: 'PERSON',
  PERSON_ALIAS: 'PERSON',
  PROPER_NAME: 'PERSON',
  EMAIL_ADDRESS: 'EMAIL',
  CONTACT_HANDLE: 'EMAIL',
  PHONE_NUMBER: 'PHONE',
  PERSON_IDENTIFIER: 'SSN',
  DATE_OF_BIRTH: 'DATE',
  PAYMENT_CARD: 'CREDIT_CARD',
  PAYMENT_CARD_SECURITY: 'CREDIT_CARD',
  IP_ADDRESS: 'IP_ADDRESS',
  BANK_ACCOUNT_IDENTIFIER: 'IBAN',
  ACCOUNT_IDENTIFIER: 'IBAN',
  POSTAL_ADDRESS: 'ADDRESS',
  LOCATION: 'ADDRESS',
  GEO_LOCATION: 'ADDRESS',
  ORGANIZATION_NAME: 'COMPANY',
  ORGANIZATION_IDENTIFIER: 'COMPANY',
  FINANCIAL_AMOUNT: 'OTHER',
  VEHICLE_IDENTIFIER: 'OTHER',
  DOCUMENT_REFERENCE: 'OTHER',
  DOCUMENT_IDENTIFIER: 'OTHER',
  IDENTIFYING_LINK: 'OTHER',
  PERSON_ROLE_OR_TITLE: 'OTHER',
  PERSON_ATTRIBUTE: 'OTHER',
  AUTH_SECRET: 'OTHER',
  DEVICE_IDENTIFIER: 'OTHER',
  BIOMETRIC_DATA: 'OTHER',
  HEALTH_DATA: 'OTHER',
  CRIMINAL_OFFENCE_DATA: 'OTHER',
  ETHNIC_ORIGIN: 'OTHER',
  POLITICAL_OPINION: 'OTHER',
  RELIGION_OR_BELIEF: 'OTHER',
  SEXUAL_ORIENTATION: 'OTHER',
  TRADE_UNION_MEMBERSHIP: 'OTHER',
};

/** Extract the bare entity name from a BIO tag like "B-PERSON_NAME" → "PERSON_NAME" */
function bioToEntity(tag: string): string | null {
  if (tag === 'O' || !tag.includes('-')) return null;
  return tag.split('-').slice(1).join('-');
}

export class BardsaiProvider implements DetectionProvider {
  private _name = MODEL_NAME;
  get name(): string { return this._name; }

  private readonly env: CoreEnv;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tokenizer: any = null;
  private session: ort.InferenceSession | null = null;
  private loading = false;
  private loadError: Error | null = null;
  private loadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private progressCallback: ProgressCallback | null = null;
  private threshold = DEFAULT_THRESHOLD;
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
      // Default to single-threaded WASM. ORT's multi-threaded path hangs silently
      // in some cross-origin-isolated browser contexts when spawning pthread
      // workers (model downloads but session.create never resolves).
      ort.env.wasm.numThreads = this.env.wasm.numThreads ?? 1;

      const loaderEnv: ModelLoaderEnv = {
        cache: this.env.modelCache,
        fetch: this.env.fetch,
        persistStorage: this.env.persistStorage,
      };

      // Old cache entry from the pre-pinning resolve/main URL - drop it so
      // a 279 MB stale copy does not linger against the origin quota.
      void evictModelFromCache(loaderEnv, LEGACY_MODEL_URL);

      // Load tokenizer and model in parallel (skip tokenizer if already loaded from a prior session)
      const tasks: Promise<unknown>[] = [
        fetchModelBlob(loaderEnv, MODEL_URL, (downloaded, total) => this.progressCallback?.(downloaded, total), {
          sha256: BARDSAI_MODEL_SHA256,
          onVerified: (verification) => {
            this.verification = verification;
            console.info(`[DocCloak] Model verified: ${this._name} SHA-256 ${verification.sha256.slice(0, 12)}... matches the published hash (see documentation/model-provenance.md)`);
          },
        }),
      ];
      if (!this.tokenizer) {
        tasks.push(
          loadPinnedTokenizer(this.env, TOKENIZER_FILES, TOKENIZER_HF).then((t: unknown) => {
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
    if (!text.trim()) return [];

    // Split into words with character offsets
    const words: { word: string; start: number; end: number }[] = [];
    const wordRegex = /\S+/g;
    let match: RegExpExecArray | null;
    while ((match = wordRegex.exec(text)) !== null) {
      words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    }

    if (words.length === 0) return [];

    // Tokenize full text once to count subtokens per word via ▁ prefix.
    // transformers.js 4.x removed tokenizer.model.convert_ids_to_tokens;
    // tokenize() returns the same SentencePiece token strings directly.
    onProgress?.(0);
    const tokenStrings: string[] = this.tokenizer.tokenize(words.map((w) => w.word).join(' '));

    // Count subtokens per word: ▁ prefix marks word boundaries (SentencePiece)
    const subtokenCounts: number[] = [];
    let currentCount = 0;
    for (const tok of tokenStrings) {
      if (tok.startsWith('\u2581') && currentCount > 0) {
        subtokenCounts.push(currentCount);
        currentCount = 1;
      } else {
        currentCount++;
      }
    }
    if (currentCount > 0) subtokenCounts.push(currentCount);

    // Pad if mismatch (rare edge case)
    while (subtokenCounts.length < words.length) subtokenCounts.push(1);
    onProgress?.(0.1);

    // Count total chunks for progress tracking
    const maxSubtokens = MAX_SEQ_LENGTH - 2;
    const overlapWords = CHUNK_OVERLAP;

    // Pre-count chunks
    let totalChunks = 0;
    {
      let ci = 0;
      while (ci < words.length) {
        let sum = 0, ce = ci;
        while (ce < words.length && sum + subtokenCounts[ce] <= maxSubtokens) { sum += subtokenCounts[ce]; ce++; }
        if (ce === ci) ce = ci + 1;
        totalChunks++;
        const next = Math.max(ci + 1, ce - overlapWords);
        if (ce >= words.length) break;
        ci = next;
      }
    }

    // Process chunks with progress
    const allEntities: DetectedEntity[] = [];
    let i = 0;
    let chunksDone = 0;

    onProgress?.(0.1); // tokenization done

    while (i < words.length) {
      let subtokenSum = 0;
      let end = i;
      while (end < words.length && subtokenSum + subtokenCounts[end] <= maxSubtokens) {
        subtokenSum += subtokenCounts[end];
        end++;
      }
      if (end === i) end = i + 1;

      const chunkWords = words.slice(i, end);
      const chunkEntities = await this.inferChunk(chunkWords, text);
      allEntities.push(...chunkEntities);

      chunksDone++;
      onProgress?.(0.1 + 0.9 * (chunksDone / totalChunks)); // inference = 10-100%
      await new Promise((r) => setTimeout(r, 0));

      const nextStart = Math.max(i + 1, end - overlapWords);
      i = nextStart;
      if (end >= words.length) break;
    }

    return this.deduplicateSpans(allEntities);
  }

  private async inferChunk(
    words: { word: string; start: number; end: number }[],
    fullText: string,
  ): Promise<DetectedEntity[]> {
    const chunkText = words.map((w) => w.word).join(' ');
    const encoded = await this.tokenizer(chunkText, {
      return_tensors: 'np',
      truncation: true,
      max_length: MAX_SEQ_LENGTH,
      padding: true,
    });

    const inputIds = encoded.input_ids.data as BigInt64Array;
    const attentionMask = encoded.attention_mask.data as BigInt64Array;
    const seqLen = encoded.input_ids.dims[1];

    // Build word→subtoken alignment via ▁ prefix (no per-word tokenization needed)
    // transformers.js 4.x removed tokenizer.model.convert_ids_to_tokens;
    // tokenize() returns the token strings without specials, so positions are
    // offset by 1 for the leading <s> in the encoded sequence and the seqLen
    // guard stops at the truncation boundary.
    const chunkTokenStrings: string[] = this.tokenizer.tokenize(chunkText);
    const wordSubtokenStart: number[] = [];
    for (let i = 0; i < chunkTokenStrings.length && i + 1 < seqLen - 1; i++) {
      if (chunkTokenStrings[i].startsWith('\u2581')) {
        wordSubtokenStart.push(i + 1);
      }
    }

    // XLM-RoBERTa: only input_ids + attention_mask (no token_type_ids)
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', inputIds, [1, seqLen]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, seqLen]),
    };

    const results = await this.session!.run(feeds);
    const logits = results.logits.data as Float32Array;
    const numLabels = results.logits.dims[2];

    // Per-subtoken predictions: argmax + softmax confidence
    const predictions: { labelIdx: number; confidence: number }[] = [];
    for (let t = 0; t < seqLen; t++) {
      const offset = t * numLabels;
      let maxIdx = 0;
      let maxVal = logits[offset];
      for (let l = 1; l < numLabels; l++) {
        if (logits[offset + l] > maxVal) {
          maxVal = logits[offset + l];
          maxIdx = l;
        }
      }
      let sumExp = 0;
      for (let l = 0; l < numLabels; l++) {
        sumExp += Math.exp(logits[offset + l] - maxVal);
      }
      predictions.push({ labelIdx: maxIdx, confidence: 1 / sumExp });
    }

    // Aggregate subtoken predictions to word level (first subtoken wins)
    const entities: DetectedEntity[] = [];
    let currentEntity: {
      entityName: string;
      entityType: EntityType;
      startWord: number;
      endWord: number;
      confidence: number;
      tokenCount: number;
    } | null = null;

    for (let wi = 0; wi < words.length; wi++) {
      const stIdx = wordSubtokenStart[wi];
      if (stIdx === undefined || stIdx >= seqLen - 1) break;

      const pred = predictions[stIdx];
      const label = ID2LABEL[pred.labelIdx] || 'O';
      const entityName = bioToEntity(label);
      const isB = label.startsWith('B-');
      const isI = label.startsWith('I-');

      if (isB) {
        if (currentEntity) {
          this.emitEntity(currentEntity, words, fullText, entities);
        }
        currentEntity = {
          entityName: entityName!,
          entityType: LABEL_TO_ENTITY_TYPE[entityName!] || 'OTHER',
          startWord: wi,
          endWord: wi,
          confidence: pred.confidence,
          tokenCount: 1,
        };
      } else if (isI && currentEntity && entityName === currentEntity.entityName) {
        currentEntity.endWord = wi;
        currentEntity.confidence += pred.confidence;
        currentEntity.tokenCount += 1;
      } else {
        if (currentEntity) {
          this.emitEntity(currentEntity, words, fullText, entities);
          currentEntity = null;
        }
      }
    }

    if (currentEntity) {
      this.emitEntity(currentEntity, words, fullText, entities);
    }

    return entities;
  }

  private emitEntity(
    entity: {
      entityName: string;
      entityType: EntityType;
      startWord: number;
      endWord: number;
      confidence: number;
      tokenCount: number;
    },
    words: { word: string; start: number; end: number }[],
    fullText: string,
    entities: DetectedEntity[],
  ): void {
    const avgConfidence = entity.confidence / entity.tokenCount;
    if (avgConfidence < this.threshold) return;

    const charStart = words[entity.startWord].start;
    const charEnd = words[entity.endWord].end;

    entities.push({
      type: entity.entityType,
      value: fullText.slice(charStart, charEnd),
      start: charStart,
      end: charEnd,
      confidence: avgConfidence,
      detector: `bardsai:${entity.entityName}`,
    });
  }

  private deduplicateSpans(entities: DetectedEntity[]): DetectedEntity[] {
    const sorted = [...entities].sort((a, b) => b.confidence - a.confidence);
    const result: DetectedEntity[] = [];
    for (const e of sorted) {
      const overlaps = result.some(
        (existing) => e.start < existing.end && e.end > existing.start,
      );
      if (!overlaps) result.push(e);
    }
    return result;
  }

}
