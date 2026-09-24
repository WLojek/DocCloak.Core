// Synthetic legacy .doc (CFB) fixtures reproducing SECURITY_REPORT-2026-09
// findings H5 (fast-save orphan bytes), H6 (Data / ObjectPool / Macros
// streams), M5 (SttbfRMark, GrpXstAtnOwners, fcAutosaveSource) and L2
// (fEncrypted). Same FIB layout as tests/doc.test.ts, extended with the extra
// streams and tables. Generators are synchronous and return Uint8Array.

import CFB from 'cfb';
import { latin1, type Seed, type FixtureSpec } from './shared.ts';

export const DOC_SEED = {
  mainText: 'Leaky Person',
  assocAuthor: 'LeakAuthorName',
  oleAuthor: 'LeakOleAuthor',
  orphan: 'OrphanFastSaveLeak',
  dataStream: 'DataStreamHyperlinkLeak',
  objectPool: 'ObjectPoolNativeLeak',
  macro: 'MacroModuleLeak',
  revisionAuthor: 'RevAuthorLeak',
  commentOwner: 'CommentOwnerLeak',
  autosavePath: 'C:\\Users\\leakuser\\autosave.asd',
} as const;

export const DOC_MAIN_TEXT = `Call ${DOC_SEED.mainText} now.\r`;

export interface DocFixtureOptions {
  /** Set fComplex (0x0004) and leave unreferenced text bytes in WordDocument. H5. */
  fastSave?: boolean;
  /** Add Data, ObjectPool/_1234/\u0001Ole10Native and Macros/VBA/Module1 streams. H6. */
  extraStreams?: boolean;
  /** SttbfRMark, GrpXstAtnOwners and fcAutosaveSource in the Table stream. M5. */
  revisionAuthors?: boolean;
  /** Set fEncrypted (0x0100). L2. */
  encrypted?: boolean;
}

const FIB_FLAGS = 0x000a;
const F_COMPLEX = 0x0004;
const F_ENCRYPTED = 0x0100;

const TEXT_OFFSET = 0x400;
const ORPHAN_OFFSET = 0x480;
const CLX_OFFSET = 0;
const PLC_CHPX_OFFSET = 0x100;
const PLC_PAPX_OFFSET = 0x110;
const STTBF_OFFSET = 0x120;
const RMARK_OFFSET = 0x160;
const ATN_OFFSET = 0x190;
const AUTOSAVE_OFFSET = 0x1c0;

function putUtf16(view: DataView, off: number, s: string): number {
  for (let i = 0; i < s.length; i++) view.setUint16(off + i * 2, s.charCodeAt(i), true);
  return off + s.length * 2;
}

function putLatin1(bytes: Uint8Array, off: number, s: string): void {
  for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i) & 0xff;
}

/** Extended STTB (0xffff marker) with one UTF-16 string. Returns byte length. */
function putSttb(view: DataView, off: number, s: string): number {
  view.setUint16(off, 0xffff, true);
  view.setUint16(off + 2, 1, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, s.length, true);
  putUtf16(view, off + 8, s);
  return 8 + s.length * 2;
}

/** XST: cch + UTF-16 chars. Returns byte length. */
function putXst(view: DataView, off: number, s: string): number {
  view.setUint16(off, s.length, true);
  putUtf16(view, off + 2, s);
  return 2 + s.length * 2;
}

function summaryInformation(author: string): Uint8Array {
  const si = new Uint8Array(96);
  const sv = new DataView(si.buffer);
  sv.setUint16(0, 0xfffe, true);
  sv.setUint32(24, 1, true);
  sv.setUint32(28 + 16, 48, true);
  sv.setUint32(48, 40, true);
  sv.setUint32(52, 1, true);
  sv.setUint32(56, 4, true); // PIDSI_AUTHOR
  sv.setUint32(60, 16, true);
  sv.setUint32(64, 30, true); // VT_LPSTR
  sv.setUint32(68, author.length + 1, true);
  putLatin1(si, 72, author);
  return si;
}

/** Build a .doc with any combination of the leak scenarios enabled. */
export function buildDocFixture(o: DocFixtureOptions = {}): Uint8Array {
  const mainText = DOC_MAIN_TEXT;
  const wordDoc = new Uint8Array(0x600);
  const wv = new DataView(wordDoc.buffer);

  let flags = 0;
  if (o.fastSave) flags |= F_COMPLEX;
  if (o.encrypted) flags |= F_ENCRYPTED;
  wv.setUint16(0x0000, 0xa5ec, true);
  wv.setUint16(FIB_FLAGS, flags, true);
  wv.setInt32(0x004c, mainText.length, true);
  wv.setInt32(0x00fa, PLC_CHPX_OFFSET, true);
  wv.setInt32(0x00fe, 12, true);
  wv.setInt32(0x0102, PLC_PAPX_OFFSET, true);
  wv.setInt32(0x0106, 12, true);
  putLatin1(wordDoc, TEXT_OFFSET, mainText);
  if (o.fastSave) putLatin1(wordDoc, ORPHAN_OFFSET, DOC_SEED.orphan);

  const table = new Uint8Array(0x200);
  const tv = new DataView(table.buffer);
  const nPieces = 1;
  const lcbPcd = (nPieces + 1) * 4 + nPieces * 8;
  table[CLX_OFFSET] = 0x02;
  tv.setUint32(CLX_OFFSET + 1, lcbPcd, true);
  let off = CLX_OFFSET + 5;
  tv.setInt32(off, 0, true); off += 4;
  tv.setInt32(off, mainText.length, true); off += 4;
  tv.setUint16(off, 0, true); off += 2;
  tv.setUint32(off, (TEXT_OFFSET * 2) | 0x40000000, true); off += 4;
  tv.setUint16(off, 0, true); off += 2;
  wv.setInt32(0x01a2, CLX_OFFSET, true);
  wv.setInt32(0x01a6, 5 + lcbPcd, true);

  for (const plcOff of [PLC_CHPX_OFFSET, PLC_PAPX_OFFSET]) {
    tv.setUint32(plcOff, TEXT_OFFSET, true);
    tv.setUint32(plcOff + 4, TEXT_OFFSET + mainText.length, true);
    tv.setUint32(plcOff + 8, 1, true);
  }

  // SttbfAssoc (0x19a / 0x19e)
  const assocLen = putSttb(tv, STTBF_OFFSET, DOC_SEED.assocAuthor);
  wv.setInt32(0x019a, STTBF_OFFSET, true);
  wv.setInt32(0x019e, assocLen, true);

  if (o.revisionAuthors) {
    const rmarkLen = putSttb(tv, RMARK_OFFSET, DOC_SEED.revisionAuthor);
    wv.setInt32(0x0232, RMARK_OFFSET, true);
    wv.setInt32(0x0236, rmarkLen, true);
    const atnLen = putXst(tv, ATN_OFFSET, DOC_SEED.commentOwner);
    wv.setInt32(0x01ba, ATN_OFFSET, true);
    wv.setInt32(0x01be, atnLen, true);
    const autosaveLen = putXst(tv, AUTOSAVE_OFFSET, DOC_SEED.autosavePath);
    wv.setInt32(0x01b2, AUTOSAVE_OFFSET, true);
    wv.setInt32(0x01b6, autosaveLen, true);
  }

  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, '/WordDocument', wordDoc);
  CFB.utils.cfb_add(container, '/0Table', table);
  CFB.utils.cfb_add(container, '/\u0005SummaryInformation', summaryInformation(DOC_SEED.oleAuthor));
  if (o.extraStreams) {
    CFB.utils.cfb_add(container, '/Data', latin1(`\u0000\u0000${DOC_SEED.dataStream}`));
    CFB.utils.cfb_add(container, '/ObjectPool/_1234/\u0001Ole10Native', latin1(DOC_SEED.objectPool));
    CFB.utils.cfb_add(container, '/Macros/VBA/Module1', latin1(DOC_SEED.macro));
  }
  return new Uint8Array(CFB.write(container, { type: 'array' }) as number[]);
}

const WD = 'Root Entry/WordDocument';
const TBL = 'Root Entry/0Table';

export const DOC_BASE_SEEDS: readonly Seed[] = [
  { needle: DOC_SEED.mainText, part: WD, where: 'main text piece (CP1252 bytes at 0x400)' },
  { needle: DOC_SEED.assocAuthor, part: TBL, where: 'SttbfAssoc (UTF-16LE)' },
  { needle: DOC_SEED.oleAuthor, part: 'Root Entry/\u0005SummaryInformation', where: 'PIDSI_AUTHOR VT_LPSTR' },
];

/** H5: fComplex set, text bytes at 0x480 that no piece references. */
export const buildDocFastSave = (): Uint8Array => buildDocFixture({ fastSave: true });
export const DOC_FASTSAVE_SEEDS: readonly Seed[] = [
  ...DOC_BASE_SEEDS,
  { needle: DOC_SEED.orphan, part: WD, where: 'bytes at 0x480, outside every piece (fast-save remnant)' },
];

/** H6: Data, ObjectPool and Macros streams. */
export const buildDocExtraStreams = (): Uint8Array => buildDocFixture({ extraStreams: true });
export const DOC_EXTRASTREAMS_SEEDS: readonly Seed[] = [
  ...DOC_BASE_SEEDS,
  { needle: DOC_SEED.dataStream, part: 'Root Entry/Data', where: 'raw latin1 bytes' },
  { needle: DOC_SEED.objectPool, part: 'Root Entry/ObjectPool/_1234/\u0001Ole10Native', where: 'raw latin1 bytes' },
  { needle: DOC_SEED.macro, part: 'Root Entry/Macros/VBA/Module1', where: 'raw latin1 bytes' },
];

/** M5: revision author table, comment owner table, autosave path. */
export const buildDocRevisionAuthors = (): Uint8Array => buildDocFixture({ revisionAuthors: true });
export const DOC_REVISIONAUTHORS_SEEDS: readonly Seed[] = [
  ...DOC_BASE_SEEDS,
  { needle: DOC_SEED.revisionAuthor, part: TBL, where: 'SttbfRMark (UTF-16LE)' },
  { needle: DOC_SEED.commentOwner, part: TBL, where: 'GrpXstAtnOwners (UTF-16LE)' },
  { needle: DOC_SEED.autosavePath, part: TBL, where: 'fcAutosaveSource XST (UTF-16LE)' },
];

/** L2: fEncrypted flag set; content is otherwise the plain fixture. */
export const buildDocEncrypted = (): Uint8Array => buildDocFixture({ encrypted: true });
export const DOC_ENCRYPTED_SEEDS: readonly Seed[] = [...DOC_BASE_SEEDS];

/** Everything except fEncrypted. */
export const buildDocEverything = (): Uint8Array => buildDocFixture({ fastSave: true, extraStreams: true, revisionAuthors: true });
export const DOC_EVERYTHING_SEEDS: readonly Seed[] = [
  ...DOC_BASE_SEEDS,
  ...DOC_FASTSAVE_SEEDS.slice(3), ...DOC_EXTRASTREAMS_SEEDS.slice(3), ...DOC_REVISIONAUTHORS_SEEDS.slice(3),
];

/** True when the FIB fEncrypted bit is set in the given .doc bytes. */
export function docIsEncrypted(bytes: Uint8Array): boolean {
  const container = CFB.parse(bytes, { type: 'array' });
  const entry = CFB.find(container, '/WordDocument');
  if (!entry?.content) return false;
  const raw = entry.content as unknown;
  const wd = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
  const view = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
  return (view.getUint16(FIB_FLAGS, true) & F_ENCRYPTED) !== 0;
}

export const DOC_FIXTURES: readonly FixtureSpec[] = [
  { name: 'doc-fastsave', ext: 'doc', findings: ['H5'], build: buildDocFastSave, seeds: DOC_FASTSAVE_SEEDS },
  { name: 'doc-extra-streams', ext: 'doc', findings: ['H6'], build: buildDocExtraStreams, seeds: DOC_EXTRASTREAMS_SEEDS },
  { name: 'doc-revision-authors', ext: 'doc', findings: ['M5'], build: buildDocRevisionAuthors, seeds: DOC_REVISIONAUTHORS_SEEDS },
  { name: 'doc-encrypted', ext: 'doc', findings: ['L2'], build: buildDocEncrypted, seeds: DOC_ENCRYPTED_SEEDS, openable: false },
  { name: 'doc-everything', ext: 'doc', findings: ['H5', 'H6', 'M5'], build: buildDocEverything, seeds: DOC_EVERYTHING_SEEDS },
];
