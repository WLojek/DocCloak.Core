/**
 * @doccloak/core - engine assembly (T009).
 *
 * createEngine() turns the injected CoreEnv plus the two built-in detection
 * providers into a DocCloakEngine: provider registry, settings persisted
 * through env.kv under the exact localStorage keys the web app has always
 * used (see ENGINE_SETTINGS_KEYS - no prefixing, so pre-extraction user
 * profiles read back unchanged), per-provider threshold defaults, progress
 * event fan-out and the mobile/low-memory default-model heuristic fed by
 * env.hardware.
 *
 * The engine is transport-agnostic; worker-protocol.ts serves it over any
 * PortLike transport (Web Worker postMessage, MessageChannel, extension
 * ports).
 */

import type { CoreEnv, HardwareHints } from './env.ts';
import type { DetectedEntity, DetectionProvider } from './types.ts';
import { detectWithRegex, detectEntities } from './pipeline.ts';
import { GlinerProvider } from './providers/gliner.ts';
import { GlinerBaseProvider } from './providers/gliner-base.ts';
import { BardsaiProvider } from './providers/bardsai.ts';
import { REGEX_REGIONS, type RegexRegionId } from './regex/index.ts';

// ── Provider registry ──────────────────────────────────────

export type ProviderId = 'gliner' | 'gliner-base' | 'bardsai';

export interface ProviderEntry {
  id: ProviderId;
  label: string;
  description: string;
}

/** Catalog of the built-in providers (labels/descriptions shown by hosts). */
export const PROVIDERS: ProviderEntry[] = [
  {
    id: 'gliner',
    label: 'GLiNER PII Small',
    description: 'Lightweight, multi-language, supports custom labels (~83 MB)',
  },
  {
    id: 'gliner-base',
    label: 'GLiNER PII Base',
    description: 'May be better for English and dates, supports custom labels (~197 MB)',
  },
  {
    id: 'bardsai',
    label: 'BardS.ai EU PII',
    description: 'Best multilingual accuracy, 24+ EU languages, 35 PII types (~279 MB)',
  },
];

export type ProviderFactory = (env: CoreEnv) => DetectionProvider;

export interface EngineOptions {
  /** Override provider construction (tests inject deterministic stubs). */
  providers?: Partial<Record<ProviderId, ProviderFactory>>;
}

// ── Settings ───────────────────────────────────────────────

/**
 * env.kv keys, byte-identical to the localStorage keys the web app used
 * before the extraction. A 1:1 KV adapter (no prefixing) therefore reads a
 * legacy profile back correctly.
 */
export const ENGINE_SETTINGS_KEYS = {
  provider: 'doccloak-active-provider',
  customLabels: 'doccloak-custom-labels',
  regexEnabled: 'doccloak-regex-enabled',
  regexRegion: 'doccloak-regex-region',
} as const;

export interface EngineSettings {
  providerId: ProviderId;
  /** Not persisted (matches the pre-extraction behavior): resets to the provider default on init/switch. */
  threshold: number;
  regexEnabled: boolean;
  regexRegion: RegexRegionId;
  customLabels: string[];       // GLiNER only
}

export interface DocCloakEngine {
  /** Resolves once persisted settings have been read from env.kv. */
  readonly ready: Promise<void>;
  detect(
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
  ): Promise<DetectedEntity[]>;
  /** Download + init the current provider. */
  preload(): Promise<void>;
  switchProvider(id: ProviderId): Promise<void>;
  getSettings(): EngineSettings;
  /** Merges the patch, persists via env.kv and applies it to the live provider. */
  updateSettings(patch: Partial<EngineSettings>): Promise<void>;
  onDownloadProgress(cb: (p: { loaded: number; total: number }) => void): () => void;
  onDetectionProgress(cb: (progress: number) => void): () => void;
  /** Free ONNX session memory; the model reloads on the next detect/preload. */
  release(): Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────

/** Per-provider confidence threshold defaults. */
export function defaultThresholdFor(id: ProviderId): number {
  return id === 'bardsai' ? 0.5 : 0.35;
}

/** Clamp a detection threshold to the supported 0.05-0.95 range. */
export function clampThreshold(value: number): number {
  return Math.max(0.05, Math.min(0.95, value));
}

/**
 * Default-model heuristic for devices without a saved provider choice.
 * Large models (~200-500+ MB peak RAM while loading) routinely get the tab
 * killed on mobile browsers, so constrained devices default to the
 * lightweight GLiNER Small model (~83 MB). Desktop-class devices default
 * to GLiNER PII Base (~197 MB, higher accuracy, zero-shot custom labels;
 * T122 - previously BardS.ai, which stays selectable as legacy). A saved
 * provider choice always wins over this heuristic (existing behavior).
 * Hosts feed the hints (userAgent/deviceMemory sniffing stays host-side).
 */
export function pickDefaultProvider(hardware?: HardwareHints): ProviderId {
  if (hardware?.isMobile) return 'gliner';
  if (typeof hardware?.deviceMemoryGB === 'number' && hardware.deviceMemoryGB <= 4) return 'gliner';
  // T127: the 2026-08 benchmark (documentation/model-comparison-2026-08.md)
  // showed bardsai is the strongest and most uniform across languages, so it
  // is the capable-device default again; gliner-base stays selectable as the
  // English/dates/custom-labels alternative.
  return 'bardsai';
}

function isProviderId(value: unknown): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}

function isRegexRegionId(value: unknown): value is RegexRegionId {
  return typeof value === 'string' && (REGEX_REGIONS as readonly string[]).includes(value);
}

interface CustomLabelCapable {
  setCustomLabels(labels: string[]): void | Promise<void>;
  getCustomLabels(): string[];
}

function supportsCustomLabels(p: DetectionProvider): p is DetectionProvider & CustomLabelCapable {
  return 'setCustomLabels' in p;
}

// ── Engine ─────────────────────────────────────────────────

export function createEngine(
  env: CoreEnv,
  initial?: Partial<EngineSettings>,
  options?: EngineOptions,
): DocCloakEngine {
  const factories: Record<ProviderId, ProviderFactory> = {
    gliner: (e) => new GlinerProvider(e),
    'gliner-base': (e) => new GlinerBaseProvider(e),
    bardsai: (e) => new BardsaiProvider(e),
    ...options?.providers,
  };

  const settings: EngineSettings = {
    providerId: initial?.providerId ?? pickDefaultProvider(env.hardware),
    threshold: 0,
    regexEnabled: initial?.regexEnabled ?? false,
    regexRegion: initial?.regexRegion ?? 'all',
    customLabels: [...(initial?.customLabels ?? [])],
  };
  settings.threshold = initial?.threshold !== undefined
    ? clampThreshold(initial.threshold)
    : defaultThresholdFor(settings.providerId);

  /** Load persisted settings; explicit `initial` values win over env.kv. */
  const ready: Promise<void> = (async () => {
    if (initial?.providerId === undefined) {
      try {
        const saved = await env.kv.get(ENGINE_SETTINGS_KEYS.provider);
        if (isProviderId(saved)) {
          settings.providerId = saved;
          if (initial?.threshold === undefined) settings.threshold = defaultThresholdFor(saved);
        }
      } catch { /* KV unavailable - keep the heuristic default */ }
    }
    if (initial?.customLabels === undefined) {
      try {
        const saved = await env.kv.get(ENGINE_SETTINGS_KEYS.customLabels);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (Array.isArray(parsed)) {
            settings.customLabels = parsed.filter((l): l is string => typeof l === 'string');
          }
        }
      } catch { /* unreadable value - keep default */ }
    }
    if (initial?.regexEnabled === undefined) {
      try {
        const saved = await env.kv.get(ENGINE_SETTINGS_KEYS.regexEnabled);
        if (saved !== null) settings.regexEnabled = JSON.parse(saved) === true;
      } catch { /* unreadable value - keep default */ }
    }
    if (initial?.regexRegion === undefined) {
      try {
        const saved = await env.kv.get(ENGINE_SETTINGS_KEYS.regexRegion);
        if (isRegexRegionId(saved)) settings.regexRegion = saved;
      } catch { /* unreadable value - keep default */ }
    }
  })();

  let provider: DetectionProvider | null = null;
  let inflightLoad: Promise<void> | null = null;

  const downloadListeners = new Set<(p: { loaded: number; total: number }) => void>();
  const detectionListeners = new Set<(progress: number) => void>();

  async function kvSet(key: string, value: string): Promise<void> {
    try {
      await env.kv.set(key, value);
    } catch { /* KV unavailable (e.g. storage-less worker) - settings stay in memory */ }
  }

  function ensureProvider(): DetectionProvider {
    if (!provider) {
      const factory = factories[settings.providerId];
      if (!factory) throw new Error(`Unknown provider: ${settings.providerId}`);
      provider = factory(env);
      provider.onProgress((downloaded, total) => {
        for (const cb of downloadListeners) cb({ loaded: downloaded, total });
      });
    }
    return provider;
  }

  async function applyCustomLabels(p: DetectionProvider): Promise<void> {
    if (supportsCustomLabels(p)) {
      await p.setCustomLabels(settings.customLabels);
    }
  }

  async function preload(): Promise<void> {
    await ready;
    if (inflightLoad) return inflightLoad;
    const p = ensureProvider();
    if (p.isLoaded()) return;
    inflightLoad = (async () => {
      // A previous attempt may have failed: release() clears the cached load
      // error so load() can retry (model bytes are served from the blob
      // cache when available). Mirrors the old worker init path.
      if (!p.isLoading()) p.release();
      await applyCustomLabels(p);
      await p.load();
      settings.threshold = p.getThreshold();
      if (supportsCustomLabels(p)) settings.customLabels = p.getCustomLabels();
    })();
    try {
      await inflightLoad;
    } finally {
      inflightLoad = null;
    }
  }

  async function switchProvider(id: ProviderId): Promise<void> {
    await ready;
    if (!factories[id]) throw new Error(`Unknown provider: ${id}`);
    if (id === settings.providerId && provider?.isLoaded()) return;
    // Release the previous ONNX session to free WASM heap. Cached model
    // files are kept so switching back does not re-download hundreds of
    // megabytes; the browser evicts them under quota pressure.
    provider?.release();
    provider = null;
    settings.providerId = id;
    settings.threshold = defaultThresholdFor(id);
    await kvSet(ENGINE_SETTINGS_KEYS.provider, id);
    await preload();
  }

  async function updateSettings(patch: Partial<EngineSettings>): Promise<void> {
    await ready;
    if (patch.providerId !== undefined && patch.providerId !== settings.providerId) {
      if (!factories[patch.providerId]) throw new Error(`Unknown provider: ${patch.providerId}`);
      provider?.release();
      provider = null;
      settings.providerId = patch.providerId;
      settings.threshold = defaultThresholdFor(patch.providerId);
      await kvSet(ENGINE_SETTINGS_KEYS.provider, patch.providerId);
    }
    if (patch.threshold !== undefined) {
      settings.threshold = clampThreshold(patch.threshold);
      provider?.setThreshold(settings.threshold);
    }
    if (patch.customLabels !== undefined) {
      settings.customLabels = patch.customLabels.filter((l) => l.trim().length > 0);
      await kvSet(ENGINE_SETTINGS_KEYS.customLabels, JSON.stringify(settings.customLabels));
      if (provider) await applyCustomLabels(provider);
    }
    if (patch.regexEnabled !== undefined) {
      settings.regexEnabled = patch.regexEnabled;
      await kvSet(ENGINE_SETTINGS_KEYS.regexEnabled, JSON.stringify(patch.regexEnabled));
    }
    if (patch.regexRegion !== undefined) {
      settings.regexRegion = patch.regexRegion;
      await kvSet(ENGINE_SETTINGS_KEYS.regexRegion, patch.regexRegion);
    }
  }

  async function detect(
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
  ): Promise<DetectedEntity[]> {
    await ready;
    if (signal?.aborted) throw new Error('Detection aborted');
    if (!text.trim()) return [];
    const p = ensureProvider();
    const mlResults = await p.detect(text, (progress: number) => {
      onProgress?.(progress);
      for (const cb of detectionListeners) cb(progress);
    });
    if (signal?.aborted) throw new Error('Detection aborted');
    const regexResults = settings.regexEnabled ? detectWithRegex(text, settings.regexRegion) : [];
    return detectEntities(text, mlResults, regexResults);
  }

  return {
    ready,
    detect,
    preload,
    switchProvider,
    getSettings(): EngineSettings {
      return { ...settings, customLabels: [...settings.customLabels] };
    },
    updateSettings,
    onDownloadProgress(cb) {
      downloadListeners.add(cb);
      return () => downloadListeners.delete(cb);
    },
    onDetectionProgress(cb) {
      detectionListeners.add(cb);
      return () => detectionListeners.delete(cb);
    },
    async release(): Promise<void> {
      provider?.release();
    },
  };
}
