/**
 * The shared contract of a render, and the checks every encoder must apply
 * before it touches a canvas or a codec.
 *
 * Both render paths — WebCodecs and the MediaRecorder fallback — take the same
 * plan and must refuse the same impossible ones: an empty selection, a timeline
 * that disagrees with the verses, a video over the fifteen-minute ceiling.
 */

import {
  MAX_VIDEO_SECONDS,
  type BackgroundSelection,
  type Timeline,
  type WordTiming,
} from '@quran/core';
import type { BackgroundPainter } from './background';
import type { SubtitleStyle } from './types';

/** The part of an `AudioBuffer` the encoders read. */
export interface PlanarAudio {
  sampleRate: number;
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** One verse in the finished video: its words, its sound, its length. */
export interface VerseClip {
  arabic: string;
  translation: string;
  /** null means the whole verse is shown at once. */
  words: WordTiming[] | null;
  /** Decoded MP3, or null for a silent verse. */
  audio: PlanarAudio | null;
  durationSec: number;
}

/** Everything one render needs. */
export interface EncodePlan {
  width: number;
  height: number;
  fps: 30 | 60;
  verses: VerseClip[];
  style: SubtitleStyle;
  background: BackgroundPainter;
  /** Plain description of `background`, carried across the worker boundary. */
  backgroundSelection?: BackgroundSelection;
  timeline: Timeline;
  /** StudioSettings' 0–100 unit. */
  overlayOpacity?: number;
  centerY?: number;
  watermark?: string;
}

/** 6 Mbps for 1080p-class frames, 3.5 Mbps for 720p — the plan's targets. */
export function videoBitrateFor(width: number, height: number): number {
  return width * height > 1280 * 720 ? 6_000_000 : 3_500_000;
}

/** Thrown when the platform cannot encode the video at all. Task 24 falls back. */
export class EncoderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncoderUnavailableError';
  }
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`encoder: ${name} must be a finite, non-negative number, got ${value}`);
  }
}

/** Refuses a plan no encoder could honour, before any work is done. */
export function validateEncodePlan(plan: EncodePlan): void {
  if (!Number.isInteger(plan.width) || plan.width <= 0) {
    throw new Error(`encoder: width must be a positive whole number, got ${plan.width}`);
  }
  if (!Number.isInteger(plan.height) || plan.height <= 0) {
    throw new Error(`encoder: height must be a positive whole number, got ${plan.height}`);
  }
  if (plan.fps !== 30 && plan.fps !== 60) {
    throw new Error(`encoder: fps must be 30 or 60, got ${plan.fps}`);
  }
  if (plan.verses.length === 0) {
    throw new Error('encoder: there is nothing to render');
  }
  if (plan.timeline.entries.length !== plan.verses.length) {
    throw new Error(
      `encoder: the timeline has ${plan.timeline.entries.length} entries for ${plan.verses.length} verses`,
    );
  }
  if (!Number.isFinite(plan.timeline.totalSec) || plan.timeline.totalSec <= 0) {
    throw new Error('encoder: the timeline has no duration');
  }
  if (plan.timeline.totalSec > MAX_VIDEO_SECONDS) {
    throw new Error(
      `encoder: the video would last ${plan.timeline.totalSec.toFixed(1)} s, over the ${MAX_VIDEO_SECONDS} s limit`,
    );
  }

  const rates = new Set<number>();
  plan.verses.forEach((verse, index) => {
    assertFiniteNonNegative(verse.durationSec, `verse ${index} duration`);
    if (!verse.audio) return;
    if (!Number.isInteger(verse.audio.sampleRate) || verse.audio.sampleRate < 8_000) {
      throw new Error(`encoder: verse ${index} has an unusable sample rate`);
    }
    if (verse.audio.numberOfChannels < 1 || verse.audio.numberOfChannels > 2) {
      throw new Error(`encoder: verse ${index} must be mono or stereo`);
    }
    rates.add(verse.audio.sampleRate);
  });

  if (rates.size > 1) {
    throw new Error('encoder: every verse must share one sample rate');
  }
}
