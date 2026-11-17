import { describe, expect, it } from 'vitest';
import { buildTimeline, type Timeline, type WordTiming } from '@quran/core';
import { createGradientPainter, type BackgroundPainter } from '../src/background';
import { Compositor, type PreparedVerse } from '../src/compositor';
import type { SubtitleStyle } from '../src/types';
import surah2 from '../../../apps/web/public/data/surahs/002.json';

const style: SubtitleStyle = {
  arabicFamily: 'Uthmanic Hafs',
  translationFamily: 'Inter',
  arabicSize: 40,
  translationSize: 20,
  textColor: '#ffffff',
  accentColor: '#facc15',
  mutedColor: '#ffffff80',
  lineHeight: 1.5,
  translationGap: 20,
  marginX: 20,
};

type Operation =
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'gradient' }
  | { op: 'drawImage' }
  | { op: 'measureText'; text: string }
  | { op: 'fillRect'; x: number; y: number; width: number; height: number; fillStyle: string }
  | { op: 'fillText'; text: string; x: number; y: number; font: string; fillStyle: string };

/**
 * jsdom cannot paint, so the canvas here records the calls. The assertions are
 * about order, content and colours — the parts a wrong compositor gets wrong —
 * instead of pixels that no test runner can produce.
 */
function recordingCanvas(charWidth = 10, width = 200, height = 400) {
  const operations: Operation[] = [];
  const ctx = {
    fillStyle: '' as string | CanvasGradient,
    globalAlpha: 1,
    font: '',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    save() {
      operations.push({ op: 'save' });
    },
    restore() {
      operations.push({ op: 'restore' });
    },
    fillRect(x: number, y: number, rectWidth: number, rectHeight: number) {
      operations.push({
        op: 'fillRect',
        x,
        y,
        width: rectWidth,
        height: rectHeight,
        fillStyle: String(this.fillStyle),
      });
    },
    createLinearGradient() {
      operations.push({ op: 'gradient' });
      return { addColorStop() {} };
    },
    drawImage() {
      operations.push({ op: 'drawImage' });
    },
    measureText(text: string) {
      operations.push({ op: 'measureText', text });
      return { width: text.length * charWidth };
    },
    fillText(text: string, x: number, y: number) {
      operations.push({
        op: 'fillText',
        text,
        x,
        y,
        font: this.font,
        fillStyle: String(this.fillStyle),
      });
    },
  };
  const canvas = { width, height, getContext: () => ctx } as unknown as OffscreenCanvas;
  return { canvas, operations, ctx };
}

function background(width = 200, height = 400): BackgroundPainter {
  return createGradientPainter(
    { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
    { width, height },
  );
}

const verse: PreparedVerse = {
  arabic: 'بسم الله',
  translation: 'Au nom de Dieu',
  words: null,
};

function texts(operations: Operation[]) {
  return operations.filter((operation) => operation.op === 'fillText');
}

describe('Compositor', () => {
  it('paints the background, then the veil, and no text during the lead-in', () => {
    const { canvas, operations } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 40 });

    compositor.prepare([verse], buildTimeline([2]));
    compositor.drawAt(0.2);

    const rects = operations.filter((operation) => operation.op === 'fillRect');
    expect(rects).toHaveLength(2);
    expect(rects[1]).toMatchObject({ x: 0, y: 0, width: 200, height: 400 });
    expect((rects[1] as { fillStyle: string }).fillStyle).toBe('rgba(0, 0, 0, 0.4)');
    expect(texts(operations)).toHaveLength(0);
  });

  it('skips the veil entirely when the dimming is zero', () => {
    const { canvas, operations } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 0 });
    compositor.prepare([verse], buildTimeline([2]));
    compositor.drawAt(0.2);

    expect(operations.filter((operation) => operation.op === 'fillRect')).toHaveLength(1);
  });

  it('draws the Arabic verse above its translation once the verse starts', () => {
    const { canvas, operations } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 40 });
    compositor.prepare([verse], buildTimeline([2]));
    compositor.drawAt(1);

    const drawn = texts(operations);
    expect(drawn.map((operation) => operation.text)).toEqual(['بسم الله', 'Au nom de Dieu']);
    expect(drawn[0]).toMatchObject({ x: 100, font: '40px "Uthmanic Hafs"', fillStyle: '#ffffff' });
    expect(drawn[1]).toMatchObject({ x: 100, font: '20px Inter', fillStyle: '#ffffff' });
    expect(drawn[0].y).toBeLessThan(drawn[1].y);
  });

  it('shrinks the longest verse so its translation stays inside the frame', () => {
    const source = surah2.verses.find((candidate) => candidate.number === 282);
    if (!source) throw new Error('fixture: 2:282 is missing from the shipped data');
    const bigStyle: SubtitleStyle = {
      ...style,
      arabicSize: 64,
      translationSize: 30,
      lineHeight: 1.5,
      translationGap: 24,
      marginX: 72,
    };
    const { canvas, operations } = recordingCanvas(20, 1080, 1920);
    const compositor = new Compositor(canvas, bigStyle, background(1080, 1920));
    compositor.prepare(
      [{ arabic: source.arabic, translation: source.translations.fr, words: null }],
      buildTimeline([5]),
    );
    compositor.drawAt(1);

    const drawn = texts(operations);
    expect(drawn.length).toBeGreaterThan(2);
    expect(drawn.every((operation) => operation.y >= 0 && operation.y <= 1920)).toBe(true);
    const arabicFont = drawn.find((operation) => operation.text.includes('ال الذين')) ?? drawn[0];
    expect(Number.parseInt(arabicFont.font, 10)).toBeLessThan(bigStyle.arabicSize);
  });

  it('keeps verses apart: nothing in the gap, then the next verse', () => {
    const { canvas, operations } = recordingCanvas();
    const timeline = buildTimeline([2, 3]);
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 40 });
    compositor.prepare(
      [verse, { arabic: 'الحمد لله', translation: 'Louange à Dieu', words: null }],
      timeline,
    );

    compositor.drawAt(2.8);
    expect(texts(operations)).toHaveLength(0);

    operations.length = 0;
    compositor.drawAt(3.5);
    expect(texts(operations).map((operation) => operation.text)).toEqual([
      'الحمد لله',
      'Louange à Dieu',
    ]);
  });

  it('lays the text out in prepare, not on every frame', () => {
    const { canvas, operations } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 0 });
    compositor.prepare([verse], buildTimeline([2]));

    const measurements = operations.filter((operation) => operation.op === 'measureText').length;
    operations.length = 0;
    compositor.drawAt(1);
    compositor.drawAt(2);

    expect(measurements).toBeGreaterThan(0);
    expect(operations.some((operation) => operation.op === 'measureText')).toBe(false);
  });

  it('colours only the word being recited in word-by-word mode', () => {
    const { canvas, operations } = recordingCanvas();
    const words: WordTiming[] = [
      { word: 'بسم', start: 0.8, end: 1.2 },
      { word: 'الله', start: 1.2, end: 1.6 },
      { word: 'الرحمن', start: 1.6, end: 2 },
    ];
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 0 });
    compositor.prepare([{ ...verse, arabic: 'بسم الله الرحمن', words }], buildTimeline([2]));

    compositor.drawAt(1.3);

    const drawn = texts(operations);
    expect(drawn.map((operation) => [operation.text, operation.fillStyle])).toEqual([
      ['بسم', '#ffffff80'],
      ['الله', '#facc15'],
      ['الرحمن', '#ffffff80'],
      ['Au nom de Dieu', '#ffffff'],
    ]);
  });

  it('mutes every word during the silence between two words', () => {
    const { canvas, operations } = recordingCanvas();
    const words: WordTiming[] = [
      { word: 'بسم', start: 0.8, end: 1.2 },
      { word: 'الله', start: 1.2, end: 1.6 },
      { word: 'الرحمن', start: 1.6, end: 2 },
    ];
    const compositor = new Compositor(canvas, style, background(), { overlayOpacity: 0 });
    compositor.prepare([{ ...verse, arabic: 'بسم الله الرحمن', words }], buildTimeline([2]));

    compositor.drawAt(2.4);

    const arabic = texts(operations).filter((operation) => operation.fillStyle !== '#ffffff');
    expect(arabic.every((operation) => operation.fillStyle === '#ffffff80')).toBe(true);
  });

  it('writes the watermark last, at the bottom', () => {
    const { canvas, operations } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background(), {
      overlayOpacity: 0,
      watermark: 'Quran Studio',
    });
    compositor.prepare([verse], buildTimeline([2]));
    compositor.drawAt(1);

    const drawn = texts(operations);
    expect(drawn.at(-1)).toMatchObject({
      text: 'Quran Studio',
      x: 100,
      y: 380,
      font: '15px Inter',
    });
  });

  it('refuses to draw before prepare, or with a time that is not a number', () => {
    const { canvas } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background());

    expect(() => compositor.drawAt(0)).toThrow(/prepare/);

    compositor.prepare([verse], buildTimeline([2]));
    expect(() => compositor.drawAt(Number.NaN)).toThrow(/time/i);
  });

  it('refuses verses and a timeline that do not describe the same clips', () => {
    const { canvas } = recordingCanvas();
    const compositor = new Compositor(canvas, style, background());

    expect(() => compositor.prepare([verse, verse], buildTimeline([2]))).toThrow(/timeline|verses/i);
  });

  it('refuses a timeline whose clips are out of order', () => {
    const { canvas } = recordingCanvas();
    const timeline: Timeline = {
      entries: [
        { clipIndex: 0, start: 3, end: 4 },
        { clipIndex: 1, start: 0.8, end: 2.8 },
      ],
      totalSec: 4,
    };

    expect(() =>
      new Compositor(canvas, style, background()).prepare([verse, verse], timeline),
    ).toThrow(/order|sorted/i);
  });

  it('refuses word timings that do not match the Arabic words', () => {
    const { canvas, operations } = recordingCanvas(10);
    const words: WordTiming[] = [{ word: 'بسم', start: 0.8, end: 2 }];

    expect(() =>
      new Compositor(canvas, style, background()).prepare(
        [{ ...verse, words }],
        buildTimeline([2]),
      ),
    ).toThrow(/words/i);
    expect(operations.some((operation) => operation.op === 'fillText')).toBe(false);
  });

  it('disposes the background once and stops drawing afterwards', () => {
    const { canvas, operations } = recordingCanvas();
    let disposals = 0;
    const painter: BackgroundPainter = {
      ready: true,
      paint() {},
      dispose() {
        disposals += 1;
      },
    };
    const compositor = new Compositor(canvas, style, painter);
    compositor.prepare([verse], buildTimeline([2]));
    compositor.drawAt(1);

    compositor.dispose();
    compositor.dispose();
    expect(disposals).toBe(1);

    operations.length = 0;
    compositor.drawAt(1);
    expect(operations).toHaveLength(0);
  });

  it('refuses a canvas it cannot paint on', () => {
    expect(
      () =>
        new Compositor(
          { width: 0, height: 400, getContext: () => ({}) } as unknown as OffscreenCanvas,
          style,
          background(),
        ),
    ).toThrow(/width/i);
    expect(
      () =>
        new Compositor(
          { width: 200, height: 400, getContext: () => null } as unknown as OffscreenCanvas,
          style,
          background(),
        ),
    ).toThrow(/2D|context/i);
  });

  it('refuses dimming or a text position outside the frame', () => {
    const { canvas } = recordingCanvas();

    expect(() => new Compositor(canvas, style, background(), { overlayOpacity: 120 })).toThrow(
      /overlayOpacity/,
    );
    expect(() => new Compositor(canvas, style, background(), { centerY: 1.5 })).toThrow(/centerY/);
  });
});
