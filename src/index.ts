/**
 * @doccloak/core - public API surface.
 *
 * Environment contracts (env.ts) are real. The engine API below is declared
 * types-only per architecture doc section 4.3; the implementation arrives with
 * the engine extraction tasks. Session, pipeline, regex and doc re-exports are
 * added as those modules move here from the DocCloak web app.
 */

import type { CoreEnv } from './env.ts';

export type {
  KVStore,
  BlobCache,
  HardwareHints,
  CoreEnv,
  MemoryBlobCacheOptions,
} from './env.ts';
export { memoryKV, memoryBlobCache } from './env.ts';

export const CORE_PACKAGE_NAME = '@doccloak/core';

// T006: model loader
export { fetchModelBlob, evictModelFromCache, retryAsync } from './model-loader.ts';
export type { ModelLoaderEnv, DownloadProgress, FetchModelOptions } from './model-loader.ts';
// end T006

// T004: regex rules
import type { RegionCode } from './regex/index.ts';
export { ALL_REGEX_RULES } from './regex/index.ts';
export type { RegexRule, PiiDomain, RegionCode } from './regex/index.ts';
// end T004

// T003: types / session / doc
import type { DetectedEntity } from './types.ts';
export * from './types.ts';
export * from './session.ts';
export * from './doc.ts';
// end T003

// T005: pipeline
export {
  detectWithRegex,
  resolveOverlaps,
  filterFalsePositives,
  propagateEntities,
  detectEntities,
} from './pipeline.ts';
// end T005

/* Engine API, architecture doc section 4.3. */

export type ProviderId = 'gliner' | 'bardsai';

export interface EngineSettings {
  providerId: ProviderId;
  threshold: number;            // per-provider defaults: gliner 0.35, bardsai 0.5
  regexEnabled: boolean;
  regexRegion: RegionCode | 'all';
  customLabels: string[];       // GLiNER only
}

export interface DocCloakEngine {
  detect(text: string, signal?: AbortSignal): Promise<DetectedEntity[]>;
  preload(): Promise<void>;                       // download + init current provider
  switchProvider(id: ProviderId): Promise<void>;
  getSettings(): EngineSettings;
  updateSettings(patch: Partial<EngineSettings>): Promise<void>;  // persists via env.kv
  onDownloadProgress(cb: (p: { loaded: number; total: number }) => void): () => void;
  onDetectionProgress(cb: (p: { done: number; total: number }) => void): () => void;
  release(): Promise<void>;                       // free ONNX session memory
}

/** Declaration only; implemented by the engine extraction task. */
export declare function createEngine(
  env: CoreEnv,
  initial?: Partial<EngineSettings>,
): DocCloakEngine;
