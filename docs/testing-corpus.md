# Real-file corpus (T196)

The synthetic fixtures under `tests/helpers/fixtures/` prove that the writers
handle the packages we build by hand. The corpus proves the same for packages
built by real office suites: LibreOffice in CI, and Word 365, Google Docs,
Pages and Excel 365 through files saved by hand. Every corpus file is
redacted through the public writers and must come out with zero traces of the
seeded PII, checked twice: by our own byte scanner (`assertNoTrace`) and by
an extractor we did not write (LibreOffice for docx/doc/xlsx, poppler's
`pdftotext` for PDF). The threshold is 100 percent; one failing file fails
the `office-open` job. Plan reference:
`documentation/security-remediation-plan-2026-09-v2.md`, section 4. PDF
joined the corpus with T218: every seed is also exported to PDF by
LibreOffice and redacted through the text-layer writer of
`@doccloak/core/pdf` (see "PDF in the corpus" below).

## Layout

```
tests/corpus/
  seeds/          hand-written sources (.fodt, .fods, .html) + <seed>.json manifests
  generated/      LibreOffice output of the seeds (gitignored; CI or local soffice)
    docx/ doc/ xlsx/ pdf/
  handsaved/      files saved from Word 365, Google Docs, Pages, Excel 365 (committed)
  generate.mjs    seed -> docx/doc/xlsx/pdf converter (needs soffice; exits 0 without it)
  manifest.ts     shared loader: manifests, discovery, checksum helpers
  seeds.test.ts   seed self-test (runs everywhere)
  inventory.test.ts + part-inventory.json   part names seen per format (feeds T177)
tests/corpus.test.ts   the corpus suite itself
```

## What a seed is

A seed is one document with PII planted in the places the 2026-09 audit found
leaks: body text, headings, tables (including merged cells), headers and
footers, footnotes and endnotes, comments (text and author), text frames and
shapes, chart titles and categories, document properties (creator, subject,
keywords, custom properties), sheet names, cell comments, formula string
literals, hyperlink targets, tracked changes. Seeds are written as flat ODF
XML (`.fodt` for Writer, `.fods` for Calc) or plain HTML, so they are
reviewable in a diff and need no binary tooling to edit.

The sibling `<seed>.json` manifest is the contract:

```json
{
  "seed": "pl-employment-contract",
  "source": "pl-employment-contract.fodt",
  "language": "pl",
  "formats": ["docx", "doc", "pdf"],
  "needles": ["Katarzyna Wiśniewska", "85031412347", "..."],
  "where": ["body", "header", "table", "footnote", "comment", "meta"],
  "placements": { "Katarzyna Wiśniewska": ["body", "header", "table", "footnote", "meta"] },
  "optional": [],
  "notes": "..."
}
```

- `needles`: exact strings that must not survive in any redacted output.
  Avoid `&`, `<` and `>` (they are escaped in XML). PESELs must have a valid
  checksum and IBANs a valid mod-97 check digit; `seeds.test.ts` verifies
  both, so a regex-based detector would fire on them as well.
- `placements` / `where`: where each needle lives, for humans reading a
  failure and for the coverage assertion in `seeds.test.ts`.
- `optional`: needles a converter may legitimately drop from the generated
  input (a tracked deletion, an HTML comment, a chart title). They are still
  asserted absent from the output.
- `optionalFor` (optional): the same per format, for example
  `{ "pdf": ["ul. Długa 12/4, 31-147 Kraków"] }` when one converter drops or
  reshapes a needle that the others keep. Merged with `optional` by
  `requiredNeedles(manifest, ext)`.
- `expectUnsupported`: an `UnsupportedDocumentError` code the reader must
  raise, for every format (`"fast-saved"`) or per format
  (`{ "doc": "encrypted" }`). Use it for seeds that exist to test a refusal.

The current 17 seeds: 11 `.fodt`, 3 `.html` (docx and doc each), 3 `.fods`
(xlsx), in Polish, English and German. Every seed is also exported to PDF
(`formats` lists `pdf`), so the corpus holds 17 PDFs: 14 from Writer, 3 from
Calc.

## How the suite works

`tests/corpus.test.ts` discovers every file under `generated/<fmt>/` and
`handsaved/`, maps it to a manifest by the seed name (file stem up to the
first `__`), and for each file:

1. asserts the required needles are present in the input (raw bytes or
   extracted text), so the seed really tests what it claims;
2. extracts with `readDocx` / `readXlsx` / `readDocText` / `readPdf` and
   turns every exact needle occurrence into an entity with a `[TYPE_n]`
   placeholder (no ML runs here; the manifest is the entity list). Every
   manifest needle, found in the text or not, also goes into the layer-zero
   value list built with `layerZeroValueReplacements`, so sheet names, chart
   caches and document properties are scrubbed too;
3. writes through `writeAnonymizedDocxWithReport` (tracked changes
   accepted), `writeAnonymizedXlsxWithReport`, `writeAnonymizedDoc` or
   `writeAnonymizedPdfWithReport` (`allowUnredactable: true`, the Liberation
   fallback fonts from `fonts/liberation/`, and the `@napi-rs/canvas` factory
   from `tests/helpers/pdf-canvas.ts` for the raster fallback);
4. `assertNoTrace(output, needles)`: no needle in any part, nested container
   or encoding;
5. re-reads the output: it parses, holds the placeholders, holds no needle;
6. reads the input a second time and compares `plainText` and
   `paragraphBreaks` (determinism);
7. counts placeholders in the re-extracted text: at least as many as
   occurrences replaced (for `.doc` a lower bound, because subdocument text is
   overwritten in place rather than substituted; for PDF minus the occurrences
   on pages the writer rasterized, whose box lives in the pixels);
8. writes `<stem>-redacted.<ext>` to `DOCCLOAK_WRITE_OUTPUTS` for the CI job.

The writer-warning check is format aware: docx/xlsx warnings name the
unredactable part as `<part>: ...`, PDF warnings carry the part label
(`page 3 is an image without a text layer ... (exported as is)`). For PDF a
`page N: rasterized (...)` note is accepted (and required for every page in
`rasterizedPages`); anything else unexpected fails.

## PDF in the corpus (T218)

`generate.mjs` exports every seed to `generated/pdf/<seed>.pdf` with the
Writer (`pdf:writer_pdf_Export`, fodt and html) or Calc
(`pdf:calc_pdf_Export`, fods, all sheets) filter at default options: fonts
subset-embedded, links kept, comments and user-defined properties not
exported, no tagged PDF. That is what the text-layer writer sees in the
field: TJ kerning arrays, one text-showing operator per word or line, Type0
fonts with ToUnicode CMaps, an Info dictionary with Author/Subject/Keywords.

Not everything a seed plants reaches a PDF page. The placement labels in
`PDF_HIDDEN_PLACEMENTS` (`tests/corpus/manifest.ts`: comment, comment-author,
html-comment, change-author, meta, hyperlink-target(-urlencoded), sheet-name,
formula-literal, tracked-deletion) are the ones a PDF export renders no glyphs
for. `requiredNeedles(manifest, 'pdf')` therefore does not require a needle
whose placements are all hidden; it is still asserted absent from the output
(the Info dictionary is scanned by `assertNoTrace` and dropped by the writer).
The input-presence check also accepts a needle whose internal space became a
line break in the PDF (whitespace-folded comparison), because the raw-byte
scan cannot see Type0 text and an address wrapped over two lines is still
the same address. A wrapped occurrence is not matched as an entity, exactly as
a real detector would not see it in one line; no false failure results
either way, since neither the scanner nor `pdftotext` sees it in one piece.

In CI, after `npm test`, the `office-open` job runs poppler over every
`*-redacted.pdf` in `DOCCLOAK_WRITE_OUTPUTS`:

- `pdftotext -layout` must exit 0 (the file opens with a reader we did not
  write) and the text is grepped with `grep -F -f` against the union of all
  manifest needles; a hit fails the job;
- `pdffonts` must exit 0; its table (every font should be embedded and
  subset) is printed into the log and kept under `pdf-text/<stem>.fonts` in
  the `office-open-outputs` artifact together with the `.txt` files.

The synthetic fixture outputs (`pdf-*-redacted.pdf` from
`tests/pdf-write-fixtures.test.ts`) are written to the same directory. Their
seeds live in `tests/helpers/fixtures/pdf.ts`, not in a manifest, so the job
only proves they open; the sweep test already runs `assertNoTrace` and both
extractors over them. Grepping them too would need the sweep test to write
its seeds next to each output (a `<name>.needles.json` through `writeOutput`),
which is a follow-up.

If the reader throws `UnsupportedDocumentError`, the code is compared with
the manifest's `expectUnsupported`; any other code, or a refusal the manifest
does not expect, fails.

## Locally versus CI

Locally without LibreOffice, `npm test` runs the seed self-test and the
inventory test and reports the corpus suite as one skipped test named
"no corpus files: run node tests/corpus/generate.mjs ...". Nothing fails.

With LibreOffice installed (`brew install --cask libreoffice` on macOS,
`apt-get install libreoffice-writer libreoffice-calc` on Debian/Ubuntu):

```sh
node tests/corpus/generate.mjs            # seeds -> tests/corpus/generated/ (docx, doc, xlsx, pdf)
node tests/corpus/generate.mjs --format pdf --only pl-employment-contract   # one PDF only
DOCCLOAK_WRITE_OUTPUTS=/tmp/doccloak-out npm test
# optional: the same independent check CI runs
for f in /tmp/doccloak-out/*-redacted.docx /tmp/doccloak-out/*-redacted.doc; do
  soffice --headless --convert-to txt:Text --outdir /tmp/doccloak-out/text "$f"
done
node tests/corpus/generate.mjs --needles > /tmp/needles.txt
grep -rFf /tmp/needles.txt /tmp/doccloak-out/text && echo LEAK
# PDF outputs: poppler (brew install poppler / apt-get install poppler-utils)
mkdir -p /tmp/doccloak-out/pdf-text
for f in /tmp/doccloak-out/*-redacted.pdf; do
  pdftotext -layout "$f" "/tmp/doccloak-out/pdf-text/$(basename "${f%.pdf}").txt" || echo "DOES NOT OPEN $f"
  pdffonts "$f"
done
grep -rFf /tmp/needles.txt /tmp/doccloak-out/pdf-text && echo LEAK
```

The PDF export needs no extra LibreOffice component: Writer exports the
`.fodt`/`.html` seeds and Calc the `.fods` seeds. Without generated PDFs the
PDF part of the suite is simply absent (discovery finds no file under
`generated/pdf/`); the other formats run as usual.

`generate.mjs` only reconverts seeds newer than their output; `--force`
reconverts everything, `--only <seed>` and `--format <fmt>` narrow it, and
`SOFFICE=/path/to/soffice` overrides discovery.

In CI (`office-open` job in `.github/workflows/ci.yml`) the order is: install
LibreOffice, the Liberation fonts and poppler-utils, `npm ci`,
`node tests/corpus/generate.mjs` (docx, doc, xlsx and pdf), `npm test` with
`DOCCLOAK_WRITE_OUTPUTS` set, convert every written docx/xlsx/doc to PDF
(exit 0 and PDF over 1 KB), then convert every `*-redacted.*` output to
`txt:Text` (Writer) or csv with all sheets (Calc) and grep the union of all
manifest needles over the extracted text and over the exported file names
(sheet names land in csv file names), then run `pdftotext -layout` and
`pdffonts` over every `*-redacted.pdf` and grep the same needles over the
text. Any hit, or a PDF poppler cannot open, fails the job. The job then
refreshes `part-inventory.json` and uploads it, together with the outputs,
PDFs, extracted text and the generated corpus, as the `office-open-outputs`
artifact. The job keeps `continue-on-error: true` until 2026-10-08, as T173
set it; after that it is required and gates the Core release (T197).

## Adding a seed

1. Create `tests/corpus/seeds/<name>.fodt` (or `.fods`, `.html`). The
   existing seeds are the templates: copy one, keep the namespace block,
   page layout with header and footer styles, and the master page.
2. Create `tests/corpus/seeds/<name>.json` with the fields above. Every
   needle must occur verbatim in the source. Use names that do not occur in
   other seeds' filler text (the CI grep uses the union of all needles);
   `seeds.test.ts` checks this.
3. Run `npm test`: `seeds.test.ts` validates well-formedness, needle
   presence, checksums and cross-seed leaks with no LibreOffice needed.
4. If LibreOffice is available, run `node tests/corpus/generate.mjs --only
   <name>` and `npm test` again; otherwise push and read the `office-open`
   job.

## Adding hand-saved files

See `tests/corpus/handsaved/README.md` for the step-by-step recipe. In short:
reproduce a seed's content in the target application, save it as
`<seed>__<source>.<ext>` (for example `pl-payroll-sheet__excel365-win.xlsx`),
keep images under 50 KB, commit. The founder supplies these; the target set
from the plan is 20 to 30 files (Word 365 Windows and Mac, Google Docs
export, Pages export, Excel 365) plus 5 "from life" files with the real PII
swapped for a seed's values.

## Part-name inventory

`tests/corpus/part-inventory.json` lists every package part name seen per
format (zip entries for docx and xlsx, CFB streams and storages for doc)
across the T173 fixtures and every corpus file (PDFs have no package parts
and are skipped), with digit runs folded to
`#` (`word/header#.xml`). `inventory.test.ts` fails when a file carries a
part name that is not listed, which is the moment to classify that part in
the T177 policy (text, structural, unredactable). To refresh the file:

```sh
DOCCLOAK_UPDATE_INVENTORY=1 npx vitest run tests/corpus/inventory.test.ts
```

Without LibreOffice locally, take the refreshed file from the CI artifact
(`office-open-outputs/inventory/part-inventory.json`) or paste the names
from the failure message.

## Open-in-Word experiment (T199 gate)

T199 proposes removing unredactable parts (embedded OLE objects, VBA
projects, altChunk HTML, charts with embedded workbooks, `.doc` ObjectPool
streams) instead of refusing the file. The entry condition is evidence that
files still open after removal: LibreOffice in CI (the PDF conversion step
above, run on outputs of the removal prototype) and Word 365 by hand.

Record every file in the table below. One row per file and removal class.
"Result" means: opens without a repair prompt, content readable, no missing
object placeholder that breaks layout. Note the exact Word build.

| file | removal class | Word 365 result | LibreOffice result | date |
| --- | --- | --- | --- | --- |
| _example: en-chart-report__word365-win.docx_ | chart with embedded workbook | _pending_ | _pending_ | |
| | OLE object (`word/embeddings/oleObject*.bin`) | | | |
| | VBA project (`word/vbaProject.bin`) | | | |
| | altChunk (`word/afchunk*.mht`) | | | |
| | chart with embedded workbook (`word/embeddings/*.xlsx`) | | | |
| | `.doc` ObjectPool storage | | | |
| | `.doc` Macros storage | | | |
| | external data connection (`xl/connections.xml`) | | | |
| | external link (`xl/externalLinks/*`) | | | |
| | printer settings (`*/printerSettings/*`) | | | |

Target: 10 files covering OLE, VBA, altChunk, chart with embedded workbook
and `.doc` with ObjectPool. The outcome decides T199 (remove versus keep
refusing) and the stream deletion in T178. The PR that fills the Word column
should link the checklist used and the Word build number.
