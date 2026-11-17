import { describe, expect, it } from 'vitest';
import { buildTimeline } from '@quran/core';
import { createGradientPainter } from '../src/background';
import type { EncodePlan, PlanarAudio, VerseClip } from '../src/encoder-plan';
import type { SubtitleStyle } from '../src/types';
import {
  deserialiseAudio,
  deserialiseEncodePlan,
  serialiseAudio,
  serialiseEncodePlan,
} from '../src/audio-wire';

const RATE = 48_000;

function audio(samples: number[]): PlanarAudio {
  const data = new Float32Array(samples);
  return {
    sampleRate: RATE,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

const style: SubtitleStyle = {
  arabicFamily: 'serif',
  translationFamily: 'sans-serif',
  arabicSize: 48,
  translationSize: 26,
  textColor: '#ffffff',
  accentColor: '#facc15',
  mutedColor: '#ffffff80',
  lineHeight: 1.5,
  translationGap: 24,
  marginX: 80,
};

function verse(a: PlanarAudio | null): VerseClip {
  return {
    arabic: 'بسم الله',
    translation: 'Au nom de Dieu',
    words: null,
    audio: a,
    durationSec: 1,
  };
}

function plan(verses: VerseClip[]): EncodePlan {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    verses,
    timeline: buildTimeline(verses.map((v) => v.durationSec)),
    style,
    background: createGradientPainter(
      { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
      { width: 1080, height: 1920 },
    ),
    backgroundSelection: {
      kind: 'gradient',
      from: '#000000',
      to: '#111111',
      angle: 0,
      motion: false,
    },
  };
}

describe('audio wire format', () => {
  it('serialises audio into plain, structured-cloneable channel arrays', () => {
    const wire = serialiseAudio(audio([0.1, 0.2, 0.3]));
    expect(wire).not.toBeNull();
    expect(wire).toMatchObject({ sampleRate: RATE, numberOfChannels: 1, length: 3 });
    expect(wire!.channels[0]).toBeInstanceOf(Float32Array);
    // An AudioBuffer/PlanarAudio carries a method and is NOT cloneable; the wire
    // form must be, because it crosses postMessage and IndexedDB.
    expect(() => structuredClone(wire)).not.toThrow();
  });

  it('round-trips samples, rate and length without losing data', () => {
    const original = audio([0.1, -0.2, 0.3]);
    const restored = deserialiseAudio(structuredClone(serialiseAudio(original)));
    expect(restored).not.toBeNull();
    expect(restored!.sampleRate).toBe(RATE);
    expect(restored!.length).toBe(3);
    expect(restored!.numberOfChannels).toBe(1);
    expect([...restored!.getChannelData(0)][0]).toBeCloseTo(0.1, 6);
    expect([...restored!.getChannelData(0)][1]).toBeCloseTo(-0.2, 6);
    expect([...restored!.getChannelData(0)][2]).toBeCloseTo(0.3, 6);
  });

  it('keeps a silent verse null', () => {
    expect(serialiseAudio(null)).toBeNull();
    expect(deserialiseAudio(null)).toBeNull();
  });

  it('serialises and restores a whole encode plan, including the painter', () => {
    const original = plan([verse(audio([0.5, 0.5, 0.5, 0.5]))]);
    const wire = serialiseEncodePlan(original);
    expect(() => structuredClone(wire)).not.toThrow();

    const clone = structuredClone(wire);
    const restored = deserialiseEncodePlan(clone);

    expect(restored.width).toBe(1080);
    expect(restored.timeline.totalSec).toBe(original.timeline.totalSec);
    expect(restored.background.ready).toBe(true);
    expect([...restored.verses[0].audio!.getChannelData(0)]).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('refuses to rebuild a background it cannot describe in the worker', () => {
    const original = plan([verse(null)]);
    const wire = serialiseEncodePlan(original);
    wire.backgroundSelection = { kind: 'image', assetId: 'x', name: 'x.png' };
    expect(() => deserialiseEncodePlan(wire)).toThrow(/background/i);
  });
});
