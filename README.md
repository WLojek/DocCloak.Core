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

| Provider id | Model | Download |
| --- | --- | --- |
| `gliner` | GLiNER PII Small (multi-language, custom labels) | ~83 MB |
| `gliner-base` | GLiNER PII Base (often better for English and dates, custom labels) | ~197 MB |
| `bardsai` | BardS.ai EU PII (24+ EU languages, 35 PII types; labeled "Legacy" in the web app) | ~279 MB |

`pickDefaultProvider(hardware)` chooses `gliner` on mobile devices or when
`deviceMemoryGB` is 4 or less, and `bardsai` otherwise. Download progress is
surfaced via `engine.onDownloadProgress(cb)`. Every model and both of its
tokenizer files are fetched from an immutable `resolve/<commit>` URL and
verified against a pinned SHA-256 and byte size; the pins are listed in
[documentation/model-provenance.md](../documentation/model-provenance.md)
of the DocCloak workspace.

ONNX Runtime also needs its WASM binaries at runtime; point
`CoreEnv.wasm.paths` at wherever your host serves the `onnxruntime-web`
`*.wasm` assets from.

## API overview

- **Engine** - `createEngine(env, initialSettings?, options?)` returns a
  `DocCloakEngine`: `detect(text, signal?, onProgress?)`, `preload()`,
  `switchProvider(id)`, `getSettings()` / `updateSettings(patch)`,
  `onDownloadProgress` / `onDetectionProgress`, `release()`. Settings persist
  through `env.kv`. `options.autoLoad` (default `true`) lets `detect()`
  download and initialise the model on its own; with `autoLoad: false` the
  engine never downloads implicitly: `detect()` before a completed
  `preload()` (or `switchProvider()`) rejects with `ModelNotLoadedError`
  (a preload still in flight is awaited). Use `false` when model downloads
  are gated behind user consent and call `preload()` from the consent flow.
- **Detection pipeline** - `detectEntities`, `detectWithRegex`,
  `resolveOverlaps`, `filterFalsePositives`, `propagateEntities` for hosts
  that compose their own flow; `ALL_REGEX_RULES` and `REGEX_REGIONS` describe
  the built-in regex rule set (universal + per-country rules).
- **Session state** - `AnonymizationSession` maps detected entities to stable
  placeholders (labeled, blanked or surrogate) and back. In surrogate mode
  `registerDocumentValues(valuesOrEntities)` tells the session which values
  occur in the document so no surrogate ever equals a real value from it
  (`anonymizeText` does this automatically); `getAmbiguousValues()` lists the
  values whose person-variant match was a tie and therefore got a new
  placeholder instead of being merged with an existing person.
- **Documents** (`/dom`) - `readDocx` / `writeAnonymizedDocx` /
  `writeAnonymizedDocxWithReport`, `readXlsx` / `writeAnonymizedXlsx`,
  `analyzeOfficeFile` / `redactOfficeFile`, legacy `.doc` support on the main
  entry (`readDocText`, `writeAnonymizedDoc`, `inspectDoc`), OCR helpers
  (`loadImageToCanvas`, `recognizeCanvas`, `renderRedactedImage`) built on
  tesseract.js. See "Document API: refusals, warnings and consent" below for
  the error and result shapes.
- **Worker protocol** (`/worker-protocol`) - `serveEngine(engine, port)` on
  the side that owns the engine, `connectEngine(port)` on the UI side.
  `PortLike` is satisfied by thin wrappers over `Worker`, `MessagePort` or
  `chrome.runtime.Port`.
- **Model loader** - `fetchModelBlob` / `evictModelFromCache` implement
  cache-first model downloads with progress, resume, retry and SHA-256
  verification (`ModelIntegrityError` on a mismatch; the entry is evicted).
  Verified cache entries carry a marker `${sha256}:${size}` bound to the blob
  size, so a cache hit whose size changed is re-hashed instead of trusted.
  Each provider also pins its two tokenizer files (`GLINER_TOKENIZER_FILES`,
  `GLINER_BASE_TOKENIZER_FILES`, `BARDSAI_TOKENIZER_FILES`: immutable
  `resolve/<commit>` URL, sha256, size); `loadPinnedTokenizer` fetches them
  through the same path and hands the parsed JSON to `env.buildTokenizer`.

### Document API: refusals, warnings and consent

The readers and writers fail closed: a file the engine cannot redact
completely is refused with a typed error, or reported so the host can ask the
user, never exported under a false "redacted" label.

**`UnsupportedDocumentError`** (main entry and `/dom`) carries a stable
`code` and a `details: string[]` list for diagnostics. Map `code` to your own
localized message with a one-line remedy:

| `code` | Thrown by | Meaning | Remedy to show |
| --- | --- | --- | --- |
| `'unrecognized-namespace'` | `readDocx`, `readXlsx` | The main part uses an XML namespace the reader does not know (neither the transitional nor the strict OOXML set), so text could be missed | Open in Word/Excel and save again as .docx/.xlsx |
| `'invalid-package'` | `readDocx`, `readXlsx` | The zip or a required XML part cannot be parsed | Same |
| `'too-large'` | `readDocx`, `readXlsx` | The unpacked size of the package exceeds 200 MB (zip-bomb and memory guard) | Split the document |
| `'unredactable-parts'` | `writeAnonymizedDocx*`, `writeAnonymizedXlsx*`, `redactOfficeFile` | The package contains parts whose content cannot be redacted and the host did not pass `allowUnredactable: true` | Ask the user (see below) |
| `'fast-saved'` | `readDocText`, `writeAnonymizedDoc` | Legacy .doc saved incrementally: deleted text lives outside the piece table where no detector sees it | Open in Word, Save As (or save as .docx) |
| `'encrypted'` | `readDocText`, `writeAnonymizedDoc` | Legacy .doc is encrypted or XOR-obfuscated | Remove the password |

**Extraction results.** `readDocx` and `readXlsx` return, next to
`plainText` and the offset mappings:

- `unredactable: UnredactablePart[]` - parts the writer cannot redact, each
  with `part` (zip path), `kind` (`'embedded-object' | 'macros' |
  'html-chunk' | 'external-data' | 'printer-settings' | 'unknown'`) and a
  human `label` ("embedded Excel sheet"). The reader never throws for these;
  the writer refuses with `'unredactable-parts'` unless the host passes
  `{ allowUnredactable: true }`, in which case those parts are copied
  verbatim and one warning per part is returned. Only pass it after the user
  has been told which parts stay unchanged (informed consent); a host that
  does not ask keeps the fail-closed default. Layer zero still scrubs every
  known value from the XML parts of the package either way.
- `warnings: string[]` - parts that could not be parsed and were therefore
  skipped by the layer-zero scrub, and similar non-fatal findings (a sheet
  name containing an entity, for example). Show them to the user.
- `empty: boolean` - the document contains no text units at all; show
  "nothing to redact" instead of exporting.

**Write results.** `writeAnonymizedDocxWithReport` /
`writeAnonymizedXlsxWithReport` return `{ blob, warnings }`; the plain
`writeAnonymizedDocx` / `writeAnonymizedXlsx` return the `Blob` only.

**One-call path.** `analyzeOfficeFile(file, detect)` reads the package,
runs your detector and exposes `unredactable[]` and `warnings[]` next to the
entities. `redactOfficeFile(file, analysis, session, options)` applies the
session's replacements and writes the file:

- `options.onMismatch` (`'throw' | 'drop'`, default `'throw'`) decides what
  happens when an entity of the analysis no longer matches the text at its
  offsets (the document was re-read or edited in between): `'throw'` rejects
  with `StaleAnalysisError`, which lists the stale entities, so a stale
  analysis never yields a leaking "success"; `'drop'` skips those entities
  and reports them in `result.warnings`. `isStaleAnalysisError(err)` works
  across realms.
- `options.allowUnredactable` (default `false`) is required to export a file
  with embedded objects, macros, HTML chunks, external data or printer
  settings; `result.warnings` then names each part copied verbatim.

All of these are exported from `@doccloak/core/dom`.

**Legacy .doc.** `inspectDoc(buffer)` returns `{ encrypted, fastSaved,
streams: { data, objectPool, macros } }` without throwing, so a host can show
the same consent card for a .doc whose `ObjectPool` (embedded objects) or
`Macros` (VBA) storage will be copied unchanged.

## What is removed or normalised in Office packages

Independently of what was detected, every exported .docx / .xlsx has:

- **Removed:** `cp:revision`, `cp:version`; every `w:rsid*` attribute in the
  content parts and `w:rsids` in `word/settings.xml`; the thumbnail
  (`docProps/thumbnail.*` with its relationship and content-type override);
  the attached template, mail-merge settings and document variables
  (`w:docVars`) in `word/settings.xml`; hyperlink tooltips; content-control
  tags without a data binding; `c:externalData` links in charts (the chart
  keeps its cached data).
- **Blanked:** `creator`, `lastModifiedBy`, `title`, `subject`,
  `description`, `keywords`, `category`, `contentStatus`, `identifier`
  (`docProps/core.xml`); `Company`, `Manager`, `HyperlinkBase`, `Template`
  and every heading / sheet / defined-name title in `TitlesOfParts` and
  `HeadingPairs` (`docProps/app.xml`); custom property values (names kept,
  `docProps/custom.xml`); the comment-author registry (`word/people.xml`)
  and `w:author` / `w:initials` on comments and tracked changes.
- **Normalised:** `dcterms:created`, `dcterms:modified` and `cp:lastPrinted`
  to `2000-01-01T00:00:00Z`; `w:date` on comments, insertions, deletions and
  property-change records to `2000-01-01T00:00:00Z` (the only visible
  effect: comment and revision dates in the downloaded file); page, word,
  character, line and paragraph counts and `TotalTime` to 0; every ZIP entry
  dated `1980-01-01` with entry and archive comments removed, so the output
  no longer reveals which parts were touched; `mailto:` relationship targets
  replaced by `mailto:redacted@example.invalid`.
- **Layer zero:** every value of the session (with its variants and name
  tokens of 4+ characters) is scrubbed from the text nodes and attribute
  values of every XML, `.rels` and `.vml` part of the package (charts,
  diagrams, customXml, glossary, docProps, pivot caches), never touching
  element names, `[Content_Types].xml`, relationship `Type`s, ids or numeric
  layout attributes.

## Known limits

**Office packages (.docx, .xlsx)**

- Images inside documents (`media/*`) are copied unchanged; text in pictures
  is not OCR-scanned. Hosts can run the OCR helpers on extracted images.
- Embedded objects (`embeddings/*`), VBA projects, `altChunk` HTML fragments,
  external data connections, external links and printer settings cannot be
  redacted. They are reported in `extraction.unredactable` and exported
  verbatim only with `allowUnredactable: true` (see above). Removing them is
  planned for 0.13.0 (T199), gated on the real-file corpus (T196).
- Spreadsheets: sheet names with an entity are reported in `warnings`, not
  renamed; numeric and date cells, formula literals, defined names and data
  validation texts are not extracted yet (T176).
- A bookmark rename keeps the identifier valid (`PERSON_1`, never
  `[PERSON_1]`); field instructions are replaced only inside their quoted
  arguments and bookmark tokens.

**Legacy .doc**

`writeAnonymizedDoc(buffer, replacements, valueReplacements?)` rewrites the
piece table for main-text replacements, overwrites subdocument ranges in
place, space-fills the OLE property sets and the Table string tables
(`SttbfAssoc`, `SttbfRMark`, `GrpXstAtnOwners`, `SttbfBkmk`, `SttbSavedBy`,
`AutosaveSource`) and then destroys every remaining byte occurrence of each
original value (the value, its whitespace tokens of 4+ characters, any case)
without moving a single structure: `WordDocument` and `Data` are scanned as
UTF-16LE, `Table` as UTF-16LE and cp1252. What it does not do:

- **Fast-saved files are refused** (`code: 'fast-saved'`; `fComplex`, or
  `cQuickSaves > 0` on Word 97 files). Deleted text of an incremental save
  lives outside the piece table, so detection never sees it. Ask the user to
  open the file in Word and Save As (or save as .docx).
- **Encrypted or XOR-obfuscated files are refused** (`code: 'encrypted'`).
- **cp1252 remnants in `Data` and `WordDocument` are not searched.** Hyperlink
  field data and OLE previews store text as UTF-16; a cp1252 search would hit
  bytes inside embedded pictures and corrupt them.
- **`ObjectPool/*` (embedded OLE objects), `Macros/*` (VBA) and `\x01CompObj`
  are copied through unchanged.** Call `inspectDoc(buffer)` and warn when
  `streams.objectPool` or `streams.macros` is `true`.
- A token that also occurs inside a replacement (for example `Person` in
  `[PERSON_1]`) is not scrubbed on its own so placeholders survive; the full
  original value always is.

**Detection and restore**

- No model catches every name; hosts should keep a review step and let users
  add manual entities or dictionary terms.
- Regex rules run per line since 0.12.0 (except rules flagged `multiline`),
  so a pattern split across a line break (postal code on one line, city on
  the next) is not matched as one entity.
- Surrogate mode preserves structure by design: name token count, gender and
  locale; the phone country prefix; the date format and a constant per-session
  day shift (so one known date reveals the shift for all dates); the IBAN
  country and letter positions; the email shape. Surrogate restore matches
  by value and is best-effort; placeholder mode is exact.

## Host integration: CoreEnv

The engine never touches `localStorage`, Cache Storage, `navigator` or
`import.meta` directly. Every host supplies a `CoreEnv` describing how the
engine talks to the outside world:

```ts
interface CoreEnv {
  kv: KVStore;                    // async string KV for settings persistence
  modelCache: BlobCache;          // blob cache for downloaded model + tokenizer files
  fetch: typeof fetch;            // injectable for tests/proxies
  wasm: { paths: string; numThreads?: number };  // onnxruntime-web asset location
  buildTokenizer?(tokenizerJson: unknown, tokenizerConfig: unknown): unknown | Promise<unknown>;
  /** @deprecated since 0.12.0, removed in 0.13.0; used only when buildTokenizer is absent */
  loadTokenizer?(hfModelId: string): Promise<unknown>;
  hardware?: HardwareHints;       // deviceMemoryGB / isMobile, feeds provider default
  persistStorage?: () => Promise<boolean>;  // e.g. navigator.storage.persist()
}
```

`memoryKV()` and `memoryBlobCache()` provide in-memory implementations for
tests and short-lived Node processes.

### buildTokenizer

Core downloads the tokenizer files itself. Every provider pins
`tokenizer.json` and `tokenizer_config.json` at the same immutable commit as
its ONNX model, with a SHA-256 and byte size, and fetches them through
`fetchModelBlob` (resume, retry, `modelCache`, verification marker,
`ModelIntegrityError`). The host only turns the two verified, parsed objects
into a tokenizer instance:

```ts
import { PreTrainedTokenizer } from '@huggingface/transformers';

buildTokenizer: (tokenizerJson, tokenizerConfig) =>
  new PreTrainedTokenizer(tokenizerJson as never, tokenizerConfig as never),
```

Pick the class from `tokenizerConfig.tokenizer_class` if your library needs
a specific subclass (`PreTrainedTokenizerFast` for GLiNER PII Small,
`DebertaV2Tokenizer` for GLiNER PII Base, `XLMRobertaTokenizer` for BardS.ai);
`PreTrainedTokenizer` handles all three in `@huggingface/transformers`.
With `buildTokenizer` the host never contacts the network for tokenizers, a
warm `modelCache` works offline, and the only URLs fetched on a cold start
are the three pinned `resolve/<commit>/...` files of the active provider.

`loadTokenizer(hfModelId)` (0.11 and earlier) is still honoured when
`buildTokenizer` is absent, with a one-time deprecation warning. It lets the
host library probe the mutable `resolve/main` branch and keep an unverified
second cache, so migrate before 0.13.0, where `buildTokenizer` becomes
required and `loadTokenizer` is removed.

### autoLoad and ModelNotLoadedError

```ts
import { createEngine, ModelNotLoadedError } from '@doccloak/core';

const engine = createEngine(env, undefined, { autoLoad: false });
try {
  await engine.detect(text);
} catch (err) {
  if (err instanceof ModelNotLoadedError) {
    // ask the user for consent, then:
    await engine.preload();
  }
}
```

With `autoLoad: false` no code path of the engine downloads a model unless
the host calls `preload()` or `switchProvider()`; `ModelNotLoadedError`
carries the `providerId` that needs loading. The default (`autoLoad: true`)
keeps the 0.11 behaviour where `detect()` loads on demand.

### Web app quickstart

```ts
import { createEngine, type CoreEnv } from '@doccloak/core';
import { PreTrainedTokenizer } from '@huggingface/transformers';

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
  buildTokenizer: (json, config) => new PreTrainedTokenizer(json as never, config as never),
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
import { PreTrainedTokenizer } from '@huggingface/transformers';

const engine = createEngine({
  kv: memoryKV(),
  modelCache: memoryBlobCache(),
  fetch: (...args) => fetch(...args),
  wasm: { paths: 'node_modules/onnxruntime-web/dist/', numThreads: 1 },
  buildTokenizer: (json, config) => new PreTrainedTokenizer(json as never, config as never),
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
