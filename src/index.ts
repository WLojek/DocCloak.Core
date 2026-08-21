/**
 * @doccloak/core - public API surface.
 */

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
export { fetchModelBlob, evictModelFromCache, retryAsync, ModelIntegrityError, verificationMarkerKey } from './model-loader.ts';
export type { ModelLoaderEnv, DownloadProgress, FetchModelOptions, ModelVerification } from './model-loader.ts';
// end T006

// T004: regex rules (REGEX_REGIONS moved here from the web engine in T009)
export { ALL_REGEX_RULES, REGEX_REGIONS } from './regex/index.ts';
export type { RegexRule, PiiDomain, RegionCode, RegexRegionId } from './regex/index.ts';
// end T004

// T003: types / session / doc
export * from './types.ts';
export * from './session.ts';
export * from './doc.ts';
// end T003

// T043: surrogate generator (realistic, shape-preserving replacements)
export {
  generateSurrogate,
  generateUniqueSurrogate,
  generateSessionSalt,
  sessionDayOffset,
  FAKE_EMAIL_DOMAINS,
} from './surrogates.ts';
export type { SurrogateContext } from './surrogates.ts';
// end T043

// T007: gliner provider
export { GlinerProvider, GLINER_MODEL_URL, GLINER_MODEL_REVISION, GLINER_MODEL_SHA256 } from './providers/gliner.ts';
// end T007

// T008: bardsai provider
export { BardsaiProvider, BARDSAI_MODEL_URL, BARDSAI_MODEL_REVISION, BARDSAI_MODEL_SHA256 } from './providers/bardsai.ts';
// end T008

// T005: pipeline
export {
  detectWithRegex,
  resolveOverlaps,
  filterFalsePositives,
  propagateEntities,
  detectEntities,
} from './pipeline.ts';
// end T005

// T009: engine assembly + worker protocol
export {
  createEngine,
  PROVIDERS,
  pickDefaultProvider,
  defaultThresholdFor,
  clampThreshold,
  ENGINE_SETTINGS_KEYS,
} from './engine.ts';
export type {
  ProviderId,
  ProviderEntry,
  ProviderFactory,
  EngineOptions,
  EngineSettings,
  DocCloakEngine,
} from './engine.ts';
export { serveEngine, connectEngine } from './worker-protocol.ts';
export type {
  PortLike,
  EngineClient,
  EngineRequest,
  EngineResponse,
} from './worker-protocol.ts';
// end T009
