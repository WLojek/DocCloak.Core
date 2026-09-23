/**
 * @doccloak/core/dom - DOM-dependent submodule.
 *
 * Code that requires DOM APIs (DOMParser/XMLSerializer for docx, canvas for
 * OCR) is quarantined behind this export path so importing the main entry
 * never pulls in DOM references (architecture doc 4.1 principle 4). OCR
 * additionally runs in DOM-less worker contexts via OffscreenCanvas and
 * createImageBitmap (feature-detected).
 */

export * from './docx.ts';
export * from './ocr.ts';
// T110: xlsx + detection-driven office file redaction
export * from './xlsx.ts';
export * from './office.ts';
