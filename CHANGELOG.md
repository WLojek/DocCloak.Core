# Changelog

All notable changes to `@doccloak/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [0.9.0] - 2026-08-21

### Added

- **Secrets & credentials detection (T099/T116):** new `SECRET` and
  `API_KEY` entity types plus eleven universal regex rules covering AWS
  access keys, GitHub/Slack tokens, OpenAI/Anthropic/Google API keys,
  PEM private-key blocks, JWTs, connection strings with embedded
  credentials, `secret=`-style assignments and high-entropy tokens, and
  a GB driving-licence rule. Credentials never receive realistic
  stand-ins — even in surrogate mode they always fall back to typed
  placeholders, since a same-shape fake key still reads as a live
  credential.

- **Tolerant restore-token matching (T098):** new side-effect-free
  `@doccloak/core/restore-tokens` export that restores placeholders LLM
  replies have mangled — case changes (`[person_1]`), separator swaps
  (`[PERSON 1]`), markdown wrapping (`**[PERSON_1]**`), dropped brackets
  and stray edge punctuation. Restoration only happens on an unambiguous
  canonical hit; anything ambiguous is left exactly as the model wrote
  it, because a wrong restore silently corrupts the document while a
  missed one is visible and recoverable.

- **Model integrity verification:** `fetchModelBlob` verifies downloads
  against a pinned SHA-256 when the caller provides one and rejects
  mismatches with a dedicated `ModelIntegrityError` (the corrupt copy is
  discarded; verified cache entries carry a marker so they are not
  re-hashed). The GLiNER and bardsai providers export their pinned
  `*_MODEL_URL` / `*_MODEL_REVISION` / `*_MODEL_SHA256` constants.

- **Multilingual surrogates (T073):** realistic stand-ins now follow the
  original's language beyond EN/PL. New locale packs matching every
  region the web app's language picker offers: German, French, Spanish,
  Italian, Czech, Ukrainian, Dutch, Portuguese, Swedish, Norwegian,
  Danish, Finnish, Japanese and Chinese: given-name/surname pools with
  gender detection and surname feminization (-ova, -ska/-cka), month
  names for date shifting (genitive forms where dates inflect), street
  formats (Hauptstrasse 5 / 12 rue des Lilas / Calle del Sol 3 / Via dei
  Tigli 10 / vul. Zelena 98) and company pools with locale-detecting
  legal suffixes (GmbH, SARL, S.r.l., s.r.o., TOV) kept verbatim.
  Locale detection scores name-pool and surname matches per token
  (shared names like "Marie" resolve to the best-matching language);
  Cyrillic script resolves decisively. Non-Latin surrogate names fall
  back to an unrelated ASCII identity in derived email local parts.
  CJK names compose surname-first without spaces via a per-pack
  formatPerson hook (Chinese given-name length mirrored; kana decides
  Japanese, surname-prefix scoring separates kanji-only Japanese from
  Chinese, a Han script fallback catches unpooled surnames); CJK dates
  (2024\u5e743\u670815\u65e5) shift in place; Finnish dates keep the partitive.
  Bare legal suffixes (AB/AS) now require a preceding space, so 'SAAB'
  never sheds an 'AB'. Adding further locales is data-only (one
  LocalePack entry).

- **Person-variant unification (T057):** repeated mentions of the same
  person share one replacement. When a new PERSON value is a name-variant
  of an already-mapped one (case-insensitive token subset with at least
  one substantive shared token: "John" and "Smith" both match
  "John Smith"; "Mr. Smith" and "Person 11" do not), the session reuses
  its placeholder/surrogate instead of issuing a new one. The reverse map
  keeps the LONGEST variant, so restore always yields the fullest known
  form; `renameLabel` renames the whole variant group; `deserialize`
  keeps the longest variant canonical regardless of entry order.

- **Surrogate replacement mode (T043):** `AnonymizationSession` accepts a
  new `'surrogate'` mode in which replacements are realistic,
  shape-preserving stand-ins instead of typed placeholders: locale-aware
  fake names (EN + PL, gendered Polish surname endings), emails whose
  local part mirrors the in-session person surrogate on reserved example
  domains, dates shifted by a per-session day offset while keeping their
  format, phones/IBANs/IDs/cards that keep their shape (IBAN mod-97,
  PESEL and Luhn checksums valid; generated PESELs encode a 19th-century
  birth date and SSN shapes use the never-allocated 900-999 area, so a
  generated identifier can never be a real living person's). Generation
  is deterministic per session (seeded by a per-session salt, new
  `src/surrogates.ts` module) and collision-safe against every original
  value and every already-issued replacement in the session. The default
  mode remains `'labeled'` (typed placeholders); restore is unchanged
  exact-literal lookup. Surrogate-mode `serialize()` wraps the entry
  array in `{ mode, salt, entries }` so `deserialize()` reproduces the
  mode and salt; placeholder/blanked sessions keep the plain-array
  Python-parity schema byte-identically.

### Changed

- **Breaking (user-visible output):** `AnonymizationSession` now generates
  typed placeholders with per-type counters, e.g. `[PERSON_1]`, `[EMAIL_1]`,
  `[DATE_2]`, instead of the global `<<REDACTED_N>>`. Typed placeholders
  keep LLM answers coherent (pronouns, date reasoning, formatting), make
  protected text human-readable, and avoid the `<<...>>` token that
  Markdown-rendering chats can mangle. Placeholder type names are the
  stable uppercase `EntityType` ids, so every generated token matches
  `\[[A-Z_]+_\d+\]`.
- Blanked-mode replacements no longer consume counter numbers, so labeled
  placeholders number contiguously per type.
- `AnonymizationSession.deserialize` rebuilds the per-type counters from
  `[TYPE_N]` placeholders in the map, and `anonymize` skips any number
  already present in the reverse map (renamed labels included), so freshly
  issued placeholders never collide with restored or renamed ones.

### Backward compatibility

- Restoring is unchanged: `deanonymize` performs exact-literal replacement
  of whatever placeholder strings the map contains. Maps serialized before
  0.9.0 (or by the Python CLI's `save_map`) with `<<REDACTED_N>>` tokens
  still deserialize and restore old-format text byte-identically.
- The serialization schema (`original` / `replacement` / `entity_type`,
  Python `save_map` parity) is unchanged.

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
