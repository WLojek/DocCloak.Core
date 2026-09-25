import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  STANDARD_ENCODING,
  WIN_ANSI_ENCODING,
  MAC_ROMAN_ENCODING,
  MAC_EXPERT_ENCODING,
  PDF_DOC_ENCODING,
  SYMBOL_ENCODING,
  ZAPF_DINGBATS_ENCODING,
  encodingByName,
} from '../src/pdf/encodings.ts';
import type { EncodingTable } from '../src/pdf/encodings.ts';
import { glyphNameToUnicode, unicodeToGlyphName } from '../src/pdf/glyphlist.ts';

/** code -> expected glyph name (undefined = no glyph at that code). */
type Expectations = Record<number, string | undefined>;

function expectCodes(table: EncodingTable, expected: Expectations): void {
  for (const [code, name] of Object.entries(expected)) {
    expect(table[Number(code)], `code 0x${Number(code).toString(16)}`).toBe(name);
  }
}

const ALL_TABLES: Record<string, EncodingTable> = {
  Standard: STANDARD_ENCODING,
  WinAnsi: WIN_ANSI_ENCODING,
  MacRoman: MAC_ROMAN_ENCODING,
  MacExpert: MAC_EXPERT_ENCODING,
  PDFDoc: PDF_DOC_ENCODING,
  Symbol: SYMBOL_ENCODING,
  ZapfDingbats: ZAPF_DINGBATS_ENCODING,
};

describe('pdf encodings - table shape', () => {
  it('every table has 256 entries and no glyph below 0x20 (PDFDoc: accents at 0x18..0x1F)', () => {
    for (const [name, table] of Object.entries(ALL_TABLES)) {
      expect(table.length, name).toBe(256);
      const low = name === 'PDFDoc' ? 0x18 : 0x20;
      for (let c = 0; c < low; c++) expect(table[c], `${name} 0x${c.toString(16)}`).toBeUndefined();
      expect(table[0x20], name).toBe('space');
      expect(table[0x7f], name).toBe(name === 'WinAnsi' ? 'bullet' : undefined);
    }
  });

  it('every glyph name in every table resolves to Unicode through the glyph list', () => {
    for (const [name, table] of Object.entries(ALL_TABLES)) {
      for (let c = 0; c < 256; c++) {
        const glyph = table[c];
        if (glyph === undefined) continue;
        expect(glyphNameToUnicode(glyph), `${name} 0x${c.toString(16)} ${glyph}`).toBeDefined();
      }
    }
  });

  it('ASCII range is shared by the Latin tables except the quote/grave slots', () => {
    for (let c = 0x20; c < 0x7f; c++) {
      if (c === 0x27 || c === 0x60) continue;
      const w = WIN_ANSI_ENCODING[c];
      expect(STANDARD_ENCODING[c]).toBe(w);
      expect(MAC_ROMAN_ENCODING[c]).toBe(w);
      expect(PDF_DOC_ENCODING[c]).toBe(w);
    }
    expect(STANDARD_ENCODING[0x27]).toBe('quoteright');
    expect(STANDARD_ENCODING[0x60]).toBe('quoteleft');
    for (const t of [WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING, PDF_DOC_ENCODING]) {
      expect(t[0x27]).toBe('quotesingle');
      expect(t[0x60]).toBe('grave');
    }
  });

  it('encodingByName resolves the four predefined names only', () => {
    expect(encodingByName('StandardEncoding')).toBe(STANDARD_ENCODING);
    expect(encodingByName('WinAnsiEncoding')).toBe(WIN_ANSI_ENCODING);
    expect(encodingByName('MacRomanEncoding')).toBe(MAC_ROMAN_ENCODING);
    expect(encodingByName('MacExpertEncoding')).toBe(MAC_EXPERT_ENCODING);
    expect(encodingByName('PDFDocEncoding')).toBeUndefined();
    expect(encodingByName('Identity-H')).toBeUndefined();
    expect(encodingByName('')).toBeUndefined();
  });
});

describe('pdf encodings - Annex D.2 Latin tables', () => {
  it('StandardEncoding', () => {
    expectCodes(STANDARD_ENCODING, {
      0x27: 'quoteright', 0x60: 'quoteleft', 0x80: undefined, 0xa0: undefined,
      0xa1: 'exclamdown', 0xa2: 'cent', 0xa4: 'fraction', 0xa5: 'yen', 0xa6: 'florin',
      0xa8: 'currency', 0xa9: 'quotesingle', 0xaa: 'quotedblleft', 0xab: 'guillemotleft',
      0xac: 'guilsinglleft', 0xae: 'fi', 0xaf: 'fl', 0xb0: undefined, 0xb1: 'endash',
      0xb2: 'dagger', 0xb4: 'periodcentered', 0xb5: undefined, 0xb7: 'bullet',
      0xb8: 'quotesinglbase', 0xba: 'quotedblright', 0xbc: 'ellipsis', 0xbd: 'perthousand',
      0xbf: 'questiondown', 0xc0: undefined, 0xc1: 'grave', 0xc2: 'acute', 0xc8: 'dieresis',
      0xc9: undefined, 0xca: 'ring', 0xcd: 'hungarumlaut', 0xcf: 'caron', 0xd0: 'emdash',
      0xd1: undefined, 0xe1: 'AE', 0xe3: 'ordfeminine', 0xe8: 'Lslash', 0xe9: 'Oslash',
      0xea: 'OE', 0xeb: 'ordmasculine', 0xf1: 'ae', 0xf5: 'dotlessi', 0xf8: 'lslash',
      0xf9: 'oslash', 0xfa: 'oe', 0xfb: 'germandbls', 0xff: undefined,
    });
  });

  it('WinAnsiEncoding (unused codes above 0x20 are bullet, 0xA0 space, 0xAD hyphen)', () => {
    expectCodes(WIN_ANSI_ENCODING, {
      0x27: 'quotesingle', 0x60: 'grave', 0x7f: 'bullet', 0x80: 'Euro', 0x81: 'bullet',
      0x82: 'quotesinglbase', 0x83: 'florin', 0x84: 'quotedblbase', 0x85: 'ellipsis',
      0x86: 'dagger', 0x88: 'circumflex', 0x89: 'perthousand', 0x8a: 'Scaron',
      0x8b: 'guilsinglleft', 0x8c: 'OE', 0x8d: 'bullet', 0x8e: 'Zcaron', 0x8f: 'bullet',
      0x90: 'bullet', 0x91: 'quoteleft', 0x92: 'quoteright', 0x93: 'quotedblleft',
      0x94: 'quotedblright', 0x95: 'bullet', 0x96: 'endash', 0x97: 'emdash', 0x98: 'tilde',
      0x99: 'trademark', 0x9a: 'scaron', 0x9c: 'oe', 0x9d: 'bullet', 0x9e: 'zcaron',
      0x9f: 'Ydieresis', 0xa0: 'space', 0xa4: 'currency', 0xa6: 'brokenbar', 0xa9: 'copyright',
      0xad: 'hyphen', 0xae: 'registered', 0xb5: 'mu', 0xb7: 'periodcentered', 0xbd: 'onehalf',
      0xc0: 'Agrave', 0xd0: 'Eth', 0xd7: 'multiply', 0xde: 'Thorn', 0xdf: 'germandbls',
      0xf0: 'eth', 0xf7: 'divide', 0xfe: 'thorn', 0xff: 'ydieresis',
    });
    // Footnote 1: only 0x95 is *assigned* to bullet, the others are unused codes mapped to it.
    const bullets = [];
    for (let c = 0x7f; c < 0xa0; c++) if (WIN_ANSI_ENCODING[c] === 'bullet') bullets.push(c);
    expect(bullets).toEqual([0x7f, 0x81, 0x8d, 0x8f, 0x90, 0x95, 0x9d]);
  });

  it('MacRomanEncoding (0xCA space, 0xDB currency)', () => {
    expectCodes(MAC_ROMAN_ENCODING, {
      0x27: 'quotesingle', 0x60: 'grave', 0x7f: undefined, 0x80: 'Adieresis', 0x81: 'Aring',
      0x83: 'Eacute', 0x87: 'aacute', 0x8e: 'eacute', 0x9f: 'udieresis', 0xa0: 'dagger',
      0xa1: 'degree', 0xa4: 'section', 0xa5: 'bullet', 0xa7: 'germandbls', 0xa8: 'registered',
      0xaa: 'trademark', 0xab: 'acute', 0xac: 'dieresis', 0xae: 'AE', 0xaf: 'Oslash',
      0xb1: 'plusminus', 0xb4: 'yen', 0xb5: 'mu', 0xbb: 'ordfeminine', 0xbc: 'ordmasculine',
      0xbe: 'ae', 0xbf: 'oslash', 0xc0: 'questiondown', 0xc1: 'exclamdown', 0xc2: 'logicalnot',
      0xc4: 'florin', 0xc7: 'guillemotleft', 0xc9: 'ellipsis', 0xca: 'space', 0xcb: 'Agrave',
      0xce: 'OE', 0xcf: 'oe', 0xd0: 'endash', 0xd1: 'emdash', 0xd2: 'quotedblleft',
      0xd3: 'quotedblright', 0xd4: 'quoteleft', 0xd5: 'quoteright', 0xd6: 'divide',
      0xd8: 'ydieresis', 0xd9: 'Ydieresis', 0xda: 'fraction', 0xdb: 'currency',
      0xdc: 'guilsinglleft', 0xde: 'fi', 0xdf: 'fl', 0xe0: 'daggerdbl', 0xe1: 'periodcentered',
      0xe4: 'perthousand', 0xe5: 'Acircumflex', 0xf4: 'Ugrave', 0xf5: 'dotlessi',
      0xf6: 'circumflex', 0xf8: 'macron', 0xfd: 'hungarumlaut', 0xfe: 'ogonek', 0xff: 'caron',
    });
    // Mac OS Roman characters on codes Annex D leaves unassigned (viewer-compatible fill).
    expectCodes(MAC_ROMAN_ENCODING, { 0xad: 'notequal', 0xb9: 'pi', 0xc6: 'Delta', 0xf0: 'apple' });
  });

  it('PDFDocEncoding (D.2 PDF column + D.3)', () => {
    expectCodes(PDF_DOC_ENCODING, {
      0x17: undefined, 0x18: 'breve', 0x19: 'caron', 0x1a: 'circumflex', 0x1b: 'dotaccent',
      0x1c: 'hungarumlaut', 0x1d: 'ogonek', 0x1e: 'ring', 0x1f: 'tilde', 0x27: 'quotesingle',
      0x60: 'grave', 0x7f: undefined, 0x80: 'bullet', 0x81: 'dagger', 0x82: 'daggerdbl',
      0x83: 'ellipsis', 0x84: 'emdash', 0x85: 'endash', 0x86: 'florin', 0x87: 'fraction',
      0x88: 'guilsinglleft', 0x89: 'guilsinglright', 0x8a: 'minus', 0x8b: 'perthousand',
      0x8c: 'quotedblbase', 0x8d: 'quotedblleft', 0x8e: 'quotedblright', 0x8f: 'quoteleft',
      0x90: 'quoteright', 0x91: 'quotesinglbase', 0x92: 'trademark', 0x93: 'fi', 0x94: 'fl',
      0x95: 'Lslash', 0x96: 'OE', 0x97: 'Scaron', 0x98: 'Ydieresis', 0x99: 'Zcaron',
      0x9a: 'dotlessi', 0x9b: 'lslash', 0x9c: 'oe', 0x9d: 'scaron', 0x9e: 'zcaron',
      0x9f: undefined, 0xa0: 'Euro', 0xa1: 'exclamdown', 0xa4: 'currency', 0xa6: 'brokenbar',
      0xad: undefined, 0xb5: 'mu', 0xb7: 'periodcentered', 0xc0: 'Agrave', 0xd0: 'Eth',
      0xd7: 'multiply', 0xdf: 'germandbls', 0xf0: 'eth', 0xf7: 'divide', 0xff: 'ydieresis',
    });
  });

  it('MacExpertEncoding (Annex D.4)', () => {
    expectCodes(MAC_EXPERT_ENCODING, {
      0x21: 'exclamsmall', 0x22: 'Hungarumlautsmall', 0x23: 'centoldstyle', 0x27: 'Acutesmall',
      0x2f: 'fraction', 0x30: 'zerooldstyle', 0x39: 'nineoldstyle', 0x3d: 'threequartersemdash',
      0x3f: 'questionsmall', 0x44: 'Ethsmall', 0x47: 'onequarter', 0x4f: 'twothirds', 0x56: 'ff',
      0x57: 'fi', 0x58: 'fl', 0x59: 'ffi', 0x5a: 'ffl', 0x5e: 'Circumflexsmall', 0x61: 'Asmall',
      0x7a: 'Zsmall', 0x7b: 'colonmonetary', 0x7e: 'Tildesmall', 0x7f: undefined, 0x81: 'asuperior',
      0x87: 'Aacutesmall', 0x9f: 'Udieresissmall', 0xa1: 'eightsuperior', 0xa7: 'Scaronsmall',
      0xb9: 'Thornsmall', 0xba: undefined, 0xbd: 'Zcaronsmall', 0xbe: 'AEsmall', 0xc1: 'oneinferior',
      0xc2: 'Lslashsmall', 0xc9: 'Cedillasmall', 0xcf: 'OEsmall', 0xd0: 'figuredash',
      0xd8: 'Ydieresissmall', 0xda: 'onesuperior', 0xe2: 'zerosuperior', 0xe4: 'esuperior',
      0xf1: 'lsuperior', 0xf2: 'Ogoneksmall', 0xf4: 'Macronsmall', 0xfa: 'Dotaccentsmall',
      0xfb: 'Ringsmall', 0xfc: undefined, 0xff: undefined,
    });
  });
});

describe('pdf encodings - Annex D.5 / D.6 symbolic tables', () => {
  it('Symbol', () => {
    expectCodes(SYMBOL_ENCODING, {
      0x22: 'universal', 0x24: 'existential', 0x27: 'suchthat', 0x2a: 'asteriskmath', 0x2d: 'minus',
      0x40: 'congruent', 0x41: 'Alpha', 0x44: 'Delta', 0x46: 'Phi', 0x4a: 'theta1', 0x57: 'Omega',
      0x5c: 'therefore', 0x5e: 'perpendicular', 0x60: 'radicalex', 0x61: 'alpha', 0x6a: 'phi1',
      0x76: 'omega1', 0x7e: 'similar', 0x7f: undefined, 0xa0: 'Euro', 0xa1: 'Upsilon1',
      0xa5: 'infinity', 0xa6: 'florin', 0xab: 'arrowboth', 0xb0: 'degree', 0xb7: 'bullet',
      0xb9: 'notequal', 0xc0: 'aleph', 0xd1: 'gradient', 0xd2: 'registerserif',
      0xd3: 'copyrightserif', 0xd4: 'trademarkserif', 0xd5: 'product', 0xd6: 'radical',
      0xe2: 'registersans', 0xe5: 'summation', 0xf0: undefined, 0xf2: 'integral', 0xff: undefined,
    });
  });

  it('ZapfDingbats', () => {
    expectCodes(ZAPF_DINGBATS_ENCODING, {
      0x20: 'space', 0x21: 'a1', 0x22: 'a2', 0x23: 'a202', 0x27: 'a119', 0x30: 'a105', 0x3d: 'a6',
      0x41: 'a10', 0x42: 'a29', 0x6c: 'a71', 0x6e: 'a73', 0x6f: 'a74', 0x70: 'a203', 0x7e: 'a100',
      0x7f: undefined, 0x80: 'a89', 0x8d: 'a96', 0x8e: undefined, 0xa0: undefined, 0xa1: 'a101',
      0xa8: 'a112', 0xab: 'a109', 0xac: 'a120', 0xf0: undefined, 0xf1: 'a201', 0xfe: 'a191',
      0xff: undefined,
    });
  });
});

describe('pdf encodings - cross-check against the pdf.js tables', () => {
  // pdf.js ships its own transcription of Annex D; a mismatch means one of the two has a typo.
  const require = createRequire(import.meta.url);
  const bundle = readFileSync(require.resolve('pdfjs-dist/build/pdf.worker.mjs'), 'utf8');
  function pdfjsTable(name: string): (string | undefined)[] {
    const m = new RegExp(`^const ${name} = (\\[.*\\]);$`, 'm').exec(bundle);
    if (!m) throw new Error(`pdf.js table ${name} not found in the worker bundle`);
    return (JSON.parse(m[1]) as string[]).map((n) => (n === '' ? undefined : n));
  }
  it.each([
    ['StandardEncoding', STANDARD_ENCODING],
    ['WinAnsiEncoding', WIN_ANSI_ENCODING],
    ['MacRomanEncoding', MAC_ROMAN_ENCODING],
    ['MacExpertEncoding', MAC_EXPERT_ENCODING],
    ['SymbolSetEncoding', SYMBOL_ENCODING],
    ['ZapfDingbatsEncoding', ZAPF_DINGBATS_ENCODING],
  ])('%s matches pdf.js', (name, table) => {
    expect([...table]).toEqual(pdfjsTable(name));
  });
});

describe('pdf glyph list - glyphNameToUnicode', () => {
  it('resolves AGL names', () => {
    expect(glyphNameToUnicode('eacute')).toBe('é');
    expect(glyphNameToUnicode('Eacute')).toBe('É');
    expect(glyphNameToUnicode('a')).toBe('a');
    expect(glyphNameToUnicode('space')).toBe(' ');
    expect(glyphNameToUnicode('quotesingle')).toBe("'");
    expect(glyphNameToUnicode('quoteright')).toBe('’');
    expect(glyphNameToUnicode('quoteleft')).toBe('‘');
    expect(glyphNameToUnicode('grave')).toBe('`');
    expect(glyphNameToUnicode('hyphen')).toBe('-');
    expect(glyphNameToUnicode('sfthyphen')).toBe('­');
    expect(glyphNameToUnicode('softhyphen')).toBe('­');
    expect(glyphNameToUnicode('nbspace')).toBe(' ');
    expect(glyphNameToUnicode('minus')).toBe('−');
    expect(glyphNameToUnicode('endash')).toBe('–');
    expect(glyphNameToUnicode('emdash')).toBe('—');
    expect(glyphNameToUnicode('bullet')).toBe('•');
    expect(glyphNameToUnicode('ellipsis')).toBe('…');
    expect(glyphNameToUnicode('Euro')).toBe('€');
    expect(glyphNameToUnicode('trademark')).toBe('™');
    expect(glyphNameToUnicode('fraction')).toBe('⁄');
    expect(glyphNameToUnicode('onehalf')).toBe('½');
    expect(glyphNameToUnicode('mu')).toBe('µ');
    expect(glyphNameToUnicode('periodcentered')).toBe('·');
    expect(glyphNameToUnicode('germandbls')).toBe('ß');
    expect(glyphNameToUnicode('fi')).toBe('ﬁ');
    expect(glyphNameToUnicode('fl')).toBe('ﬂ');
    expect(glyphNameToUnicode('ff')).toBe('ﬀ');
    expect(glyphNameToUnicode('ffi')).toBe('ﬃ');
    expect(glyphNameToUnicode('ffl')).toBe('ﬄ');
  });

  it('covers Polish, Greek and Cyrillic names', () => {
    const polish: Record<string, string> = {
      aogonek: 'ą', cacute: 'ć', eogonek: 'ę', lslash: 'ł', nacute: 'ń', oacute: 'ó', sacute: 'ś',
      zacute: 'ź', zdotaccent: 'ż', Aogonek: 'Ą', Cacute: 'Ć', Eogonek: 'Ę', Lslash: 'Ł', Nacute: 'Ń',
      Oacute: 'Ó', Sacute: 'Ś', Zacute: 'Ź', Zdotaccent: 'Ż',
    };
    for (const [name, ch] of Object.entries(polish)) expect(glyphNameToUnicode(name), name).toBe(ch);
    expect(glyphNameToUnicode('alpha')).toBe('α');
    expect(glyphNameToUnicode('Omega')).toBe('Ω'); // AGL: Omega is the Ohm sign
    expect(glyphNameToUnicode('Omegagreek')).toBe('Ω');
    expect(glyphNameToUnicode('Delta')).toBe('∆');
    expect(glyphNameToUnicode('theta1')).toBe('ϑ');
    expect(glyphNameToUnicode('sigma1')).toBe('ς');
    expect(glyphNameToUnicode('afii10017')).toBe('А'); // U+0410
    expect(glyphNameToUnicode('afii10065')).toBe('а'); // U+0430
    expect(glyphNameToUnicode('afii10023')).toBe('Ё');
    expect(glyphNameToUnicode('Acyrillic')).toBe('А');
  });

  it('covers Symbol and ZapfDingbats names', () => {
    expect(glyphNameToUnicode('infinity')).toBe('∞');
    expect(glyphNameToUnicode('registerserif')).toBe('');
    expect(glyphNameToUnicode('radicalex')).toBe('');
    expect(glyphNameToUnicode('apple')).toBe('');
    expect(glyphNameToUnicode('a1')).toBe('✁');
    expect(glyphNameToUnicode('a71')).toBe('●');
    expect(glyphNameToUnicode('a191')).toBe('➾');
  });

  it('handles uniXXXX and uXXXX[XX] forms', () => {
    expect(glyphNameToUnicode('uni00E9')).toBe('é');
    expect(glyphNameToUnicode('uni00e9')).toBe('é');
    expect(glyphNameToUnicode('uni0041')).toBe('A');
    expect(glyphNameToUnicode('uni00660069')).toBe('fi');
    expect(glyphNameToUnicode('u1F600')).toBe('\u{1f600}');
    expect(glyphNameToUnicode('u00E9')).toBe('é');
    expect(glyphNameToUnicode('u10FFFF')).toBe('\u{10ffff}');
    expect(glyphNameToUnicode('u110000')).toBeUndefined();
    expect(glyphNameToUnicode('uniD800')).toBeUndefined();
    expect(glyphNameToUnicode('uni00E')).toBeUndefined();
    expect(glyphNameToUnicode('uni00E9F')).toBeUndefined();
    expect(glyphNameToUnicode('unicode')).toBeUndefined();
    expect(glyphNameToUnicode('u12')).toBeUndefined();
    expect(glyphNameToUnicode('uacute')).toBe('ú'); // AGL lookup precedes the u-form
  });

  it('strips suffixes and joins underscore components', () => {
    expect(glyphNameToUnicode('a.sc')).toBe('a');
    expect(glyphNameToUnicode('eacute.alt1')).toBe('é');
    expect(glyphNameToUnicode('uni00E9.swash')).toBe('é');
    expect(glyphNameToUnicode('f_i')).toBe('fi');
    expect(glyphNameToUnicode('f_f_l.liga')).toBe('ffl');
    expect(glyphNameToUnicode('f_g12')).toBeUndefined();
    expect(glyphNameToUnicode('.notdef')).toBeUndefined();
    expect(glyphNameToUnicode('.null')).toBeUndefined();
  });

  it('returns undefined for glyph-index names and unknown names', () => {
    for (const n of ['g12', 'g123', 'G12', 'cid12', 'glyph12', 'gid12', 'index12', '', 'notaglyph', 'Ω']) {
      expect(glyphNameToUnicode(n), n).toBeUndefined();
    }
  });
});

describe('pdf glyph list - unicodeToGlyphName', () => {
  it('maps single code points back to the encodable glyph name', () => {
    expect(unicodeToGlyphName('é')).toBe('eacute');
    expect(unicodeToGlyphName('[')).toBe('bracketleft');
    expect(unicodeToGlyphName('A')).toBe('A');
    expect(unicodeToGlyphName(' ')).toBe('space');
    expect(unicodeToGlyphName(' ')).toBe('nbspace');
    expect(unicodeToGlyphName('­')).toBe('sfthyphen');
    expect(unicodeToGlyphName('-')).toBe('hyphen');
    expect(unicodeToGlyphName("'")).toBe('quotesingle');
    expect(unicodeToGlyphName('’')).toBe('quoteright');
    expect(unicodeToGlyphName('€')).toBe('Euro');
    expect(unicodeToGlyphName('ﬁ')).toBe('fi');
    expect(unicodeToGlyphName('ą')).toBe('aogonek');
    expect(unicodeToGlyphName('Ł')).toBe('Lslash');
    expect(unicodeToGlyphName('ß')).toBe('germandbls');
    expect(unicodeToGlyphName('А')).toBe('Acyrillic'); // ASCII order: Acyrillic precedes afii10017
    expect(unicodeToGlyphName('✁')).toBe('a1');
  });

  it('prefers the names used by the Annex D encodings over other AGL synonyms', () => {
    expect(unicodeToGlyphName('·')).toBe('periodcentered'); // not middot
    expect(unicodeToGlyphName('µ')).toBe('mu'); // not mu1
    expect(unicodeToGlyphName('Ω')).toBe('Omega');
    expect(unicodeToGlyphName('Ω')).toBe('Omegagreek');
  });

  it('returns undefined for empty, multi-code-point or unmapped input', () => {
    expect(unicodeToGlyphName('')).toBeUndefined();
    expect(unicodeToGlyphName('ab')).toBeUndefined();
    expect(unicodeToGlyphName('\u{1f600}')).toBeUndefined();
    expect(unicodeToGlyphName('中')).toBeUndefined();
  });

  it('round-trips every name of the Latin encodings', () => {
    for (const table of [STANDARD_ENCODING, WIN_ANSI_ENCODING, MAC_ROMAN_ENCODING, PDF_DOC_ENCODING]) {
      for (const name of table) {
        if (name === undefined) continue;
        const text = glyphNameToUnicode(name) as string;
        expect(glyphNameToUnicode(unicodeToGlyphName(text) as string), name).toBe(text);
      }
    }
  });
});
