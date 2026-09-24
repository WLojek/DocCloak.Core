# Hand-saved corpus files

Files in this folder are picked up automatically by `tests/corpus.test.ts`
and by the `office-open` CI job. They are the part of the corpus that
LibreOffice cannot produce: the same seed content saved by real Word 365
(Windows and Mac), Google Docs, Pages and Excel 365, plus a few "from life"
documents with the real PII replaced by a seed's values.

## Recipe

1. Pick a seed under `tests/corpus/seeds/` (for example
   `pl-employment-contract.fodt`). Open it in LibreOffice, or read the XML and
   retype the content; what matters is that every string listed under
   `needles` in `tests/corpus/seeds/<seed>.json` appears in the document, in
   the placement the manifest names (`placements`): body, heading, table,
   header, footer, footnote, comment, text box, chart title, document
   properties (File > Info in Word), sheet name.
2. Save it from the target application:
   - Word 365 on Windows: File > Save As > Word Document (.docx) and, for the
     legacy format, Word 97-2003 Document (.doc).
   - Word 365 on Mac: same menu.
   - Google Docs: File > Download > Microsoft Word (.docx).
   - Pages: File > Export To > Word.
   - Excel 365: File > Save As > Excel Workbook (.xlsx). Put a needle into a
     sheet name, a cell comment and a chart title as the manifest asks.
3. Name the file `<seed>__<source>.<ext>`, where `<seed>` is the seed name
   (the file stem of the manifest) and `<source>` identifies the application
   and platform, for example:
   - `pl-employment-contract__word365-win.docx`
   - `pl-employment-contract__word365-mac.doc`
   - `pl-employment-contract__gdocs.docx`
   - `en-invoice-letter__pages.docx`
   - `pl-payroll-sheet__excel365-win.xlsx`
   Everything before the first `__` selects the manifest; everything after it
   is free text (letters, digits, dashes).
4. Keep it small: no image over 50 KB, no embedded fonts, no huge thumbnails.
   If Word offers "Save thumbnail", leave it off (the writer removes it, but
   the repository does not need the bytes).
5. Commit the file. Nothing else is needed: the suite discovers it, redacts
   it, scans the output, and CI converts the output to PDF and text with
   LibreOffice.

"From life" documents: replace every real name, address, identifier and
contact detail with values from one seed, name the file after that seed
(`<seed>__fromlife-<n>.<ext>`), and check twice that nothing real is left,
including in document properties, comments and tracked changes.

If a file must be refused by the reader (an encrypted `.doc`, a fast-saved
`.doc`), add `"expectUnsupported": { "doc": "<code>" }` to the seed manifest
so the suite asserts the refusal code instead of a clean redaction.

See `docs/testing-corpus.md` for the full picture.
