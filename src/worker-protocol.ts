/**
 * @doccloak/core - transport-agnostic worker message protocol (T009).
 *
 * Formalizes the message pairs the web app's engine.ts and
 * detection.worker.ts have always exchanged, keeping the exact message
 * names and payload fields on the wire:
 *
 *   init / switchProvider  -> loaded | loadError   (+ downloadProgress events)
 *   detect                 -> detected | detectError (+ detectionProgress events)
 *   releaseModel           -> released
 *   setThreshold / setCustomLabels / setRegex / setRegexRegion  (fire and forget)
 *
 * Correlation keeps the existing requestId scheme; requestId is optional on
 * the request side so legacy-style senders (and the regression harness)
 * keep working, while connectEngine always correlates.
 *
 * serveEngine() is the host side: it answers protocol messages with a real
 * engine (web worker entry, extension offscreen document). connectEngine()
 * is the client side: a DocCloakEngine that forwards over the port (web
 * main thread, extension side panel / service worker).
 */

import type { DetectedEntity } from './types.ts';
import type { DocCloakEngine, EngineSettings, ProviderId } from './engine.ts';
import { clampThreshold, defaultThresholdFor } from './engine.ts';
import type { RegexRegionId } from './regex/index.ts';

// ── Transport contract ─────────────────────────────────────

/** Satisfied by Worker, MessagePort and chrome.runtime.Port wrappers. */
export interface PortLike {
  postMessage(msg: unknown): void;
  /** Register a message callback; returns an unsubscribe function. */
  onMessage(cb: (msg: unknown) => void | Promise<void>): () => void;
}

// ── Wire format (names identical to the pre-extraction protocol) ──

export type EngineRequest =
  | { type: 'init'; requestId?: number; providerId?: ProviderId; customLabels?: string[]; regexEnabled?: boolean; regexRegion?: RegexRegionId }
  | { type: 'detect'; requestId: number; text: string }
  | { type: 'switchProvider'; requestId?: number; providerId: ProviderId; customLabels?: string[] }
  | { type: 'setThreshold'; value: number }
  | { type: 'setCustomLabels'; labels: string[] }
  | { type: 'setRegex'; enabled: boolean; region?: RegexRegionId }
  | { type: 'setRegexRegion'; region: RegexRegionId }
  | { type: 'releaseModel'; requestId?: number };

export type EngineResponse =
  | { type: 'loaded'; requestId?: number; providerId: ProviderId; threshold: number; customLabels: string[] }
  | { type: 'loadError'; requestId?: number; error: string }
  | { type: 'detected'; requestId: number; entities: DetectedEntity[] }
  | { type: 'detectError'; requestId: number; error: string }
  | { type: 'detectionProgress'; requestId: number; progress: number }
  | { type: 'downloadProgress'; downloaded: number; total: number }
  | { type: 'released'; requestId?: number };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Host side ──────────────────────────────────────────────

/**
 * Serve a real engine over a port. Returns a stop function that
 * unsubscribes from the port and the engine's progress events.
 */
export function serveEngine(engine: DocCloakEngine, port: PortLike): () => void {
  const unsubscribeDownload = engine.onDownloadProgress(({ loaded, total }) => {
    const msg: EngineResponse = { type: 'downloadProgress', downloaded: loaded, total };
    port.postMessage(msg);
  });

  function post(msg: EngineResponse): void {
    port.postMessage(msg);
  }

  async function handleLoad(requestId: number | undefined, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      const s = engine.getSettings();
      post({ type: 'loaded', requestId, providerId: s.providerId, threshold: s.threshold, customLabels: s.customLabels });
    } catch (err) {
      post({ type: 'loadError', requestId, error: errorMessage(err) });
    }
  }

  const unsubscribeMessages = port.onMessage(async (raw) => {
    const msg = raw as EngineRequest;
    switch (msg.type) {
      case 'init': {
        await handleLoad(msg.requestId, async () => {
          const patch: Partial<EngineSettings> = {};
          if (msg.providerId !== undefined) patch.providerId = msg.providerId;
          if (msg.customLabels !== undefined) patch.customLabels = msg.customLabels;
          if (msg.regexEnabled !== undefined) patch.regexEnabled = msg.regexEnabled;
          if (msg.regexRegion !== undefined) patch.regexRegion = msg.regexRegion;
          await engine.updateSettings(patch);
          await engine.preload();
        });
        break;
      }

      case 'switchProvider': {
        await handleLoad(msg.requestId, async () => {
          if (msg.customLabels !== undefined) {
            await engine.updateSettings({ customLabels: msg.customLabels });
          }
          await engine.switchProvider(msg.providerId);
        });
        break;
      }

      case 'detect': {
        try {
          const entities = await engine.detect(msg.text, undefined, (progress) => {
            post({ type: 'detectionProgress', requestId: msg.requestId, progress });
          });
          post({ type: 'detected', requestId: msg.requestId, entities });
        } catch (err) {
          post({ type: 'detectError', requestId: msg.requestId, error: errorMessage(err) });
        }
        break;
      }

      case 'setThreshold': {
        await engine.updateSettings({ threshold: msg.value });
        break;
      }

      case 'setCustomLabels': {
        await engine.updateSettings({ customLabels: msg.labels });
        break;
      }

      case 'setRegex': {
        const patch: Partial<EngineSettings> = { regexEnabled: msg.enabled };
        if (msg.region !== undefined) patch.regexRegion = msg.region;
        await engine.updateSettings(patch);
        break;
      }

      case 'setRegexRegion': {
        await engine.updateSettings({ regexRegion: msg.region });
        break;
      }

      case 'releaseModel': {
        await engine.release();
        post({ type: 'released', requestId: msg.requestId });
        break;
      }
    }
  });

  return () => {
    unsubscribeMessages();
    unsubscribeDownload();
  };
}

// ── Client side ────────────────────────────────────────────

/** DocCloakEngine proxy returned by connectEngine. */
export interface EngineClient extends DocCloakEngine {
  /**
   * Switch provider, optionally sending fresh custom labels in the same
   * message (mirrors the pre-extraction switchProvider payload).
   */
  switchProvider(id: ProviderId, customLabels?: string[]): Promise<void>;
  /**
   * Tear the connection down: rejects pending detections/loads (resolves
   * pending releases) and stops listening. Hosts call this when the
   * underlying worker crashes.
   */
  close(reason?: Error): void;
}

interface PendingRequest {
  kind: 'load' | 'detect' | 'release';
  resolve: (value: DetectedEntity[] | undefined) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number) => void;
}

/**
 * Connect to a served engine over a port. The client keeps a synchronous
 * settings mirror (seeded from `initial`, updated from loaded responses)
 * so getSettings() works without a round trip; persistence stays with
 * whichever side owns the KV store.
 */
export function connectEngine(port: PortLike, initial?: Partial<EngineSettings>): EngineClient {
  const initialProvider: ProviderId = initial?.providerId ?? 'bardsai';
  const settings: EngineSettings = {
    providerId: initialProvider,
    threshold: initial?.threshold ?? defaultThresholdFor(initialProvider),
    regexEnabled: initial?.regexEnabled ?? false,
    regexRegion: initial?.regexRegion ?? 'all',
    customLabels: [...(initial?.customLabels ?? [])],
  };

  let nextRequestId = 0;
  let closed = false;
  const pending = new Map<number, PendingRequest>();
  const downloadListeners = new Set<(p: { loaded: number; total: number }) => void>();
  const detectionListeners = new Set<(progress: number) => void>();

  function takePending(requestId: number | undefined): PendingRequest | undefined {
    if (requestId === undefined) return undefined;
    const entry = pending.get(requestId);
    if (entry) pending.delete(requestId);
    return entry;
  }

  const unsubscribe = port.onMessage((raw) => {
    const msg = raw as EngineResponse;
    switch (msg.type) {
      case 'downloadProgress': {
        for (const cb of downloadListeners) cb({ loaded: msg.downloaded, total: msg.total });
        break;
      }
      case 'detectionProgress': {
        pending.get(msg.requestId)?.onProgress?.(msg.progress);
        for (const cb of detectionListeners) cb(msg.progress);
        break;
      }
      case 'loaded': {
        settings.providerId = msg.providerId;
        settings.threshold = msg.threshold;
        settings.customLabels = [...(msg.customLabels ?? [])];
        takePending(msg.requestId)?.resolve(undefined);
        break;
      }
      case 'loadError': {
        takePending(msg.requestId)?.reject(new Error(msg.error));
        break;
      }
      case 'detected': {
        takePending(msg.requestId)?.resolve(msg.entities ?? []);
        break;
      }
      case 'detectError': {
        takePending(msg.requestId)?.reject(new Error(msg.error));
        break;
      }
      case 'released': {
        takePending(msg.requestId)?.resolve(undefined);
        break;
      }
    }
  });

  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

  function request(
    kind: PendingRequest['kind'],
    message: DistributiveOmit<EngineRequest, 'requestId'>,
    onProgress?: (progress: number) => void,
  ): Promise<DetectedEntity[] | undefined> {
    if (closed) return Promise.reject(new Error('Engine connection closed'));
    const requestId = ++nextRequestId;
    return new Promise<DetectedEntity[] | undefined>((resolve, reject) => {
      pending.set(requestId, { kind, resolve, reject, onProgress });
      port.postMessage({ ...message, requestId });
    });
  }

  async function preload(): Promise<void> {
    await request('load', {
      type: 'init',
      providerId: settings.providerId,
      customLabels: settings.customLabels,
      regexEnabled: settings.regexEnabled,
      regexRegion: settings.regexRegion,
    });
  }

  async function switchProvider(id: ProviderId, customLabels?: string[]): Promise<void> {
    const labels = customLabels ?? settings.customLabels;
    settings.customLabels = [...labels];
    await request('load', { type: 'switchProvider', providerId: id, customLabels: labels });
  }

  async function updateSettings(patch: Partial<EngineSettings>): Promise<void> {
    if (patch.regexRegion !== undefined && patch.regexEnabled === undefined) {
      settings.regexRegion = patch.regexRegion;
      port.postMessage({ type: 'setRegexRegion', region: patch.regexRegion } satisfies EngineRequest);
    }
    if (patch.regexEnabled !== undefined) {
      settings.regexEnabled = patch.regexEnabled;
      if (patch.regexRegion !== undefined) settings.regexRegion = patch.regexRegion;
      port.postMessage({
        type: 'setRegex',
        enabled: patch.regexEnabled,
        region: settings.regexRegion,
      } satisfies EngineRequest);
    }
    if (patch.threshold !== undefined) {
      settings.threshold = clampThreshold(patch.threshold);
      port.postMessage({ type: 'setThreshold', value: settings.threshold } satisfies EngineRequest);
    }
    if (patch.customLabels !== undefined) {
      settings.customLabels = patch.customLabels.filter((l) => l.trim().length > 0);
      port.postMessage({ type: 'setCustomLabels', labels: settings.customLabels } satisfies EngineRequest);
    }
    if (patch.providerId !== undefined && patch.providerId !== settings.providerId) {
      await switchProvider(patch.providerId);
    }
  }

  function detect(
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
  ): Promise<DetectedEntity[]> {
    if (signal?.aborted) return Promise.reject(new Error('Detection aborted'));
    const promise = request('detect', { type: 'detect', text }, onProgress) as Promise<DetectedEntity[]>;
    if (signal) {
      const requestId = nextRequestId;
      signal.addEventListener('abort', () => {
        takePending(requestId)?.reject(new Error('Detection aborted'));
      }, { once: true });
    }
    return promise;
  }

  function close(reason?: Error): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    const err = reason ?? new Error('Engine connection closed');
    for (const [, entry] of pending) {
      if (entry.kind === 'release') entry.resolve(undefined);
      else entry.reject(err);
    }
    pending.clear();
  }

  return {
    ready: Promise.resolve(),
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
      await request('release', { type: 'releaseModel' });
    },
    close,
  };
}
