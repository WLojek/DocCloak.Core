// Node canvas factory for the PDF raster fallback in tests, backed by
// @napi-rs/canvas (an optional dependency of pdfjs-dist). Returns undefined
// when the native module is not available so tests can skip rasterization.

import type { CanvasFactory, CanvasHandle } from '../../src/pdf/oracle.ts';

export async function nodeCanvasFactory(): Promise<CanvasFactory | undefined> {
  try {
    const mod = (await import('@napi-rs/canvas')) as unknown as {
      createCanvas: (w: number, h: number) => {
        getContext(kind: '2d'): CanvasRenderingContext2D;
        toBuffer(mime: 'image/png'): Buffer;
        width: number;
        height: number;
      };
    };
    return {
      create(width: number, height: number): CanvasHandle {
        const canvas = mod.createCanvas(Math.max(1, width), Math.max(1, height));
        const context = canvas.getContext('2d');
        return {
          canvas,
          context,
          toPng: async () => new Uint8Array(canvas.toBuffer('image/png')),
          getImageData: () => context.getImageData(0, 0, canvas.width, canvas.height).data,
        };
      },
    };
  } catch {
    return undefined;
  }
}
