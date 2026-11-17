import { describe, expect, it } from 'vitest';
import surah2 from '../../../apps/web/public/data/surahs/002.json';

// 2:282 (the debt verse) is the longest in the Quran: 1173 characters, 128
// words. 2:286 is much shorter (404 characters). The layout must be proven
// against the real worst case, not a convenient later verse.

import { layoutArabic, layoutTranslation } from '../src/text-layout';
import type { SubtitleStyle } from '../src/types';

/**
 * jsdom has no canvas, and the real one cannot be trusted to measure in a test
 * runner anyway. Every character is 20 px wide, so the expected wrapping is
 * arithmetic rather than a promise about a font.
 */
function fakeCtx(widthPerChar = 20) {
  return {
    font: '',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'start' as CanvasTextAlign,
    measureText: (text: string) => ({ width: text.length * widthPerChar }),
  } as unknown as OffscreenCanvasRenderingContext2D;
}

const style: SubtitleStyle = {
  arabicFamily: 'Uthmanic Hafs',
  translationFamily: 'Inter',
  arabicSize: 64,
  translationSize: 30,
  textColor: '#ffffff',
  accentColor: '#facc15',
  mutedColor: '#ffffff99',
  lineHeight: 1.6,
  translationGap: 24,
  marginX: 72,
};

const longest = surah2.verses.find((verse) => verse.number === 282)?.arabic;
if (!longest) throw new Error('fixture: 2:282 is missing from the shipped data');

describe('layoutArabic', () => {
  it('wraps the longest verse in the Quran into readable lines', () => {
    const ctx = fakeCtx();
    const laidOut = layoutArabic(longest, ctx, style, 900);

    expect(laidOut.lines.length).toBeGreaterThan(2);
    expect(laidOut.lines.every((line) => ctx.measureText(line).width <= 900)).toBe(true);
    expect(laidOut.totalHeight).toBe(laidOut.lines.length * laidOut.lineHeight);
  });

  it('never cuts a word: the lines are the same words, in the same order', () => {
    const laidOut = layoutArabic(longest, fakeCtx(), style, 900);

    expect(laidOut.lines.join(' ')).toBe(longest.split(/\s+/).join(' '));
  });

  it('measures with the Arabic font, right to left and centred', () => {
    const ctx = fakeCtx();

    layoutArabic(longest, ctx, style, 900);

    expect(ctx.font).toBe('64px "Uthmanic Hafs"');
    expect(ctx.direction).toBe('rtl');
    expect(ctx.textAlign).toBe('center');
  });

  it('derives the line height from the Arabic size and the style ratio', () => {
    // 64 px × 1.6 = 102.4 px, rounded to whole pixels.
    expect(layoutArabic('بسم الله', fakeCtx(), style, 900).lineHeight).toBe(102);
  });

  it('returns no lines for empty or whitespace-only text', () => {
    expect(layoutArabic('', fakeCtx(), style, 900).lines).toEqual([]);
    expect(layoutArabic('   \n\t ', fakeCtx(), style, 900).totalHeight).toBe(0);
  });

  it('keeps a single word that is wider than the frame on its own line', () => {
    const laidOut = layoutArabic('الرحمن', fakeCtx(), style, 100);

    expect(laidOut.lines).toEqual(['الرحمن']);
  });

  it('moves a word to the next line instead of overflowing, and fills a line exactly', () => {
    const laidOut = layoutArabic('aaaa bb cc', fakeCtx(), style, 100);

    expect(laidOut.lines).toEqual(['aaaa', 'bb cc']);
  });

  it('normalises runs of whitespace to single spaces', () => {
    const laidOut = layoutArabic('بسم   الله\nالرحمن', fakeCtx(), style, 900);

    expect(laidOut.lines).toEqual(['بسم الله الرحمن']);
  });

  it('refuses an unusable width or line height', () => {
    expect(() => layoutArabic('بسم', fakeCtx(), style, 0)).toThrow(/maxWidth/);
    expect(() => layoutArabic('بسم', fakeCtx(), style, Number.NaN)).toThrow(/maxWidth/);
    expect(() => layoutArabic('بسم', fakeCtx(), { ...style, lineHeight: 0 }, 900)).toThrow(
      /lineHeight/,
    );
  });
});

describe('layoutTranslation', () => {
  const translation = 'In the name of Allah, the Entirely Merciful, the Especially Merciful.';

  it('wraps the translation with its own size and font', () => {
    const ctx = fakeCtx();
    const laidOut = layoutTranslation(translation, ctx, style, 400);

    expect(laidOut.lines.length).toBeGreaterThan(1);
    expect(laidOut.lines.every((line) => ctx.measureText(line).width <= 400)).toBe(true);
    expect(ctx.font).toBe('30px Inter');
    expect(ctx.direction).toBe('ltr');
    expect(ctx.textAlign).toBe('center');
  });

  it('keeps every translation word', () => {
    const laidOut = layoutTranslation(translation, fakeCtx(), style, 200);

    expect(laidOut.lines.join(' ')).toBe(translation);
  });

  it('returns no lines for an empty translation', () => {
    expect(layoutTranslation('', fakeCtx(), style, 400)).toEqual({
      lines: [],
      lineHeight: 48,
      totalHeight: 0,
    });
  });
});
