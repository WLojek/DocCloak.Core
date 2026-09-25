// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { buildTextFromBlocks, selectRedactionBoxes, findSplitTokens, isImageFile } from '../src/dom/ocr.ts';
import type { OcrWord } from '../src/dom/ocr.ts';

const bbox = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

function block(lines: { words: { text: string; bbox: ReturnType<typeof bbox> }[] }[]) {
  return { paragraphs: [{ lines }] };
}

describe('buildTextFromBlocks', () => {
  it('reconstructs text with exact per-word character offsets', () => {
    const { text, words } = buildTextFromBlocks([
      block([
        { words: [{ text: 'John', bbox: bbox(0, 0, 40, 10) }, { text: 'Smith', bbox: bbox(45, 0, 90, 10) }] },
        { words: [{ text: 'john@example.com', bbox: bbox(0, 20, 120, 30) }] },
      ]),
    ]);

    expect(text).toBe('John Smith\njohn@example.com');
    for (const word of words) {
      expect(text.slice(word.start, word.end)).toBe(word.text);
    }
  });

  it('separates blocks with a blank line and skips empty words', () => {
    const { text, words } = buildTextFromBlocks([
      block([{ words: [{ text: 'Invoice', bbox: bbox(0, 0, 50, 10) }, { text: '  ', bbox: bbox(55, 0, 60, 10) }] }]),
      block([{ words: [{ text: '42', bbox: bbox(0, 40, 20, 50) }] }]),
    ]);

    expect(text).toBe('Invoice\n\n42');
    expect(words.map((w) => w.text)).toEqual(['Invoice', '42']);
    expect(text.slice(words[1].start, words[1].end)).toBe('42');
  });

  it('returns empty extraction for no blocks', () => {
    expect(buildTextFromBlocks([])).toEqual({ text: '', words: [] });
  });
});

describe('selectRedactionBoxes', () => {
  const words: OcrWord[] = [
    { text: 'Contact', start: 0, end: 7, bbox: bbox(0, 0, 70, 10) },
    { text: 'John', start: 8, end: 12, bbox: bbox(80, 0, 120, 10) },
    { text: 'Smith', start: 13, end: 18, bbox: bbox(130, 0, 180, 10) },
    { text: 'today', start: 19, end: 24, bbox: bbox(190, 0, 240, 10) },
  ];

  it('selects every word overlapping an entity range', () => {
    // Entity "John Smith" spans chars 8-18
    const boxes = selectRedactionBoxes(words, [{ start: 8, end: 18 }]);
    expect(boxes).toEqual([bbox(80, 0, 120, 10), bbox(130, 0, 180, 10)]);
  });

  it('redacts a word even when the range covers it only partially', () => {
    const boxes = selectRedactionBoxes(words, [{ start: 10, end: 15 }]);
    expect(boxes).toEqual([bbox(80, 0, 120, 10), bbox(130, 0, 180, 10)]);
  });

  it('returns nothing when ranges do not overlap any word', () => {
    expect(selectRedactionBoxes(words, [{ start: 7, end: 8 }])).toEqual([]);
  });
});

// Word boxes as Tesseract returned them for the kit's 04-skan.png (T232):
// "lub adresem t.zielinski@zielinski-kancelaria.pl. Pani numer" was read
// with the dot as a space, and the dot's pixels went into the second box,
// leaving a 1 px gap where real spaces on the line are 4-7 px.
function line(parts: [string, ReturnType<typeof bbox>][], from = 0): OcrWord[] {
  const words: OcrWord[] = [];
  let at = from;
  for (const [text, box] of parts) {
    words.push({ text, start: at, end: at + text.length, bbox: box });
    at += text.length + 1;
  }
  return words;
}

const scanLine = line([
  ['lub', bbox(768, 371, 787, 382)],
  ['adresem', bbox(792, 371, 847, 382)],
  ['t', bbox(852, 372, 856, 382)],
  ['zielinski@zielinski-kancelaria.pl.', bbox(857, 371, 1068, 385)],
  ['Pani', bbox(1074, 371, 1102, 382)],
  ['numer', bbox(1108, 374, 1148, 382)],
]);
const emailRange = { start: scanLine[3].start, end: scanLine[3].end - 1 };

describe('selectRedactionBoxes: tokens OCR split by dropping a character (T232)', () => {
  it('redacts the split-off "t" together with the e-mail', () => {
    expect(selectRedactionBoxes(scanLine, [emailRange])).toEqual([scanLine[2].bbox, scanLine[3].bbox]);
  });

  it('spreads from either half and across a chain of pieces', () => {
    // "anna.maria.nowak@firma.pl": both dots lost, only the first piece detected.
    const chain = line([
      ['mail', bbox(0, 0, 40, 20)],
      ['anna', bbox(47, 5, 80, 20)],
      ['maria', bbox(81, 5, 125, 20)],
      ['nowak@firma.pl', bbox(126, 0, 240, 20)],
      ['ok', bbox(247, 5, 265, 20)],
      ['dalej', bbox(272, 0, 310, 20)],
    ]);
    const boxes = selectRedactionBoxes(chain, [{ start: chain[1].start, end: chain[1].end }]);
    expect(boxes).toEqual([chain[1].bbox, chain[2].bbox, chain[3].bbox]);
  });

  it('keeps ordinary neighbours visible', () => {
    const boxes = selectRedactionBoxes(scanLine, [{ start: scanLine[4].start, end: scanLine[4].end }]);
    expect(boxes).toEqual([scanLine[4].bbox]);
  });
});

describe('findSplitTokens', () => {
  it('joins only the pair whose gap is far below the line\'s typical space', () => {
    expect(findSplitTokens(scanLine)).toEqual([false, false, true, false, false]);
  });

  it('joins boxes that touch or overlap', () => {
    const words = line([
      ['a', bbox(0, 0, 20, 20)], ['b', bbox(26, 0, 40, 20)], ['c', bbox(40, 0, 60, 20)], ['d', bbox(66, 0, 80, 20)],
    ]);
    expect(findSplitTokens(words)).toEqual([false, true, false]);
  });

  it('never joins across a line break', () => {
    // Adjacent in the text (newline) and touching horizontally, but on the next line.
    const words = line([['end', bbox(200, 0, 230, 20)], ['next', bbox(230, 30, 260, 50)]]);
    expect(findSplitTokens(words)).toEqual([false]);
  });

  it('never joins words that are not adjacent in the text', () => {
    const words: OcrWord[] = [
      { text: 'a', start: 0, end: 1, bbox: bbox(0, 0, 20, 20) },
      { text: 'b', start: 5, end: 6, bbox: bbox(20, 0, 40, 20) },
    ];
    expect(findSplitTokens(words)).toEqual([false]);
  });

  it('leaves a box much taller than the line alone (OCR noise)', () => {
    // From the same scan: after the IBAN, "w" came back 26 px tall on an
    // 11 px line, 2 px from "2874".
    const words = line([
      ['1981', bbox(835, 314, 864, 325)],
      ['2874', bbox(871, 314, 903, 325)],
      ['w', bbox(905, 306, 912, 332)],
      ['terminie', bbox(922, 314, 973, 325)],
      ['14', bbox(979, 314, 993, 325)],
    ]);
    expect(findSplitTokens(words)).toEqual([false, false, false, false]);
  });

  it('uses the box height for lines too short to measure their spacing', () => {
    // Two words: typical space = 0.4 x 20 = 8, tight limit = 2.4.
    expect(findSplitTokens(line([['t', bbox(0, 0, 10, 20)], ['x@y.pl', bbox(12, 0, 80, 20)]]))).toEqual([true]);
    expect(findSplitTokens(line([['Jan', bbox(0, 0, 30, 20)], ['Nowak', bbox(37, 0, 90, 20)]]))).toEqual([false]);
  });

  it('handles empty and single-word input', () => {
    expect(findSplitTokens([])).toEqual([]);
    expect(findSplitTokens(line([['solo', bbox(0, 0, 40, 20)]]))).toEqual([]);
  });
});

describe('isImageFile', () => {
  it('accepts common image extensions', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.bmp', 'f.gif']) {
      expect(isImageFile(name)).toBe(true);
    }
  });

  it('rejects documents and unknown extensions', () => {
    for (const name of ['a.docx', 'b.doc', 'c.pdf', 'd.txt', 'e.png.docx']) {
      expect(isImageFile(name)).toBe(false);
    }
  });
});
