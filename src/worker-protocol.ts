/**
 * @doccloak/core - transport-agnostic worker message protocol (T009).
 *
 * Formalizes the message pairs the web app's engine.ts and
 * detection.worker.ts have always exchanged, keeping the exact message
 * names and payload fields on the wire:
 *
 *   init / switchProvider  -> loaded | loadError   (+ downloadProgress events)
 *   detect                 -> detected | detectError (+ detectionProgress events)
 *   cancelDetect           -> detectError { aborted: true } on the cancelled requestId (T222)
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
import { DetectionAbortedError } from './types.ts';
import type { DocCloakEngine, EngineSettings, ProviderId } from './engine.ts';
import { PROVIDERS, clampThreshold, defaultThresholdFor } from './engine.ts';
import { REGEX_REGIONS, type RegexRegionId } from './regex/index.ts';

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
  /**
   * T222: stop the detect call with this requestId at its next chunk
   * boundary. Unknown or already finished ids are ignored; the cancelled
   * call answers with detectError { aborted: true }.
   */
  | { type: 'cancelDetect'; requestId: number }
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
  | { type: 'detectError'; requestId: number; error: string; aborted?: boolean }
  | { type: 'detectionProgress'; requestId: number; progress: number }
  | { type: 'downloadProgress'; downloaded: number; total: number }
  | { type: 'released'; requestId?: number }
  /**
   * Protocol-level failure (T185, R12): a message the host could not act on
   * (unknown type, wrong payload shape) or an error outside the dedicated
   * load/detect replies. `fatal` marks a host that can no longer serve; the
   * client then rejects every pending request and closes.
   */
  | { type: 'error'; requestId?: number; error: string; fatal?: boolean };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Message validation (R12) ───────────────────────────────

const REQUEST_TYPES: ReadonlySet<string> = new Set<EngineRequest['type']>([
  'init', 'detect', 'cancelDetect', 'switchProvider', 'setThreshold', 'setCustomLabels', 'setRegex', 'setRegexRegion', 'releaseModel',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.some((p) => p.id === value);
}

function isRegexRegionId(value: unknown): value is RegexRegionId {
  return typeof value === 'string' && (REGEX_REGIONS as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalRequestId(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/**
 * Field-level validation of a message whose `type` is known. Returns a
 * description of the first problem, or null when the payload is usable.
 */
function requestProblem(msg: Record<string, unknown>): string | null {
  switch (msg.type as EngineRequest['type']) {
    case 'init':
      if (msg.providerId !== undefined && !isProviderId(msg.providerId)) return 'providerId must be a known provider id';
      if (msg.customLabels !== undefined && !isStringArray(msg.customLabels)) return 'customLabels must be an array of strings';
      if (msg.regexEnabled !== undefined && typeof msg.regexEnabled !== 'boolean') return 'regexEnabled must be a boolean';
      if (msg.regexRegion !== undefined && !isRegexRegionId(msg.regexRegion)) return 'regexRegion must be a known region id';
      return null;
    case 'detect':
      if (!isFiniteNumber(msg.requestId)) return 'requestId must be a number';
      if (typeof msg.text !== 'string') return 'text must be a string';
      return null;
    case 'cancelDetect':
      if (!isFiniteNumber(msg.requestId)) return 'requestId must be a number';
      return null;
    case 'switchProvider':
      if (!isProviderId(msg.providerId)) return 'providerId must be a known provider id';
      if (msg.customLabels !== undefined && !isStringArray(msg.customLabels)) return 'customLabels must be an array of strings';
      return null;
    case 'setThreshold':
      if (!isFiniteNumber(msg.value)) return 'value must be a finite number';
      return null;
    case 'setCustomLabels':
      if (!isStringArray(msg.labels)) return 'labels must be an array of strings';
      return null;
    case 'setRegex':
      if (typeof msg.enabled !== 'boolean') return 'enabled must be a boolean';
      if (msg.region !== undefined && !isRegexRegionId(msg.region)) return 'region must be a known region id';
      return null;
    case 'setRegexRegion':
      if (!isRegexRegionId(msg.region)) return 'region must be a known region id';
      return null;
    case 'releaseModel':
      return null;
  }
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

  /** In-flight detect calls by requestId, so cancelDetect can abort them (T222). */
  const inflight = new Map<number, AbortController>();

  async function handleLoad(requestId: number | undefined, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      const s = engine.getSettings();
      post({ type: 'loaded', requestId, providerId: s.providerId, threshold: s.threshold, customLabels: s.customLabels });
    } catch (err) {
      post({ type: 'loadError', requestId, error: errorMessage(err) });
    }
  }

  /** Fire-and-forget settings message: failures are reported, never thrown. */
  async function handleSetting(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      post({ type: 'error', error: errorMessage(err) });
    }
  }

  /**
   * Reject a message the host cannot act on. Requests with a dedicated
   * error reply (init/switchProvider -> loadError, detect -> detectError)
   * use it so legacy senders matching by type keep working; everything
   * else gets the generic protocol error.
   */
  function rejectRequest(raw: unknown, problem: string): void {
    const msg = isRecord(raw) ? raw : {};
    const requestId = optionalRequestId(msg.requestId);
    const type = typeof msg.type === 'string' ? msg.type : undefined;
    const error = type ? `Invalid ${type} message: ${problem}` : problem;
    if (type === 'init' || type === 'switchProvider') {
      post({ type: 'loadError', requestId, error });
    } else if (type === 'detect' && requestId !== undefined) {
      post({ type: 'detectError', requestId, error });
    } else {
      post({ type: 'error', requestId, error });
    }
  }

  async function dispatch(msg: EngineRequest): Promise<void> {
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
        // A repeated requestId supersedes the earlier call's controller;
        // the earlier call keeps running to completion on its own signal.
        const controller = new AbortController();
        inflight.set(msg.requestId, controller);
        try {
          const entities = await engine.detect(msg.text, controller.signal, (progress) => {
            post({ type: 'detectionProgress', requestId: msg.requestId, progress });
          });
          post({ type: 'detected', requestId: msg.requestId, entities });
        } catch (err) {
          const aborted = err instanceof DetectionAbortedError || controller.signal.aborted;
          post({ type: 'detectError', requestId: msg.requestId, error: errorMessage(err), aborted });
        } finally {
          if (inflight.get(msg.requestId) === controller) inflight.delete(msg.requestId);
        }
        break;
      }

      case 'cancelDetect': {
        inflight.get(msg.requestId)?.abort();
        break;
      }

      case 'setThreshold': {
        await handleSetting(() => engine.updateSettings({ threshold: msg.value }));
        break;
      }

      case 'setCustomLabels': {
        await handleSetting(() => engine.updateSettings({ customLabels: msg.labels }));
        break;
      }

      case 'setRegex': {
        await handleSetting(async () => {
          const patch: Partial<EngineSettings> = { regexEnabled: msg.enabled };
          if (msg.region !== undefined) patch.regexRegion = msg.region;
          await engine.updateSettings(patch);
        });
        break;
      }

      case 'setRegexRegion': {
        await handleSetting(() => engine.updateSettings({ regexRegion: msg.region }));
        break;
      }

      case 'releaseModel': {
        try {
          await engine.release();
          post({ type: 'released', requestId: msg.requestId });
        } catch (err) {
          post({ type: 'error', requestId: msg.requestId, error: errorMessage(err) });
        }
        break;
      }
    }
  }

  const unsubscribeMessages = port.onMessage(async (raw) => {
    // R12: the port is same-origin but not trusted with the message shape.
    // Anything that is not a well-formed request gets an error reply and
    // never reaches the engine; nothing here may throw into the transport.
    try {
      if (!isRecord(raw) || typeof raw.type !== 'string') {
        rejectRequest(raw, 'message must be an object with a string type');
        return;
      }
      if (!REQUEST_TYPES.has(raw.type)) {
        post({ type: 'error', requestId: optionalRequestId(raw.requestId), error: `Unknown message type: ${raw.type}` });
        return;
      }
      const problem = requestProblem(raw);
      if (problem) {
        rejectRequest(raw, problem);
        return;
      }
      await dispatch(raw as unknown as EngineRequest);
    } catch (err) {
      // Only reachable if posting a reply itself failed; report best-effort.
      try {
        post({ type: 'error', requestId: isRecord(raw) ? optionalRequestId(raw.requestId) : undefined, error: errorMessage(err) });
      } catch { /* transport gone */ }
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
    // Ignore anything that is not an object with a string type: the host is
    // the only expected sender, but a malformed frame must not throw here.
    if (!isRecord(raw) || typeof raw.type !== 'string') return;
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
        takePending(msg.requestId)?.reject(
          msg.aborted ? new DetectionAbortedError(msg.error) : new Error(msg.error),
        );
        break;
      }
      case 'released': {
        takePending(msg.requestId)?.resolve(undefined);
        break;
      }
      case 'error': {
        const err = new Error(msg.error);
        if (msg.fatal) {
          // The host cannot serve any further request: fail everything
          // that is still waiting instead of leaving promises hanging.
          close(err);
          break;
        }
        takePending(msg.requestId)?.reject(err);
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

  /**
   * Detect over the port. An aborted `signal` sends cancelDetect to the host
   * and the promise rejects with DetectionAbortedError once the host has
   * acknowledged (its detectError { aborted: true }), so a resolved rejection
   * means the worker is idle again; a host that never answers is the
   * caller's watchdog's business (the web app terminates it after a grace
   * period). A signal aborted before the call rejects at once.
   */
  function detect(
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
  ): Promise<DetectedEntity[]> {
    if (signal?.aborted) return Promise.reject(new DetectionAbortedError());
    const promise = request('detect', { type: 'detect', text }, onProgress) as Promise<DetectedEntity[]>;
    if (signal) {
      const requestId = nextRequestId;
      const onAbort = () => {
        if (closed || !pending.has(requestId)) return;
        port.postMessage({ type: 'cancelDetect', requestId } satisfies EngineRequest);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => { /* reported to the caller */ });
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
