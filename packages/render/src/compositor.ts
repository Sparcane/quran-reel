/**
 * Draws one finished frame at a given time: background, veil, Arabic verse,
 * translation, watermark — in that order.
 *
 * The expensive work (wrapping the Arabic verse, measuring every word) happens
 * once in `prepare`. `drawAt` only puts already-laid-out text on the canvas,
 * because the encoder calls it 30 or 60 times per second for up to 15 minutes.
 */

import type { Timeline, WordTiming } from '@quran/core';
import type { BackgroundPainter } from './background';
import { cssFont, layoutArabic, layoutTranslation, type LaidOutText } from './text-layout';
import type { SubtitleStyle } from './types';

/** One verse, ready to draw: its text and, in word mode, its word timings. */
export interface PreparedVerse {
  arabic: string;
  translation: string;
  /** null means the whole verse is shown at once. */
  words: WordTiming[] | null;
}

export interface CompositorOptions {
  /** Strength of the dark veil over the background, 0 to 100 (StudioSettings' unit). */
  overlayOpacity?: number;
  /** Fraction of the frame height where the text block is centred, 0 to 1. */
  centerY?: number;
  /** Small attribution line at the bottom, e.g. the reciter or the app's name. */
  watermark?: string;
}

/** The slice of a 2D context the compositor touches. */
export type CompositorContext = Pick<
  OffscreenCanvasRenderingContext2D,
  | 'fillStyle'
  | 'globalAlpha'
  | 'font'
  | 'direction'
  | 'textAlign'
  | 'textBaseline'
  | 'save'
  | 'restore'
  | 'fillRect'
  | 'fillText'
  | 'measureText'
  | 'createLinearGradient'
  | 'drawImage'
>;

interface WordPlacement {
  word: string;
  x: number;
  y: number;
}

interface PreparedFrame {
  arabic: LaidOutText;
  translation: LaidOutText;
  arabicTop: number;
  translationTop: number;
  /** null in verse mode. */
  words: WordPlacement[] | null;
  timings: WordTiming[] | null;
  start: number;
  end: number;
}

function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`compositor: canvas ${name} must be a positive number, got ${value}`);
  }
}

export class Compositor {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: CompositorContext;
  private readonly style: SubtitleStyle;
  private readonly background: BackgroundPainter;
  private readonly overlayOpacity: number;
  private readonly centerY: number;
  private readonly watermark: string | null;
  private readonly arabicFont: string;
  private readonly translationFont: string;
  private readonly watermarkFont: string;

  private frames: PreparedFrame[] | null = null;
  private disposed = false;

  constructor(
    canvas: OffscreenCanvas,
    style: SubtitleStyle,
    background: BackgroundPainter,
    options: CompositorOptions = {},
  ) {
    requirePositive(canvas.width, 'width');
    requirePositive(canvas.height, 'height');

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('compositor: the canvas has no 2D context to draw on');

    const overlayOpacity = options.overlayOpacity ?? 0;
    if (!Number.isFinite(overlayOpacity) || overlayOpacity < 0 || overlayOpacity > 100) {
      throw new Error('compositor: overlayOpacity must be between 0 and 100');
    }
    const centerY = options.centerY ?? 0.5;
    if (!Number.isFinite(centerY) || centerY < 0 || centerY > 1) {
      throw new Error('compositor: centerY must be a fraction of the frame height, 0 to 1');
    }

    this.canvas = canvas;
    this.ctx = ctx;
    this.style = style;
    this.background = background;
    this.overlayOpacity = overlayOpacity;
    this.centerY = centerY;
    this.watermark = options.watermark?.trim() ? options.watermark.trim() : null;
    this.arabicFont = cssFont(style.arabicFamily, style.arabicSize);
    this.translationFont = cssFont(style.translationFamily, style.translationSize);
    this.watermarkFont = cssFont(
      style.translationFamily,
      Math.round(style.translationSize * 0.75),
    );
  }

  /**
   * Lays every verse out once. `timeline` must describe the same clips in the
   * same order: it is the source of truth for both the picture and the sound.
   */
  prepare(verses: PreparedVerse[], timeline: Timeline): void {
    if (this.disposed) throw new Error('compositor: disposed');
    if (timeline.entries.length !== verses.length) {
      throw new Error(
        `compositor: the timeline has ${timeline.entries.length} entries for ${verses.length} verses`,
      );
    }

    timeline.entries.forEach((entry, index) => {
      if (!Number.isFinite(entry.start) || !Number.isFinite(entry.end) || entry.end < entry.start) {
        throw new Error(`compositor: timeline entry ${index} has unusable bounds`);
      }
      if (index > 0 && entry.start < timeline.entries[index - 1].start) {
        throw new Error('compositor: timeline entries must be in sorted order');
      }
    });

    const frameWidth = this.canvas.width;
    const frameHeight = this.canvas.height;
    const maxWidth = frameWidth - this.style.marginX * 2;
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
      throw new Error('compositor: marginX leaves no room for text in the frame');
    }

    this.frames = verses.map((verse, index) => {
      const entry = timeline.entries.find((candidate) => candidate.clipIndex === index);
      if (!entry) {
        throw new Error(`compositor: the timeline has no entry for verse ${index}`);
      }

      const arabic = layoutArabic(verse.arabic, this.ctx, this.style, maxWidth);
      // The Arabic font is now active on the context, so spaces are measured
      // with the font the Arabic words will be painted in.
      const spaceWidth = this.ctx.measureText(' ').width;
      const translation = layoutTranslation(verse.translation, this.ctx, this.style, maxWidth);

      const hasArabic = arabic.lines.length > 0;
      const hasTranslation = translation.lines.length > 0;
      const gap = hasArabic && hasTranslation ? this.style.translationGap : 0;
      const blockHeight = arabic.totalHeight + gap + translation.totalHeight;
      const arabicTop = frameHeight * this.centerY - blockHeight / 2;
      const translationTop = arabicTop + arabic.totalHeight + gap;

      const words = verse.words
        ? this.placeWords(verse.words, arabic, arabicTop, spaceWidth)
        : null;

      return {
        arabic,
        translation,
        arabicTop,
        translationTop,
        words,
        timings: verse.words,
        start: entry.start,
        end: entry.end,
      };
    });
  }

  /**
   * Right-to-left word positions for word-by-word mode, centred on each line.
   * A word's width is measured, never its character count: Arabic shaping
   * decides it.
   */
  private placeWords(
    timings: WordTiming[],
    arabic: LaidOutText,
    arabicTop: number,
    spaceWidth: number,
  ): WordPlacement[] {
    const words = arabic.lines.flatMap((line) => line.split(' '));
    if (words.length !== timings.length) {
      throw new Error(
        `compositor: ${timings.length} word timings for ${words.length} Arabic words`,
      );
    }

    this.ctx.font = this.arabicFont;
    this.ctx.direction = 'rtl';
    this.ctx.textAlign = 'center';

    const placements: WordPlacement[] = [];
    const frameWidth = this.canvas.width;

    arabic.lines.forEach((line, lineIndex) => {
      const lineWidth = this.ctx.measureText(line).width;
      let cursor = frameWidth / 2 + lineWidth / 2;
      const y = arabicTop + arabic.lineHeight * (lineIndex + 0.5);

      for (const word of line.split(' ')) {
        const wordWidth = this.ctx.measureText(word).width;
        placements.push({ word, x: cursor - wordWidth / 2, y });
        cursor -= wordWidth + spaceWidth;
      }
    });

    return placements;
  }

  drawAt(t: number): void {
    if (this.disposed) return;
    if (!this.frames) throw new Error('compositor: prepare() must run before drawAt()');
    if (!Number.isFinite(t)) throw new Error('compositor: time must be a finite number of seconds');

    const ctx = this.ctx;
    ctx.save();
    this.background.paint(ctx, t);

    if (this.overlayOpacity > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${this.overlayOpacity / 100})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    const frame = this.frameAt(t);
    if (frame) this.drawText(frame, t);
    if (this.watermark) this.drawWatermark();

    ctx.restore();
  }

  /** Sorted, non-overlapping entries make a binary search exact and cheap. */
  private frameAt(t: number): PreparedFrame | null {
    const frames = this.frames;
    if (!frames) return null;

    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const frame = frames[middle];
      if (t < frame.start) {
        high = middle - 1;
      } else if (t >= frame.end) {
        low = middle + 1;
      } else {
        return frame;
      }
    }
    return null;
  }

  private drawText(frame: PreparedFrame, t: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (frame.arabic.lines.length > 0) {
      ctx.font = this.arabicFont;
      ctx.direction = 'rtl';

      if (frame.words) {
        const active = frame.timings
          ? frame.timings.findIndex((word) => t >= word.start && t < word.end)
          : -1;
        frame.words.forEach((placement, index) => {
          ctx.fillStyle = index === active ? this.style.accentColor : this.style.mutedColor;
          ctx.fillText(placement.word, placement.x, placement.y);
        });
      } else {
        ctx.fillStyle = this.style.textColor;
        frame.arabic.lines.forEach((line, index) => {
          ctx.fillText(
            line,
            this.canvas.width / 2,
            frame.arabicTop + frame.arabic.lineHeight * (index + 0.5),
          );
        });
      }
    }

    if (frame.translation.lines.length > 0) {
      ctx.font = this.translationFont;
      ctx.direction = 'ltr';
      ctx.fillStyle = this.style.textColor;
      frame.translation.lines.forEach((line, index) => {
        ctx.fillText(
          line,
          this.canvas.width / 2,
          frame.translationTop + frame.translation.lineHeight * (index + 0.5),
        );
      });
    }
  }

  private drawWatermark(): void {
    if (!this.watermark) return;
    const ctx = this.ctx;
    ctx.font = this.watermarkFont;
    ctx.direction = 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = this.style.textColor;
    ctx.fillText(this.watermark, this.canvas.width / 2, this.canvas.height - this.style.marginX);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frames = null;
    this.background.dispose();
  }
}
