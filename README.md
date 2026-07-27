# @doccloak/core

`@doccloak/core` is the UI-free document anonymization engine of the
[DocCloak](https://github.com/WLojek/DocCloak) ecosystem: local PII detection
(ONNX NER models, regex rules), session state and placeholder mapping,
document parsing (docx, legacy doc, OCR for images), and a transport-agnostic
worker protocol. Everything runs on the consumer's machine; no text ever
leaves the host application.

```sh
npm install @doccloak/core
```

The package ships built ESM plus type declarations and exposes three entry
points:

| Entry | Contents |
| --- | --- |
| `@doccloak/core` | Engine, detection pipeline, providers, regex rules, session/replacement state, model loader, `CoreEnv` contract |
| `@doccloak/core/dom` | DOM-dependent helpers: docx read/write, image-to-canvas OCR (works in DOM-less workers via `OffscreenCanvas` where available) |
| `@doccloak/core/worker-protocol` | `serveEngine` / `connectEngine`: run the engine behind any message port |

## Ecosystem split

| Repository | License | Role |
| --- | --- | --- |
| [DocCloak.Core](https://github.com/WLojek/DocCloak.Core) (this package) | Apache-2.0 | The engine, consumed by every shell |
| [DocCloak](https://github.com/WLojek/DocCloak) (web app) | AGPL-3.0 | Open-source web UI built on `@doccloak/core` |
| DocCloak browser extension | proprietary | Closed-source MV3 extension, also built on `@doccloak/core` |

The engine is permissively licensed (Apache-2.0) so both the AGPL web app and
the proprietary extension can depend on it.

## Models download at runtime

The ONNX detection models are **not bundled** in this package. On first use
the engine downloads them from Hugging Face and stores them in the
`CoreEnv.modelCache` you provide (the browser Cache Storage in the reference
hosts):

| Provider | Model | Download |
| --- | --- | --- |
| `gliner` | GLiNER PII Edge (multi-language, custom labels) | ~65 MB |
| `bardsai` | BardS.ai EU PII (24 EU languages, 35 PII types) | ~279 MB |

`pickDefaultProvider(hardware)` chooses `gliner` on mobile or low-memory
devices and `bardsai` otherwise. Download progress is surfaced via
`engine.onDownloadProgress(cb)`.

ONNX Runtime also needs its WASM binaries at runtime; point
`CoreEnv.wasm.paths` at wherever your host serves the `onnxruntime-web`
`*.wasm` assets from.

## API overview

- **Engine** - `createEngine(env, initialSettings?, options?)` returns a
  `DocCloakEngine`: `detect(text, signal?, onProgress?)`, `preload()`,
  `switchProvider(id)`, `getSettings()` / `updateSettings(patch)`,
  `onDownloadProgress` / `onDetectionProgress`, `release()`. Settings persist
  through `env.kv`.
- **Detection pipeline** - `detectEntities`, `detectWithRegex`,
  `resolveOverlaps`, `filterFalsePositives`, `propagateEntities` for hosts
  that compose their own flow; `ALL_REGEX_RULES` and `REGEX_REGIONS` describe
  the built-in regex rule set (universal + per-country rules).
- **Session state** - `AnonymizationSession` maps detected entities to stable
  placeholders (labeled or blanked) and back.
- **Documents** (`/dom`) - `readDocx` / `writeAnonymizedDocx`, legacy `.doc`
  text extraction (`readDocText` on the main entry), OCR helpers
  (`loadImageToCanvas`, `recognizeCanvas`, `renderRedactedImage`) built on
  tesseract.js.
- **Worker protocol** (`/worker-protocol`) - `serveEngine(engine, port)` on
  the side that owns the engine, `connectEngine(port)` on the UI side.
  `PortLike` is satisfied by thin wrappers over `Worker`, `MessagePort` or
  `chrome.runtime.Port`.
- **Model loader** - `fetchModelBlob` / `evictModelFromCache` implement
  cache-first model downloads with progress and retry (`retryAsync`).

## Host integration: CoreEnv

The engine never touches `localStorage`, Cache Storage, `navigator` or
`import.meta` directly. Every host supplies a `CoreEnv` describing how the
engine talks to the outside world:

```ts
interface CoreEnv {
  kv: KVStore;                    // async string KV for settings persistence
  modelCache: BlobCache;          // blob cache for downloaded model files
  fetch: typeof fetch;            // injectable for tests/proxies
  wasm: { paths: string; numThreads?: number };  // onnxruntime-web asset location
  loadTokenizer(hfModelId: string): Promise<unknown>;  // e.g. @huggingface/transformers
  hardware?: HardwareHints;       // deviceMemoryGB / isMobile, feeds provider default
  persistStorage?: () => Promise<boolean>;  // e.g. navigator.storage.persist()
}
```

`memoryKV()` and `memoryBlobCache()` provide in-memory implementations for
tests and short-lived Node processes.

### Web app quickstart

```ts
import { createEngine, type CoreEnv } from '@doccloak/core';
import { AutoTokenizer } from '@huggingface/transformers';

const env: CoreEnv = {
  kv: {
    async get(k) { return localStorage.getItem(k); },
    async set(k, v) { localStorage.setItem(k, v); },
    async remove(k) { localStorage.removeItem(k); },
  },
  modelCache: {
    async match(url) { return (await caches.open('models')).match(url).then((r) => r?.blob()); },
    async put(url, blob) {
      try { await (await caches.open('models')).put(url, new Response(blob)); return true; }
      catch { return false; }  // quota refused: engine falls back to no cache
    },
    async delete(url) { await (await caches.open('models')).delete(url); },
  },
  fetch: (...args) => fetch(...args),
  wasm: { paths: '/', numThreads: 1 },  // serve onnxruntime-web *.wasm under /
  loadTokenizer: (hfModelId) => AutoTokenizer.from_pretrained(hfModelId),
  hardware: { isMobile: /Mobile/i.test(navigator.userAgent) },
};

const engine = createEngine(env);
await engine.ready;
const entities = await engine.detect('John Smith lives in Warsaw.');
```

In practice the web app runs the engine inside a Web Worker and talks to it
through the worker protocol:

```ts
// detection.worker.ts (worker side)
import { createEngine } from '@doccloak/core';
import { serveEngine, type PortLike } from '@doccloak/core/worker-protocol';

const port: PortLike = {
  postMessage: (msg) => self.postMessage(msg),
  onMessage: (cb) => {
    const h = (e: MessageEvent) => void cb(e.data);
    self.addEventListener('message', h);
    return () => self.removeEventListener('message', h);
  },
};
serveEngine(createEngine(env), port);

// main thread (client side)
import { connectEngine } from '@doccloak/core/worker-protocol';
const worker = new Worker(new URL('./detection.worker.ts', import.meta.url), { type: 'module' });
const engine = connectEngine({
  postMessage: (msg) => worker.postMessage(msg),
  onMessage: (cb) => {
    const h = (e: MessageEvent) => void cb(e.data);
    worker.addEventListener('message', h);
    return () => worker.removeEventListener('message', h);
  },
});
```

### Browser extension (MV3) quickstart

An extension host is the same wiring with extension primitives: back `kv`
with `chrome.storage.local`, keep `modelCache` on Cache Storage (available in
extension contexts), serve the onnxruntime-web WASM assets from the extension
bundle (`chrome.runtime.getURL('...')` as `wasm.paths`), and run the engine in
an offscreen document or service worker. Bridge `chrome.runtime.Port` to
`PortLike` for `serveEngine` / `connectEngine`:

```ts
import { serveEngine } from '@doccloak/core/worker-protocol';

chrome.runtime.onConnect.addListener((chromePort) => {
  serveEngine(engine, {
    postMessage: (msg) => chromePort.postMessage(msg),
    onMessage: (cb) => {
      const h = (msg: unknown) => void cb(msg);
      chromePort.onMessage.addListener(h);
      return () => chromePort.onMessage.removeListener(h);
    },
  });
});
```

### Node quickstart

The detection providers run on `onnxruntime-web`'s WASM backend, which works
in Node 20+ (global `fetch` required). The in-memory env helpers make a
minimal setup:

```ts
import { createEngine, memoryKV, memoryBlobCache } from '@doccloak/core';
import { AutoTokenizer } from '@huggingface/transformers';

const engine = createEngine({
  kv: memoryKV(),
  modelCache: memoryBlobCache(),
  fetch: (...args) => fetch(...args),
  wasm: { paths: 'node_modules/onnxruntime-web/dist/', numThreads: 1 },
  loadTokenizer: (hfModelId) => AutoTokenizer.from_pretrained(hfModelId),
});
await engine.ready;
console.log(await engine.detect('Contact jane.doe@example.com or +48 601 123 456.'));
```

Pure functions (regex pipeline, `AnonymizationSession`, docx/doc parsing via
`Blob`/`ArrayBuffer`) have no environment requirements at all. The `/dom`
entry needs DOM APIs (`DOMParser`, canvas); in Node use it under jsdom or
stick to the DOM-free main entry.

## Development

In-repo consumers (the web app, the extension) link this package via
`file:../DocCloak.Core` and compile the TypeScript source directly; the
committed `package.json` points at `src/`. Packing (`npm pack` / `npm
publish`) builds `dist/` and rewrites the entry points to the built output
via the `prepack` script, then `postpack` restores the source paths.

```sh
npm install
npm test           # vitest
npm run typecheck
npm run build      # emits ESM + d.ts into dist/
npm pack           # builds + produces the publishable tarball
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions are
accepted under Apache-2.0 (inbound = outbound); no CLA.
