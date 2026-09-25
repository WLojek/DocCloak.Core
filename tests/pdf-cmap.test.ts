import { describe, it, expect } from 'vitest';
import {
  parseCMap,
  CMapParseError,
  identityCMap,
  predefinedCMap,
  splitCodes,
  cidOf,
  unicodeOf,
  serializeToUnicode,
} from '../src/pdf/cmap.ts';
import type { CMap } from '../src/pdf/cmap.ts';
import { latin1 } from '../src/pdf/lexer.ts';

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

const WORD_TOUNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
3 beginbfchar
<0003> <0020>
<0024> <0041>
<0100> <D83DDE00>
endbfchar
2 beginbfrange
<0044> <0046> <0061>
<0200> <0202> [<0078> <00660069> <D83DDE01>]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

const ONE_BYTE_TOUNICODE = `%!PS-Adobe-3.0 Resource-CMap
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Custom-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
3 beginbfchar
<0C> <00660069>
<41> <0041>
<20> <0020>
endbfchar
1 beginbfrange
<61> <63> <0061>
endbfrange
endcmap
end
end
`;

const CID_CMAP = `%!PS-Adobe-3.0 Resource-CMap
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo 3 dict dup begin
  /Registry (Adobe) def
  /Ordering (Japan1) def
  /Supplement 2 def
end def
/CMapName /Test-CID-V def
/CMapVersion 1.000 def
/CMapType 1 def
/WMode 1 def
2 begincodespacerange
<00> <80>
<8140> <9FFC>
endcodespacerange
2 begincidrange
<20> <7E> 1
<8140> <8150> 633
endcidrange
1 begincidchar
<80> 97
endcidchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;

/** Spec example (ISO 32000-1 9.7.6.3): 1-byte <20>-<7E> plus 2-byte <8140>-<9FFC>. */
const MIXED_CMAP = `begincmap
2 begincodespacerange
<20> <7E>
<8140> <9FFC>
endcodespacerange
1 begincidrange
<8140> <9FFC> 1
endcidrange
endcmap
`;

function plain(cmap: CMap): unknown {
  return {
    codespace: cmap.codespace,
    cid: cmap.cidMap ? [...cmap.cidMap].sort((a, b) => a[0] - b[0]) : null,
    unicode: cmap.unicodeMap ? [...cmap.unicodeMap].sort((a, b) => a[0] - b[0]) : null,
    vertical: cmap.vertical,
    name: cmap.name,
    lengths: [...cmap.codeLengths].sort(),
  };
}

describe('parseCMap: ToUnicode', () => {
  it('parses a Word/Chrome-style 2-byte ToUnicode with bfchar, bfrange, array form and surrogates', () => {
    const cmap = parseCMap(bytes(WORD_TOUNICODE));
    expect(cmap.name).toBe('Adobe-Identity-UCS');
    expect(cmap.vertical).toBe(false);
    expect(cmap.codespace).toEqual([{ numBytes: 2, low: 0, high: 0xffff }]);
    expect([...cmap.codeLengths]).toEqual([2]);
    expect(cmap.cidMap).toBeNull();
    expect(unicodeOf(cmap, 0x0003)).toBe(' ');
    expect(unicodeOf(cmap, 0x0024)).toBe('A');
    expect(unicodeOf(cmap, 0x0100)).toBe('\u{1F600}');
    expect(unicodeOf(cmap, 0x0044)).toBe('a');
    expect(unicodeOf(cmap, 0x0045)).toBe('b');
    expect(unicodeOf(cmap, 0x0046)).toBe('c');
    expect(unicodeOf(cmap, 0x0200)).toBe('x');
    expect(unicodeOf(cmap, 0x0201)).toBe('fi');
    expect(unicodeOf(cmap, 0x0202)).toBe('\u{1F601}');
    expect(unicodeOf(cmap, 0x0203)).toBeUndefined();
    expect(unicodeOf(cmap, 0x0047)).toBeUndefined();
    expect(cmap.unicodeMap?.size).toBe(9);
  });

  it('parses a 1-byte ToUnicode with a ligature destination', () => {
    const cmap = parseCMap(bytes(ONE_BYTE_TOUNICODE));
    expect(cmap.codespace).toEqual([{ numBytes: 1, low: 0, high: 0xff }]);
    expect(unicodeOf(cmap, 0x0c)).toBe('fi');
    expect(unicodeOf(cmap, 0x41)).toBe('A');
    expect(unicodeOf(cmap, 0x20)).toBe(' ');
    expect(unicodeOf(cmap, 0x62)).toBe('b');
    expect(splitCodes(cmap, Uint8Array.from([0x0c, 0x41, 0x20]))).toEqual([
      { code: 0x0c, length: 1, offset: 0 },
      { code: 0x41, length: 1, offset: 1 },
      { code: 0x20, length: 1, offset: 2 },
    ]);
  });

  it('derives codespace ranges from the code lengths when the section is missing', () => {
    const cmap = parseCMap(bytes('begincmap\n2 beginbfchar\n<0041> <0041>\n<0042> <0042>\nendbfchar\nendcmap\n'));
    expect(cmap.codespace).toEqual([{ numBytes: 2, low: 0, high: 0xffff }]);
    expect(splitCodes(cmap, Uint8Array.from([0x00, 0x41, 0x00, 0x42]))).toEqual([
      { code: 0x41, length: 2, offset: 0 },
      { code: 0x42, length: 2, offset: 2 },
    ]);
  });

  it('treats a 1-byte destination as a single code unit and an empty one as no text', () => {
    const cmap = parseCMap(bytes('1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <41> <02> <> endbfchar'));
    expect(unicodeOf(cmap, 1)).toBe('A');
    expect(unicodeOf(cmap, 2)).toBe('');
  });
});

describe('parseCMap: CID CMaps', () => {
  it('parses cidrange / cidchar, WMode and a PostScript-style CIDSystemInfo', () => {
    const cmap = parseCMap(bytes(CID_CMAP));
    expect(cmap.name).toBe('Test-CID-V');
    expect(cmap.vertical).toBe(true);
    expect(cmap.unicodeMap).toBeNull();
    expect(cmap.codespace).toEqual([
      { numBytes: 1, low: 0x00, high: 0x80 },
      { numBytes: 2, low: 0x8140, high: 0x9ffc },
    ]);
    expect([...cmap.codeLengths].sort()).toEqual([1, 2]);
    expect(cidOf(cmap, 0x20)).toBe(1);
    expect(cidOf(cmap, 0x7e)).toBe(1 + (0x7e - 0x20));
    expect(cidOf(cmap, 0x8140)).toBe(633);
    expect(cidOf(cmap, 0x8150)).toBe(633 + 0x10);
    expect(cidOf(cmap, 0x80)).toBe(97);
    expect(cidOf(cmap, 0x1f)).toBe(0);
    expect(cidOf(cmap, 0x8151)).toBe(0);
  });

  it('splits a mixed 1/2-byte string per the spec example', () => {
    const cmap = parseCMap(bytes(MIXED_CMAP));
    // "A" (1 byte), <8140> (2 bytes), "z" (1 byte), <9FFC> (2 bytes)
    const input = Uint8Array.from([0x41, 0x81, 0x40, 0x7a, 0x9f, 0xfc]);
    expect(splitCodes(cmap, input)).toEqual([
      { code: 0x41, length: 1, offset: 0 },
      { code: 0x8140, length: 2, offset: 1 },
      { code: 0x7a, length: 1, offset: 3 },
      { code: 0x9ffc, length: 2, offset: 4 },
    ]);
    expect(cidOf(cmap, 0x8140)).toBe(1);
    expect(cidOf(cmap, 0x41)).toBe(0);
  });

  it('uses the shortest partially matching range for invalid codes, else 1 byte', () => {
    const cmap = parseCMap(bytes(MIXED_CMAP));
    // <8100>: first byte 0x81 partially matches the 2-byte range -> 2 bytes consumed.
    expect(splitCodes(cmap, Uint8Array.from([0x81, 0x00, 0x41]))).toEqual([
      { code: 0x8100, length: 2, offset: 0 },
      { code: 0x41, length: 1, offset: 2 },
    ]);
    // <FF>: no range matches on the first byte -> 1 byte.
    expect(splitCodes(cmap, Uint8Array.from([0xff, 0x41]))).toEqual([
      { code: 0xff, length: 1, offset: 0 },
      { code: 0x41, length: 1, offset: 1 },
    ]);
    // Truncated 2-byte code at the end of the string takes the remaining byte.
    expect(splitCodes(cmap, Uint8Array.from([0x41, 0x81]))).toEqual([
      { code: 0x41, length: 1, offset: 0 },
      { code: 0x81, length: 1, offset: 1 },
    ]);
  });

  it('falls back to a single known code length when codespace is empty', () => {
    const cmap: CMap = { codespace: [], cidMap: null, unicodeMap: null, vertical: false, codeLengths: new Set([2]) };
    expect(splitCodes(cmap, Uint8Array.from([0x00, 0x41, 0x00, 0x42]))).toEqual([
      { code: 0x41, length: 2, offset: 0 },
      { code: 0x42, length: 2, offset: 2 },
    ]);
    const empty: CMap = { codespace: [], cidMap: null, unicodeMap: null, vertical: false, codeLengths: new Set() };
    expect(splitCodes(empty, Uint8Array.from([0x41, 0x42]))).toEqual([
      { code: 0x41, length: 1, offset: 0 },
      { code: 0x42, length: 1, offset: 1 },
    ]);
  });
});

describe('parseCMap: errors', () => {
  it('refuses usecmap', () => {
    const src = 'begincmap\n/90ms-RKSJ-H usecmap\n1 begincidrange <20> <7E> 1 endcidrange\nendcmap\n';
    expect(() => parseCMap(bytes(src))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes(src))).toThrow('usecmap not supported');
  });

  it('throws on unbalanced sections', () => {
    expect(() => parseCMap(bytes('begincmap 1 beginbfchar <01> <0041> endcmap'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('begincmap 1 beginbfchar <01> <0041>'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('begincmap <01> <0041> endbfchar endcmap'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('begincmap 1 beginbfchar <01> endbfchar endcmap'))).toThrow(CMapParseError);
    // A missing endcmap is tolerated, as pdf.js keeps what it has read.
    expect(parseCMap(bytes('begincmap 1 beginbfchar <01> <0041> endbfchar')).unicodeMap?.get(1)).toBe('A');
  });

  it('throws on odd tokens inside a section', () => {
    expect(() => parseCMap(bytes('1 begincidrange <20> <7E> /x endcidrange'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('1 beginbfchar <01> 65 endbfchar'))).toThrow(CMapParseError);
    // Bounds of different byte lengths take the longer length (pdf.js).
    expect(parseCMap(bytes('1 beginbfrange <01> <0002> <0041> endbfrange')).unicodeMap?.get(2)).toBe('B');
    expect(() => parseCMap(bytes('1 beginbfrange <05> <01> <0041> endbfrange'))).toThrow(CMapParseError);
    // A short destination array maps what is there (pdf.js); the rest stays unmapped.
    const short = parseCMap(bytes('1 beginbfrange <01> <03> [<0041> <0042>] endbfrange')).unicodeMap;
    expect([short?.get(1), short?.get(2), short?.get(3)]).toEqual(['A', 'B', undefined]);
    expect(() => parseCMap(bytes('1 beginbfchar <01> <0041 endbfchar'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('1 beginbfchar <0102030405> <0041> endbfchar'))).toThrow(CMapParseError);
  });

  it('throws on ranges larger than 65536 entries', () => {
    expect(() => parseCMap(bytes('1 begincidrange <00000000> <00010000> 0 endcidrange'))).toThrow(CMapParseError);
    expect(() => parseCMap(bytes('1 beginbfrange <00000000> <00FFFFFF> <0041> endbfrange'))).toThrow(CMapParseError);
    // Exactly 65536 entries is still allowed.
    const ok = parseCMap(bytes('1 begincidrange <0000> <FFFF> 0 endcidrange'));
    expect(ok.cidMap?.size).toBe(65536);
  });
});

describe('serializeToUnicode', () => {
  it('round-trips a 2-byte ToUnicode map', () => {
    const original = parseCMap(bytes(WORD_TOUNICODE));
    const entries = [...original.unicodeMap!].map(([code, unicode]) => ({ code, length: 2, unicode }));
    const out = serializeToUnicode(entries, { name: original.name });
    const again = parseCMap(out);
    expect(plain(again)).toEqual(plain(original));
    expect(plain(parseCMap(serializeToUnicode(entries, { name: original.name })))).toEqual(plain(original));
  });

  it('round-trips a 1-byte ToUnicode map', () => {
    const original = parseCMap(bytes(ONE_BYTE_TOUNICODE));
    const entries = [...original.unicodeMap!].map(([code, unicode]) => ({ code, length: 1, unicode }));
    const again = parseCMap(serializeToUnicode(entries, { name: original.name }));
    expect(plain(again)).toEqual(plain(original));
  });

  it('writes a well-formed, deterministic CMap with grouped bfchar sections and surrogates', () => {
    const entries = [];
    for (let i = 0; i < 205; i++) entries.push({ code: 0x1000 + i, length: 2, unicode: String.fromCharCode(0x41 + (i % 26)) });
    entries.push({ code: 0x0005, length: 2, unicode: '\u{1F600}' });
    entries.push({ code: 0x0006, length: 2, unicode: '' });
    const text = latin1(serializeToUnicode(entries.slice().reverse()));
    expect(text).toBe(latin1(serializeToUnicode(entries)));
    expect(text).toContain('/CIDInit /ProcSet findresource begin');
    expect(text).toContain('/CMapName /DocCloak-ToUnicode def');
    expect(text).toContain('/CMapType 2 def');
    expect(text).toContain('1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange');
    expect(text).toContain('<0005> <D83DDE00>');
    expect(text).not.toContain('<0006>'); // empty destinations are left out
    expect(text.match(/beginbfchar/g)?.length).toBe(3);
    expect(text).toContain('100 beginbfchar');
    expect(text).toContain('6 beginbfchar');
    expect(text.indexOf('<0005>')).toBeLessThan(text.indexOf('<1000>'));
    expect(text).toContain('endcmap');
    const back = parseCMap(bytes(text));
    expect(back.unicodeMap?.size).toBe(206); // the empty destination is left out
    expect(unicodeOf(back, 0x0005)).toBe('\u{1F600}');
    expect(unicodeOf(back, 0x10cc)).toBe(String.fromCharCode(0x41 + (204 % 26)));
  });

  it('writes one codespace range per code length', () => {
    const text = latin1(serializeToUnicode([
      { code: 0x41, length: 1, unicode: 'A' },
      { code: 0x0042, length: 2, unicode: 'B' },
    ]));
    expect(text).toContain('2 begincodespacerange\n<00> <FF>\n<0000> <FFFF>\nendcodespacerange');
    expect(text).toContain('<41> <0041>\n<0042> <0042>');
  });

  it('rejects codes that do not fit their length', () => {
    expect(() => serializeToUnicode([{ code: 0x100, length: 1, unicode: 'A' }])).toThrow(CMapParseError);
    expect(() => serializeToUnicode([{ code: 1, length: 5, unicode: 'A' }])).toThrow(CMapParseError);
  });
});

describe('identity CMaps', () => {
  it('splits 2 bytes per code and maps CIDs as identity', () => {
    const h = identityCMap(false);
    expect(h.vertical).toBe(false);
    expect(h.cidMap).toBeNull();
    expect(h.unicodeMap).toBeNull();
    expect(splitCodes(h, Uint8Array.from([0x00, 0x24, 0x12, 0x34, 0xff, 0xff]))).toEqual([
      { code: 0x0024, length: 2, offset: 0 },
      { code: 0x1234, length: 2, offset: 2 },
      { code: 0xffff, length: 2, offset: 4 },
    ]);
    expect(cidOf(h, 0x1234)).toBe(0x1234);
    expect(unicodeOf(h, 0x1234)).toBeUndefined();
    expect(identityCMap(true).vertical).toBe(true);
  });

  it('exposes only Identity-H / Identity-V as predefined', () => {
    expect(predefinedCMap('Identity-H')?.vertical).toBe(false);
    expect(predefinedCMap('Identity-V')?.vertical).toBe(true);
    expect(predefinedCMap('Identity-H')?.name).toBe('Identity-H');
    expect(predefinedCMap('90ms-RKSJ-H')).toBeUndefined();
    expect(predefinedCMap('UniGB-UCS2-H')).toBeUndefined();
  });
});
