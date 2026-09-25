# Changelog

All notable changes to `@doccloak/core` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project follows [Semantic Versioning](https://semver.org/).

## [0.13.0] - 2026-09-25

PDF-to-PDF redaction that keeps the text layer (new `@doccloak/core/pdf`
entry point, see "Added" below), cancelable detection, and detection fixes
found while testing real PDFs: Polish landline phones, catch-all numbers
that swallowed a PESEL and a phone, regex spans without surrounding
whitespace, placeholder fitting, OCR tokens split by a lost character,
kerned punctuation after a redacted value, and overlapping detections that
dropped part of a value.
Host-facing additions are optional (`signal` on detect, `cancelDetect` in
the worker protocol, the PDF entry point); nothing a 0.12.x host uses was
removed. The new PDF dependencies are pinned exactly like the others:
`@cantoo/pdf-lib` 2.11.1, `@cantoo/fontkit` 2.0.12, `pdfjs-dist` 6.3.289.

### Found by the first CI corpus run on real LibreOffice PDFs (T233)

- **PDF writer: kerned punctuation after a redacted value.** LibreOffice
  writes `[(... Müller) 40 (, wohnhaft)] TJ`: the comma is pulled 0.48 pt
  into the value's span. When a narrower placeholder closed the slack, the
  rest of the line moved left but the comma, starting just before the end
  of the removed span, counted as "left of the gap" and kept its old x,
  landing inside "wohnhaft" ("wohn,haft", "[PHO,NE_1]"). A kept glyph now
  moves with the text after a gap when it starts past the gap's middle; a
  TJ that really jumps back still draws its text before the gap.
- **Overlap resolution keeps what a losing entity covers past the winner.**
  `resolveOverlaps` dropped the loser whole. In a PDF exported from a
  spreadsheet a clipped cell is glued to the next one ("31-147
  Krakók.wisniewska@firma.pl"): the model took "31-147 Krakók", the e-mail
  rule the whole token, and ".wisniewska@firma.pl" stayed in clear. Now the
  rest of a regex match is re-run through its rule and kept where it still
  matches (the e-mail does; "before 2025" left over from a bogus
  "00 before 2025" date does not), and the rest of a model span is kept
  without its edge punctuation. Detection never covers less than before.
- Tests: the corpus matches needles in PDFs across the line breaks a PDF
  export puts inside a value (a space turned newline, a long e-mail broken
  in a narrow cell, "Pawlak-" / "Dudek"), so wrapped values are replaced
  and asserted absent instead of being counted as present and left alone;
  values that LibreOffice Calc clips at a cell border are listed under
  `optionalFor.pdf` in two seeds.

### OCR image redaction covers both halves of a token OCR split (T232)

- Tesseract can drop a character inside a token and return two words: in
  the kit's scanned letter "t.zielinski@zielinski-kancelaria.pl" came back
  as "t" + "zielinski@zielinski-kancelaria.pl." with the dot's pixels in the
  second box. The e-mail rule matched the second word only and boxes are
  drawn per OCR word, so the "t" stayed visible (with "jan.kowalski@..." it
  would be a first name). `selectRedactionBoxes` now spreads a selection to
  same-line neighbours that `findSplitTokens` (exported) marks as one token:
  the gap between their boxes is at most 0.3 of the line's median word gap
  (height-based fallback on short lines; touching boxes included), and
  boxes taller than 1.6x the line's median height (OCR noise such as a
  26 px "w" on an 11 px line) never join. On seven OCR runs (the scan plus
  kit pages 01/02 at 1000/1700/2500 px, about 1 150 words) exactly one pair
  joins: the split e-mail. An ink test for a lost glyph left in a
  normal-width gap was tried and dropped: Tesseract often cuts a letter's
  edge out of its own box, which reads the same ("w terminie", "nr wpisu").
  `renderRedactedImage`'s signature is unchanged.

### A catch-all regex span yields to the specific detections it overlaps (T230)

- `universal:long_number` (confidence 0.5) admits whitespace, so a PESEL cell
  followed by a phone cell without "+48" ("90050598761 512 987 654") was one
  23-character span that overlap resolution preferred (same start, longer)
  over PESEL 0.9 + PHONE 0.8: the row came out as a single [SSN] and the
  phone was "not detected". `detectEntities` now runs `splitCatchAlls`
  first: a regex entity at or below confidence 0.5 that overlaps specific
  detections (confidence >= 0.8, ML or regex) is replaced by its leftovers,
  which are re-run through the same rule (an unknown long number next to a
  phone is still caught); the specific spans then win. Catch-alls nothing
  specific overlaps are untouched, and so is every other overlap (the
  leak-averse "earlier start, longer span" order is unchanged).
  Tests: tests/regex/catch-all-split.test.ts. No corpus expectation changed.

### Polish landlines without +48; stricter postal-code-plus-city (T227)

- `regex:pl:phone` only knew the 3-3-3 mobile grouping, so Polish landlines
  written without the country code ("22 555 01 02", "(22) 555-01-02",
  "71 777 88 99") fell through to `universal:long_number` and came out as
  [SSN_n] under region pl. The rule now also accepts the 2-3-2-2 landline
  grouping with an optional bracketed area code, with or without +48, and
  the "+" of a "+48" prefix is part of the match (the mobile branch used to
  start at "48"). A PESEL, a NIP, a bank account and a date still do not
  match; an 11-digit number starting with 48 is no longer taken for a phone.
- `regex:universal:postal_city` matched "05/2026 Maria" (date-like prefix)
  and "111 222 przegląd" (lowercase word) and stole the start of a phone or
  a person name. The code must now stand at the start of the line or after
  whitespace (so nothing glued to a digit, "/", "." or "-" matches), a
  4-2 / 4-4 hyphenated shape ("2025-03", "2024-2025") is skipped and the
  city must start with an uppercase letter. "00-950 Warszawa", "75008 Paris"
  and "1010 Wien" still match; a code glued to an opening bracket
  ("(75008 Paris)") no longer does through this rule (country packs still
  cover it). The rule stays lookbehind-free (pattern dialect lint) by
  consuming the leading whitespace, which `runRule` trims (T226).
- Web regression corpus `universal.json` case `u-03-generic-identifiers`:
  "987654321 remains" was a baked-in postal_city false positive; the number
  is now PHONE "987654321" via `regex:pl:phone` (0.8 beats
  `universal:long_number` 0.5 and the other 9-digit rules on the same span).

### Regex matches never carry whitespace (T226)

- The IBAN rule ended its match on a word boundary after a class that admits
  whitespace, so "PL61 1090 1014 0000 0712 1981 2874 w terminie" matched
  with the trailing space and the redaction produced "[IBAN_1]w terminie"
  (text, DOCX and PDF alike). The pattern now ends on a letter or digit, and
  `runRule` trims whitespace at both ends of every regex match as a general
  safety net (start/end adjusted; a validator sees the trimmed value).

### Placeholder fit: move before shrink (T225)

- The planner now moves the rest of the line before it shrinks a placeholder:
  room up to the next column and up to the page's text edge is used at full
  size first; only the remainder is shrunk (floor raised from 65 % to 75 %)
  and condensed (80 %). Short words on left-aligned lines ("NIP", "Kraków")
  no longer get half-size placeholders; lines that already reach the margin
  behave as before. `fit.minSizeRatio` default is 0.75. The page's text edge
  is a hard limit (content boxes are clipped by Chrome and Word), and of a
  value wrapped over several lines the widest part now carries the
  placeholder (before: always the first part).

### Cancelable detection (T222)

- `DetectionProvider.detect(text, onProgress?, signal?)`: the three built-in
  providers check the signal between inference chunks and reject with the new
  `DetectionAbortedError` (also thrown by `engine.detect` for a signal aborted
  before or after the ML pass; it used to be a plain `Error('Detection aborted')`).
- Worker protocol: new `cancelDetect { requestId }` request; the cancelled
  call answers `detectError { aborted: true }`. `connectEngine().detect` with
  an aborted signal now sends `cancelDetect` and rejects with
  `DetectionAbortedError` once the host has acknowledged, so a rejection
  means the worker is idle again (before, it rejected at once and the host
  kept computing).

PDF-to-PDF redaction that keeps the text layer (T206-T218, founder decision
2026-09-24 reversing the 2026-08-30 desktop-only split).

### Added

- New entry point **`@doccloak/core/pdf`**: `readPdf(file, { assets })` and
  `writeAnonymizedPdfWithReport(extraction, replacements, values, options)`.
  The redacted glyphs are cut out of the content streams, the placeholder is
  written back as real text in the document's own font when that font can
  show it (codes proven present in the subset), else in a metrics-compatible
  Liberation face (SIL OFL, shipped under `fonts/liberation`) embedded as a
  subset. Placeholders are fitted to the redacted span: same size when it
  fits, then shrunk to 65 %, then condensed to 80 % width, then the rest of
  the line moves right by the overflow; a narrow placeholder closes the slack
  so no hole is left. Every later show in the positioning scope is
  re-anchored absolutely, so residual glyph positions cannot encode the
  removed text (USENIX 2022 "Story Beyond the Eye").
- Fonts: simple Type1/TrueType/Type3 (Standard/WinAnsi/MacRoman/Differences,
  ToUnicode), composite Type0 with Identity-H/V or embedded CMaps (Chrome,
  Word, macOS output), standard-14 metrics for non-embedded fonts.
- Two independent extractors: our decoder and pdf.js. A page whose text
  differs between them, or whose fonts cannot be read safely, is rasterized
  (pixels blacked out) when it carries a redaction, and listed in
  `rasterizedPages`. Text of such pages comes from pdf.js so detection still
  sees it.
- Output is rebuilt as a fresh single-revision document: Info, XMP,
  outlines, forms, annotations, attachments, JavaScript, named destinations,
  structure tree, page labels and the incremental-update history of the
  input never reach the output (reported in `removed`); ToUnicode maps of
  edited fonts are trimmed to the codes still used; ActualText/Alt marked
  content is stripped; dates normalised to 2000-01-01, producer `DocCloak`.
- Verification after every write: re-extraction with both extractors plus a
  byte scan of every decoded stream and string (UTF-8, Latin-1, UTF-16 BE/LE)
  and of the removed code sequences; any trace throws `PdfVerifyError` and
  nothing is exported.
- `office.ts`: `officeFileKind` returns `'pdf'`; `analyzeOfficeFile` and
  `redactOfficeFile` handle PDFs through a lazy import of the PDF module
  (`options.pdf` carries assets, password, fit policy); results gain
  `removed` and `rasterizedPages`.
- `UnredactablePart.kind` gains `'scanned-page'` and `'undecodable-text'`.
- Dependencies: `@cantoo/pdf-lib`, `@cantoo/fontkit`, `pdfjs-dist`. Hosts
  serve the pdf.js worker, its CMaps and standard fonts, and the Liberation
  TTFs same-origin (see README, "PDF").

### Second review (T219, same release)

- Layer zero searches the flat text in the verifier's normal form (whitespace,
  soft hyphens and zero-width characters dropped, ligatures spelled out, case
  folded), so a value wrapped over a line end ("Jan" / "Kowalski" on the next
  line), spaced differently by the layout or set with a ligature is redacted
  instead of blocking the export with `PdfVerifyError`. Segments of a value
  on other lines close up over the removed glyphs.
- A fallback font needed inside a form XObject that has no `/Resources` of
  its own goes into the page resources (where viewers resolve it); duplicated
  forms with identical bytes all receive it.
- Lexer: inline image data ends the way pdf.js finds it (`EI` need not follow
  whitespace, must be followed by ASCII; DCT data ends at its EOI marker,
  ASCIIHex at `>`, ASCII85 at `~>`; `/L` honoured); an image without an end
  makes the rest of the stream unsafe instead of a silent opaque operator;
  arrays/dicts nested deeper than 64 are unsafe instead of a stack overflow;
  `--5` reads as -5 (pdf.js, Acrobat); raw CR inside literal strings is kept.
- CMap parser tolerates what pdf.js tolerates: a missing `endcmap`, a bfrange
  destination array shorter than the range, bounds of different byte lengths.
  Rewritten ToUnicode maps keep the source codespace and skip empty
  destinations. Glyph list gains the AGL combining-mark names.
- `readPdf` enforces the byte cap before pdf.js parses the file. Files that
  carry only an owner password (print/copy restrictions) open without one.
- Fonts: a placeholder reuses a simple font only through its encoding (glyph
  names), never through ToUnicode, and only for codes whose ToUnicode entry
  agrees with the glyph, so the page shows what the text layer says; composite
  placeholders take the code byte length from the encoding CMap (Identity-H:
  2), not from the ToUnicode codespace; the lowest code wins ties in the
  reverse map (space is 32, not 160); an empty ToUnicode destination falls
  back to the encoding; TrueType fonts without `/Encoding` default the way
  pdf.js does (Standard when Nonsymbolic, WinAnsi without the flag, MacRoman
  for symbolic non-embedded); a symbolic embedded font our decoder cannot
  read is rasterized on edit (pdf.js reads it), no longer refused; direct
  font dictionaries no longer share a cache entry; right-to-left pages are
  compared with pdf.js as a bag of characters (pdf.js hands them back in
  visual order).
- Style matching: weight and slant words count only as whole words
  ("Kobold", "Digital", "Hospital" are not bold/italic), `/StemV` is no
  longer read as a weight (Chrome writes 130+ for regular Georgia), Computer
  Modern / Nimbus / Cascadia names map to their families.
- Verifier: the removed-code-sequence pass only checks the complete code
  sequence of a whole value (a fragment of a value split over two shows
  legitimately occurs elsewhere) and deduplicates sequences; layer zero and
  the placement planner are linear in the number of replacements (a 200-page
  file with 32 000 replacements writes in under 2 s instead of 90 s).
- Layout: text pushed right by an overflowing placeholder stops before the
  next column (the placeholder gives up its size floors rather than overlap);
  a continuation line that starts with the tail of a wrapped value closes up
  as a whole, justified word gaps included.
- `fitPlaceholder` rejects non-finite input and clamps a policy that would
  enlarge the placeholder.

### Third review (T220, same release)

- Text that lives in tiling pattern cells and ExtGState soft-mask groups is
  walked like form XObjects: it reaches detection, is edited in place, and
  never shares a line with page text (it was invisible to both extractors).
- Glyphs are kept in reading order along the baseline: a value shown back to
  front, or words drawn from the right, reads as "Jan Kowalski" in the text a
  detector sees; overlapping glyphs keep content order.
- The pdf.js cross-check no longer replaces our text when pdf.js read less
  (a font it rejects, pattern text) or misread a font we decoded completely;
  such pages keep our text and are rasterized on edit with our glyph
  geometry for the black boxes (pdf.js item widths can be wrong). A page
  whose only reading comes from pdf.js as glyph ids, controls, U+FFFD or
  private-use characters is unredactable instead of "fine".
- Fonts: a placeholder never reuses a code the font advances by zero;
  /Differences names without metrics (/.notdef, /gNN) advance like the base
  encoding's glyph and blank glyphs are not "unreadable"; symbolic embedded
  TrueType fonts without /Encoding decode through MacRoman (pdf.js); glyph
  text is folded at decode time (ﬁ -> fi, Kangxi radicals -> ideographs).
- Matching: layer zero, the verifier's text passes and its byte passes share
  one search (whitespace, hyphens and ligatures ignored, case folded) that
  requires token boundaries: "Nowak" is not "Nowakowski", "kid" is not /Kids;
  a value hyphenated at a line end is still found. The verifier also scans
  name objects and, for multi-word or numeric values, font programs.
- Layout: two placeholders on one line, or a value touching another in one
  show, each get their placeholder and their shift; consecutive TJ
  adjustments add up; the room before the next column accounts for shifts
  already planned; a placeholder never goes below 4 pt (a warning reports an
  unavoidable overlap); text on a rotated baseline crossing a line no longer
  drags that line's cells.
- Output hygiene: XMP on any copied object, /PieceInfo, font descriptor
  family/charset strings and layer names are removed from the output (and
  the orphaned objects from the file); ToUnicode maps are rewritten for every
  edited font, including fonts whose edited shows were deleted whole.
- Files with only an owner password open; Type3 fonts never take standard-14
  metrics.

### Fourth review (T221, same release)

- Randomized invariants (`tests/pdf-fuzz.test.ts`, seeded generator of
  layouts with out-of-order text, kerning, wrapped and touching values,
  ligatures, diacritics, fallback faces; 2000-document campaigns) found and
  fixed: narrow glyphs drawn back to front filed after their neighbour;
  shifts inside a TJ applied by array order instead of position (a jump-back
  adjustment moved the wrong text, even off the page); overlapping runs
  losing their word separator; two values touching in one show
  over-estimating the room before the next column; layer zero handling a
  shorter value before a longer one that contains it (the surname stayed);
  verifier byte passes counting a Latin-1 letter (ó, ü) or a kerning number
  as a token boundary ("Nowak" refused because of "Nowaków"); the
  code-sequence pass without boundaries (now single-byte codes at token
  boundaries only).
- Second real-world corpus (44 files: Acrobat, iText, Aspose, Scribus,
  TCPDF, wkhtmltopdf, pdfTeX/xdvipdfmx, LibreOffice/OpenOffice, ArcGIS,
  PDF 2.0 samples): pdfTeX Type1 fonts without /Encoding are decoded through
  the font program's cleartext encoding (LaTeX documents are edited in place
  instead of rasterized); a rasterized vertical-writing page is covered whole
  (the value stayed legible before); the verifier scans only string operands
  of content streams (a house number equal to a font size no longer refuses
  the export), recognises font programs by their magic bytes (TrueType table
  tags in the fallback subset are not values), and ignores a value that only
  survives inside its own placeholder ("We" in "[WE]"); raster boxes on
  pdf.js-read pages cover the value plus one glyph each side instead of the
  whole item; scanned pages with a hidden OCR layer are described as such;
  consecutive unredactable pages collapse into one entry ("pages 2-22").
- Robustness (byte mutations, hostile structures): page-tree errors and
  every pdf.js failure surface as typed errors; a page pdf.js cannot read
  fails verification closed; rasterization failures are typed; replacement
  ranges outside the text are refused instead of clamped to the whole
  document; caps on decoded content per page (32 MB), form XObject draws per
  page (20 000) and glyphs per document (1.5 million, runs weighted) turn
  Flate bombs and exponential XObject graphs into `too-large` or a refused
  page, and pdf.js is never asked about such a page; every pdf.js page
  operation has a 60 s deadline (effective where pdf.js runs in a worker);
  layer zero, the placement planner (baseline index) and the byte scan
  (native string search) are linear again for thousands of replacements.
- Verifier: pages both extractors read identically are settled by our own
  pass; pdf.js is consulted only for pages with issues (its spacing
  heuristics reported "Jan" inside a kerned "Janusz"), and its items are read
  in baseline order (words drawn from the right no longer spell a value); the
  removed-code-sequence pass runs only when our extractor cannot re-read the
  output.
- pdf.js never registers document fonts with the browser's FontFace API:
  reading a 100-font file in Chromium dropped from 4.2 s to 0.8 s and the
  export is no longer dominated by font round trips.
- Web: a damaged PDF gets its own message (the docx one told users to open
  the file in Word); a failed upload while another file is loaded shows its
  message.

### Tests

- 15 synthetic PDF fixtures (standard-14, Type0 Liberation, TJ kerning,
  split shows, short names, form XObject, hidden text, ActualText,
  annotations, AcroForm, outlines/Info/XMP, embedded file, incremental
  update, object streams, rotated page with rise/Tz/Tw), the desktop's 10
  standard-14 fixtures and a Chrome/Skia Type0 fixture; `assertNoTrace`
  understands PDF (inflated streams, object streams, strings, UTF-16 BE).
- Fixture zips no longer carry implicit folder entries: JSZip stamped them
  with the current time, so the "is deterministic" check failed when two
  builds straddled a 2-second boundary (seen once under full-suite load).

## [0.12.1] - 2026-09-24

First run of the real-file corpus job (LibreOffice-generated docx, doc and
xlsx) on CI after 0.12.0 was published. One reader/writer gap and three test
expectations came out of it; no published API changed.

### Fixed

- **xlsx: identifiers stored as numbers (T176, minimal).** A PESEL, phone or
  account number typed into a cell is a numeric `<v>`. Numbers of seven or
  more digits are now part of the extracted text, and a replaced numeric cell
  is written as an inline string cell without its formula, so Excel opens
  the workbook without repair. Shorter numbers (amounts, counts, date
  serials) are left alone.

### Tests

- Corpus assertions distinguish consented parts (OLE ObjectPool and Macros
  storages in .doc reported by `inspectDoc`; embedded parts in docx/xlsx
  reported by the readers) from the rest of the package, and account for
  occurrences inside tracked deletions that `acceptTrackedChanges` drops.
- A .doc whose PII sits only in frames or text boxes re-parses clean but
  placeholder-free (the legacy writer overwrites those stories in place);
  the suite checks for surviving needles instead of a placeholder count.
- Timing tests guard linearity with budgets that tolerate shared CI runners.
- Part-name inventory refreshed from the LibreOffice corpus.

## [0.12.0] - 2026-09-24

Security remediation release (audit `SECURITY_REPORT-2026-09.md`, plan
`documentation/security-remediation-plan-2026-09-v2.md`). Every change is
fail-closed: what Core cannot redact is refused or reported, never copied in
silence.

### Breaking for hosts

- **`CoreEnv.buildTokenizer(tokenizerJson, tokenizerConfig)` (T185):**
  providers now download `tokenizer.json` and `tokenizer_config.json` from
  their pinned commit through `fetchModelBlob` (SHA-256 and size verified,
  cached in `doccloak-models`, resumable) and hand the parsed JSON to the
  host, which constructs the tokenizer (`new PreTrainedTokenizer(json,
  config)` on the web). `CoreEnv.loadTokenizer(hfModelId)` still works in
  0.12.0 as a deprecated fallback (one console warning) and is removed in
  0.13.0. The `AutoTokenizer.from_pretrained` probe to `resolve/main` on
  every start is gone, so a fully cached model loads with zero requests.
- **`redactOfficeFile` throws `StaleAnalysisError` (T179)** when an entity
  no longer matches the fresh extraction, instead of silently dropping it
  and exporting the value. Pass `onMismatch: 'drop'` for the old behaviour.
- **Files with unredactable parts are refused by the writers (T177)** unless
  `allowUnredactable: true` is passed (`writeAnonymizedDocx*`,
  `writeAnonymizedXlsx*`, `redactOfficeFile`). `readDocx` / `readXlsx`
  report them in `extraction.unredactable` (`part`, `kind`, `label`) so a
  host can ask the user first; when allowed, `result.warnings` names every
  part copied verbatim.

### Added

- **Package-wide value scrub, "layer zero" (T172):** after the offset
  replacements, every known session value (entries, variants, name tokens)
  is replaced in every text node and attribute of every XML part of the
  package (`charts`, `diagrams`, `customXml`, `pivotCache`, `docProps`,
  rels and more), with a safety rule that never touches identifiers,
  geometry or layout attributes. `writeAnonymizedDocxWithReport` /
  `writeAnonymizedXlsxWithReport` return `{ blob, warnings }`.
- **New text parts and units (T174, T175):** charts (`c:v` caches, titles),
  SmartArt (`dgm:t`), DrawingML text (`a:t`), `customXml/item*.xml` leaf
  text, the whole `word/glossary/**` set, `numbering.xml` level text,
  `webSettings.xml` frame titles, `w:delInstrText`, OMML `m:t`; attribute
  units for field instruction arguments, content-control aliases, drawing
  alt text and bookmark names (renamed bookmarks keep `REF`, `PAGEREF`,
  `NOTEREF`, `HYPERLINK \l` and anchors valid). Tabs, breaks and
  non-breaking hyphens are emitted as separators, text boxes are separated
  from their host paragraph, `mc:Fallback` twins are redacted too, and a
  replacement never crosses a paragraph break.
- **Part policy (T177):** `classifyPart` tables for docx and xlsx (text /
  structural / unredactable / unknown), `describeUnredactableParts`,
  200 MB unpacked-size guard (`UnsupportedDocumentError` code
  `'too-large'`).
- **`UnsupportedDocumentError`** with codes `unrecognized-namespace`,
  `invalid-package`, `unredactable-parts`, `too-large`, `fast-saved`,
  `encrypted`; `extraction.empty`, `extraction.warnings`.
- **Engine (T185):** `createEngine(env, factories, { autoLoad: false })` makes
  `detect()` throw `ModelNotLoadedError` until the host calls `preload()`
  (hosts implement consent above Core); `serveEngine` validates every
  message and answers unknown or malformed ones with an `error` frame;
  verification markers carry `sha256:size` and are re-checked against the
  cached blob size.
- **Session (T182, T183):** `registerDocumentValues`, `lastAmbiguous()` /
  `getAmbiguousValues()`; surrogates are never a value (or a name token)
  that occurs in the document; single-pass exact restore with script-aware
  word boundaries; literal `[TYPE_N]` tokens in the input never collide
  with generated ones.
- **Tests:** `assertNoTrace` helper scanning every part and the raw archive
  in UTF-8, latin1 and UTF-16LE, 33 synthetic Office / .doc fixtures, a
  real-file corpus generated by LibreOffice in CI with an independent
  extraction check, a 30-document end-to-end session suite, adversarial
  regex inputs.

### Changed

- Regex rules are enabled by default (`regexEnabled` defaults to `true` when neither the host nor a saved setting says otherwise). Structured identifiers no longer depend on the model alone in a fresh profile (T203).
- ML spans are trimmed of surrounding punctuation before merging: a whitespace-split provider such as BardS.ai returned `Anna Nowak,` and the redacted text lost the comma (T204).

- **Strict OOXML is supported (T172):** transitional and
  `purl.oclc.org` namespaces are both read; a main part without a
  recognised body is refused (`unrecognized-namespace`) instead of being
  exported untouched.
- **Regex detection runs per line (T180)** (rules with `multiline: true`
  run on the whole text), which removes the multi-minute stalls on long
  prose; postal/city rules end on a letter and use a Unicode look-ahead
  instead of `\b` (T181).
- **False-positive filter (T181):** CJK / Thai values of 2 characters and
  Latin PERSON values of 2 characters (`Li`, `Ng`, `J.`) are kept; a short
  stoplist drops titles (`Mr`, `Dr`, `Jr`...). Propagation uses Unicode
  boundaries, exact offsets after `İ`, exact case for terms of 2
  characters, and skips lowercase hits of common-word names (`bill`,
  `mark`, `will`...).
- **Restore (T182):** `renameLabel` rejects empty and colliding labels;
  `importEntries` / `deserialize` validate every entry and cap at 10 000;
  `personTokens` is linear. Surrogate pools no longer contain common
  English words or names of 3 letters or fewer.
- **Metadata (T179):** `contentStatus`, `identifier`, `created`,
  `modified`, `lastPrinted`, `revision`, `version`, document statistics,
  `TitlesOfParts` / `HeadingPairs` are blanked, zeroed or normalised;
  comment and revision dates are set to 2000-01-01; `w:rsid*` attributes
  are removed; ZIP entries are dated 1980-01-01 with no comments.
- **Always scrubbed without detection (T174):** hyperlink tooltips,
  `mailto:` relationship targets, `w:docVars`, content-control tags without
  data binding.
- **Legacy .doc hardening (T178, security report 2026-09 H5, H6, M5, L2):**
  `readDocText` and `writeAnonymizedDoc` now throw `UnsupportedDocumentError`
  (`code: 'fast-saved'`) for incrementally saved files (`fComplex`, or
  `cQuickSaves > 0` on Word 97 files) and (`code: 'encrypted'`) for
  `fEncrypted` / `fObfuscated` files instead of returning partial or
  ciphertext output. `writeAnonymizedDoc` takes an optional
  `valueReplacements` list (same shape as `writeAnonymizedDocx`) and destroys
  every remaining byte occurrence of each original value and its 4+ character
  tokens, any case, in `WordDocument` (UTF-16LE), `Table` (UTF-16LE and
  cp1252) and `Data` (UTF-16LE), length-preserving. `SttbfRMark`,
  `GrpXstAtnOwners`, `SttbfBkmk`, `SttbSavedBy` and `AutosaveSource` are
  scrubbed alongside `SttbfAssoc`. New `inspectDoc(buffer)` reports the
  refusal flags and the presence of `Data`, `ObjectPool` and `Macros`
  streams (the latter two are still copied through; see README "Known
  limits: legacy .doc"). `UnsupportedDocumentError` is also exported from
  the main entry.

## [0.11.0] - 2026-09-23

### Changed

- **Variant-faithful restore (T171):** person variants still share one
  identity, but every distinct variant now gets its own token, so
  `deanonymize` writes back exactly what was there instead of the longest
  known form. In labeled mode the token keeps the group's number and adds
  a positional suffix: `[PERSON_2]` for "John Smith", `[PERSON_2_LAST]`
  for "Smith", `[PERSON_2_FIRST]` for "John", `_MIDDLE` / `_SHORT` /
  `_FULL` / `_ALT` for the other shapes, with a counter on collisions
  (`[PERSON_2_LAST_2]` for "smith"). In surrogate mode a variant that is a
  strict part of the canonical name takes the matching words of the
  surrogate with the variant's casing ("Smith" -> "Nowak", "smith" ->
  "nowak"); fuller forms and reshaped surrogates fall back to the group
  surrogate as before. Blanked mode is unchanged. The tolerant restore
  pass resolves mangled variant tokens like any other.
- **PERSON pre-pass in `anonymizeText`:** people are mapped before other
  entities, fullest name first and then in reading order, so a variant
  group always forms around the full name and several people are numbered
  in the order they appear (`[PERSON_1]` is now the first person in the
  text; other entity types keep their historical numbering order).
- **`renameLabel` returns the applied `[oldLabel, newLabel]` pairs** (was
  `void`). Renaming a group's base token re-derives its variant tokens
  (`[PERSON_1]` -> `[CLIENT]` takes `[PERSON_1_LAST]` to `[CLIENT_LAST]`);
  renaming a variant token renames only that token and detaches it from
  the group.
- `deserialize` / `importEntries` re-link variant tokens to their base and
  keep legacy many-to-one maps restoring the longest variant.

### Fixed

- **Office value scrubbing applies longer values first and sees URL-encoded
  forms:** hyperlink targets, field instructions and formula literals in
  .docx / .xlsx exports are scrubbed with the longest sensitive value first,
  so a name variant listed before the full name ("Kowalski" before
  "Jan Kowalski") no longer leaves "Jan" behind. External relationship
  targets also match the percent-encoded form of each value, so
  "Jan%20Kowalski" in a link is removed as a whole. `.docx` and `.xlsx`
  writers now share one `replaceSensitiveValues` implementation.

## [0.10.0] - 2026-09-23

### Added

- **GLiNER PII Base provider (T122):** new `gliner-base` provider for
  `knowledgator/gliner-pii-base-v1.0` (~197 MB quint8, Apache-2.0,
  pinned revision + SHA-256). Span-level (`markerV0`) decoding with
  zero-shot custom labels; strongest option for English and dates.
  Exported as `GlinerBaseProvider` plus `GLINER_BASE_MODEL_URL` /
  `_REVISION` / `_SHA256`, `buildSpanIndices` and `decodeSpanLogits`.
  `ProviderId` now includes `'gliner-base'` and `createEngine` registers it.

- **Office file redaction (T110):** `@doccloak/core/dom` gains
  `readXlsx` / `writeAnonymizedXlsx` / `isExcelFile` and a
  detection-driven `redactOfficeFile` / `analyzeOfficeFile` flow for
  .docx and .xlsx that keeps placeholders consistent with a live
  `AnonymizationSession`. `writeAnonymizedDocx` accepts an option to
  accept tracked changes (deletions dropped, insertions unwrapped,
  author/date change records removed). Defaults preserve the previous
  output byte-for-byte.

### Changed

- **Light model swapped (T121):** the `gliner` provider now loads
  `knowledgator/gliner-pii-small-v1.0` (~83 MB, same tokenizer family)
  instead of `gliner-pii-edge-v1.0`. Cached copies of the old edge model
  are evicted best-effort on load. Labels read "GLiNER PII Small".

- **Provider descriptions (T127):** registry copy reflects the 2026-08
  14-language benchmark. `pickDefaultProvider` is unchanged: `bardsai` on
  capable devices, `gliner` on mobile / low-memory devices.

- **ONNX Runtime 1.29.0:** providers import `onnxruntime-web/webgpu`
  (native WebGPU EP with wasm fallback). Hosts that self-host the ORT
  runtime files must now serve `ort-wasm-simd-threaded.asyncify.wasm`
  and `.asyncify.mjs` instead of the plain / `.jsep` pair.

### Fixed

- **bardsai with transformers.js 4.x:** subtoken alignment no longer calls
  the removed `tokenizer.model.convert_ids_to_tokens` (which made
  detection throw on transformers.js 4); it uses `tokenizer.tokenize()`.

## [0.9.0] - 2026-08-21

### Added

- **Secrets & credentials detection (T099/T116):** new `SECRET` and
  `API_KEY` entity types plus eleven universal regex rules covering AWS
  access keys, GitHub/Slack tokens, OpenAI/Anthropic/Google API keys,
  PEM private-key blocks, JWTs, connection strings with embedded
  credentials, `secret=`-style assignments and high-entropy tokens, and
  a GB driving-licence rule. Credentials never receive realistic
  stand-ins, even in surrogate mode they always fall back to typed
  placeholders, since a same-shape fake key still reads as a live
  credential.

- **Tolerant restore-token matching (T098):** new side-effect-free
  `@doccloak/core/restore-tokens` export that restores placeholders LLM
  replies have mangled, case changes (`[person_1]`), separator swaps
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
