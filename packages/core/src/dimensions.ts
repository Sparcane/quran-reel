import type { AspectRatio } from './types';

/** The frame the renderer encodes, in pixels, for each format. */
const DIMENSIONS: Record<AspectRatio, { readonly width: number; readonly height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

export function dimensionsFor(ratio: AspectRatio): { width: number; height: number } {
  const size = DIMENSIONS[ratio];
  if (!size) {
    throw new Error(`dimensionsFor: unknown aspect ratio ${String(ratio)}`);
  }
  return { width: size.width, height: size.height };
}
