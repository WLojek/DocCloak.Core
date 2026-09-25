# Tests

`npm test` runs vitest over `tests/**/*.test.ts` and `src/**/*.test.ts`.
`npm run typecheck` covers `tests/` too, so helpers must compile under `strict`.

## Package scan helper (`tests/helpers/package-scan.ts`)

Every writer test (docx, xlsx, doc) must prove that the ORIGINAL text is gone
from the whole package, not just from the part it edited (security report
2026-09, finding L6). Use:

```ts
import { assertNoTrace } from './helpers/package-scan.ts';

const blob = await writeAnonymizedDocx(extraction, replacements);
await assertNoTrace(blob, ['John Smith', 'jane@acme.com']);
```

`assertNoTrace(input, needles)` accepts a `Blob`, `ArrayBuffer` or `Uint8Array`
and throws when any needle is found:

- in any zip entry decoded as UTF-8, or as raw bytes in latin1 and UTF-16LE,
- in any nested zip or CFB entry (embedded workbooks, OLE blobs, vbaProject.bin),
- in any CFB stream (legacy .doc) in the same three encodings,
- in the raw container bytes (covers entry names, entry and archive comments).

The error names every hit as `"needle" in "part" as encoding`. Nested parts are
written `outer!inner`; CFB streams use their full path (`Root Entry/WordDocument`).

Other exports: `findTraces(input, needles)` (same scan, returns the hits),
`packageContains(input, needle)`, `bytesContain(buffer, needle, utf16)`,
`encodeNeedle(needle, encoding)`, `indexOfBytes(haystack, target)`, `toBytes(input)`.

## Synthetic fixtures (`tests/helpers/fixtures/`)

Pure generators that build packages with PII planted in the places the audit
found leaks. Each generator has a `*_SEEDS` array documenting the needle and
the part it lives in, and `ALL_FIXTURES` lists them all with the finding ids
they reproduce. `tests/helpers/fixtures.test.ts` proves every seed is present
in the raw bytes without calling the redactor, so a fixture can never silently
stop testing what it claims.

```ts
import { buildDocxChart, DOCX_SEED } from './helpers/fixtures/index.ts';

const bytes = await buildDocxChart();
const extraction = await readDocx(new File([bytes], 'chart.docx'));
```

- docx: strict OOXML, chart, diagram, customXml, docVars, altChunk, embedding,
  VBA, OMML, delInstrText, textbox Choice/Fallback twin, tab/noBreakHyphen,
  attributes (fldSimple instr, tooltip, bookmark, sdt tag/alias, docPr descr),
  numbering, everything.
- xlsx: strict OOXML, numeric/date cells, pivot cache, definedName, connections,
  externalLinks, dataValidation, cfRule, formula literal, drawing, VML, richData,
  everything.
- doc: fast-save orphan bytes (fComplex), Data/ObjectPool/Macros streams,
  SttbfRMark/GrpXstAtnOwners/autosave path, fEncrypted, everything.

## LibreOffice smoke job (`office-open` in `.github/workflows/ci.yml`)

When the environment variable `DOCCLOAK_WRITE_OUTPUTS` points at a directory,
`writeOutput(name, bytes)` from the package-scan helper writes the file there;
without the variable it is a no-op. The fixture self-test writes every
generated input, and writer tests should write their redacted outputs the same
way. The CI job installs `libreoffice-writer`, `libreoffice-calc`,
`fonts-liberation` and `poppler-utils`, runs `npm test` with the variable
set, then converts each written `.docx`, `.xlsx` and `.doc` to PDF with
`soffice --headless --convert-to pdf`. A non-zero exit, a missing PDF or a
PDF smaller than 1 KB fails the job. Every written `*-redacted.pdf` (the
corpus PDFs and the `pdf-*` fixture outputs of `tests/pdf-write-fixtures.test.ts`)
is opened with poppler's `pdftotext -layout` and `pdffonts`; a non-zero exit
fails the job, and for the corpus PDFs the extracted text is grepped for every
manifest needle (see `docs/testing-corpus.md`, "PDF in the corpus"). The job is
`continue-on-error: true` until 2026-10-08, after which it becomes required.

Run it locally:

```sh
DOCCLOAK_WRITE_OUTPUTS=/tmp/doccloak-out npm test
for f in /tmp/doccloak-out/*.docx; do soffice --headless --convert-to pdf --outdir /tmp/doccloak-out/pdf "$f"; done
```
