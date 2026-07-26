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

/*
 * Forward declarations. RegionCode and DetectedEntity are owned by the regex
 * and types extraction tasks; the shapes below mirror the web app source
 * (DocCloak/src/core/regex/types.ts and DocCloak/src/core/types.ts) so the
 * engine API can reference them today. They move to their own modules and
 * become re-exports when those tasks land.
 */

export type RegionCode =
  | 'universal'
  | 'gb'
  | 'pl'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt'
  | 'se'
  | 'no'
  | 'it'
  | 'nl'
  | 'be'
  | 'at'
  | 'ch'
  | 'ie'
  | 'dk'
  | 'fi'
  | 'us'
  | (string & {});

export type EntityType =
  | 'PERSON'
  | 'EMAIL'
  | 'PHONE'
  | 'SSN'
  | 'CREDIT_CARD'
  | 'DATE'
  | 'CURRENCY'
  | 'IP_ADDRESS'
  | 'IBAN'
  | 'ADDRESS'
  | 'COMPANY'
  | 'OTHER';

export interface DetectedEntity {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  confidence: number;
  detector: string;
}

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
