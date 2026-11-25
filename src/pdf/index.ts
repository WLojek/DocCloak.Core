/**
 * @doccloak/core/pdf - PDF redaction that keeps the text layer (T206-T215).
 *
 * readPdf(file) -> PdfExtraction (plainText for detection, geometry, parts)
 * writeAnonymizedPdfWithReport(extraction, replacements, values, options) -> redacted PDF
 *
 * Hand edits (WLojek/DocCloak.Core#6): openPdfPreview(extraction) shows the pages,
 * applyPdfEdits(extraction, { removedPages, regions }) -> the extraction without them.
 */
export type * from './types.ts';
export { readPdf, isPdfFile, toPdfBytes } from './read.ts';
export type { PdfExtraction, PdfInput } from './read.ts';
export { writeAnonymizedPdfWithReport, StalePdfExtractionError, NORMALISED_PDF_DATE } from './write.ts';
export type { PdfWriteOptionsInternal } from './write.ts';
export { PdfVerifyError, verifyPdf } from './verify.ts';
export type { VerifyFinding, VerifyEdits } from './verify.ts';
export { applyPdfEdits, mapKeptRange, normalizePdfEdits } from './edits.ts';
export type { PdfEditResult, KeptStretch, NormalizedPdfEdits } from './edits.ts';
export { openPdfPreview, pixelRectToUserRect, userRectToPixelRect } from './preview.ts';
export type { PdfPreview, PdfPreviewOptions, PixelRect } from './preview.ts';
export { fitPlaceholder, DEFAULT_FIT } from './fit.ts';
export type { FitResult, FitInput } from './fit.ts';
export { openWithOracle, normalizeForCompare, defaultCanvasFactory } from './oracle.ts';
export type { OracleDocument, CanvasFactory, CanvasHandle, RenderedPage, OracleTextItem } from './oracle.ts';
export { FallbackFontProvider, FallbackFontEmbedder, faceFor, styleFromFontName, FALLBACK_FACES, faceFileName } from './fallback-fonts.ts';
export type { FallbackFace } from './fallback-fonts.ts';
export { extractPdf } from './extract.ts';
export type { ExtractionResult } from './extract.ts';
