/**
 * Lays a verse out on the canvas before anything is drawn.
 *
 * Wrapping is by whole words, measured with the very context that will paint
 * them, because Arabic shaping means a word's width cannot be guessed from its
 * character count. The layout is computed once per verse and reused for every
 * frame; measuring 6236 verses per second would make the encoder impossibly slow.
 */

import type { SubtitleStyle } from './types';

export interface LaidOutText {
  lines: string[];
  lineHeight: number;
  totalHeight: number;
}

/**
 * The slice of a 2D context that measuring and wrapping needs. Keeping it
 * narrow lets the compositor use its own recorded context and lets a test
 * measure without a canvas.
 */
export type TextMeasureContext = Pick<
  OffscreenCanvasRenderingContext2D,
  'font' | 'direction' | 'textAlign' | 'measureText'
>;

/** A family name with spaces must be quoted, or the canvas ignores the font. */
export function cssFont(family: string, size: number): string {
  const quoted = /^[A-Za-z0-9_-]+$/.test(family)
    ? family
    : `"${family.replace(/"/g, '\\"')}"`;
  return `${size}px ${quoted}`;
}

function wrap(
  text: string,
  ctx: TextMeasureContext,
  size: number,
  sizeName: string,
  family: string,
  lineHeightRatio: number,
  direction: CanvasDirection,
  maxWidth: number,
): LaidOutText {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    throw new Error('text-layout: maxWidth must be a finite, positive number of pixels');
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`text-layout: ${sizeName} must be a finite, positive number of pixels`);
  }
  if (!Number.isFinite(lineHeightRatio) || lineHeightRatio <= 0) {
    throw new Error('text-layout: lineHeight must be a finite, positive multiple');
  }

  // Line boxes are whole pixels so the text block lands on the same row in
  // every frame and rounding never accumulates over a 15-minute video.
  const lineHeight = Math.round(size * lineHeightRatio);
  ctx.font = cssFont(family, size);
  ctx.direction = direction;
  ctx.textAlign = 'center';

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current === '') {
      // A word wider than the frame stays on its own line rather than being
      // cut: Arabic letters change shape when they are split.
      current = word;
      continue;
    }
    const candidate = `${current} ${word}`;
    if (ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);

  return { lines, lineHeight, totalHeight: lineHeight * lines.length };
}

export function layoutArabic(
  text: string,
  ctx: TextMeasureContext,
  style: SubtitleStyle,
  maxWidth: number,
): LaidOutText {
  return wrap(
    text,
    ctx,
    style.arabicSize,
    'arabicSize',
    style.arabicFamily,
    style.lineHeight,
    'rtl',
    maxWidth,
  );
}

/** Translations shipped in v1 are French and English, so they read left to right. */
export function layoutTranslation(
  text: string,
  ctx: TextMeasureContext,
  style: SubtitleStyle,
  maxWidth: number,
): LaidOutText {
  return wrap(
    text,
    ctx,
    style.translationSize,
    'translationSize',
    style.translationFamily,
    style.lineHeight,
    'ltr',
    maxWidth,
  );
}
