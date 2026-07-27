# Changelog

All notable changes to `@doccloak/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-07-27

First public release. The engine was extracted from the DocCloak web app
(https://github.com/WLojek/DocCloak) into this standalone Apache-2.0 package.

### Added

- `CoreEnv` environment abstraction (`kv`, `modelCache`, `fetch`, `wasm`,
  `loadTokenizer`, `hardware`, `persistStorage`) so the engine runs in web,
  extension and Node hosts without touching browser globals; in-memory
  `memoryKV()` / `memoryBlobCache()` helpers.
- Detection providers: GLiNER PII Edge (`gliner`, multi-language, custom
  labels) and BardS.ai EU PII (`bardsai`, 24 EU languages, 35 PII types),
  both on ONNX Runtime Web. Models download at runtime and are cached via
  `CoreEnv.modelCache`; they are not bundled.
- Regex rule set: universal rules plus 17 country-specific rule groups,
  selectable via `REGEX_REGIONS`.
- Detection pipeline: `detectEntities`, `detectWithRegex`,
  `resolveOverlaps`, `filterFalsePositives`, `propagateEntities`.
- `AnonymizationSession` placeholder mapping (labeled / blanked modes).
- Document handling: docx read/write and legacy `.doc` text extraction;
  OCR helpers for images (tesseract.js) behind the `./dom` entry.
- Engine assembly: `createEngine()` with settings persistence, provider
  registry, threshold defaults and hardware-based default-model heuristic.
- Transport-agnostic worker protocol (`./worker-protocol`):
  `serveEngine()` / `connectEngine()` over any `PortLike` port.
- Build pipeline: ESM + type declarations in `dist/` for the `.`, `./dom`
  and `./worker-protocol` entry points; tarball verified with publint and
  arethetypeswrong.
