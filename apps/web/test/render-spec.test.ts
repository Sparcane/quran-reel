import { describe, expect, it, vi } from 'vitest';
import type { BackgroundPainter, PlanarAudio } from '@quran/render';
import { buildRenderSpec, type RenderSpecDeps } from '@/lib/render-spec';
import type { SurahData } from '@quran/core';
import { DEFAULT_STUDIO_SETTINGS } from '@/lib/studio-settings';

const RATE = 48_000;

function audio(durationSec: number): PlanarAudio {
  const length = Math.round(durationSec * RATE);
  return {
    sampleRate: RATE,
    length,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(length),
  };
}

function surah(): SurahData {
  return {
    number: 36,
    nameAr: 'يس',
    nameFr: 'Yâ-Sîn',
    nameEn: 'Ya-Sin',
    verseCount: 83,
    revelation: 'meccan',
    verses: [1, 2, 3].map((number) => ({
      number,
      arabic: `آية ${number}`,
      translations: { fr: `Français ${number}`, en: `English ${number}` },
    })),
  };
}

function deps(overrides: Partial<RenderSpecDeps> = {}): RenderSpecDeps {
  return {
    loadSurah: async () => surah(),
    loadAudio: async () => audio(1),
    loadBackground: async () => null,
    createBitmap: async () => ({}) as ImageBitmap,
    createVideo: async () => ({ ready: true, paint() {}, dispose() {} }) as BackgroundPainter,
    ...overrides,
  };
}

const selection = [
  { surah: 36, verse: 1 },
  { surah: 36, verse: 2 },
  { surah: 36, verse: 3 },
];

describe('buildRenderSpec', () => {
  it('builds a spec from the selection and the studio settings', async () => {
    const urls: string[] = [];
    const spec = await buildRenderSpec(
      selection,
      DEFAULT_STUDIO_SETTINGS,
      deps({
        loadAudio: async (url) => {
          urls.push(url);
          return audio(1);
        },
      }),
    );

    expect(spec.verses).toHaveLength(3);
    expect(spec.verses[0]).toMatchObject({
      arabic: 'آية 1',
      translation: 'Français 1',
      durationSec: 1,
    });
    expect(spec.verses[0].audio?.sampleRate).toBe(RATE);
    expect(urls[0]).toMatch(/036001\.mp3$/);

    expect(spec).toMatchObject({ width: 1080, height: 1920, fps: 30, maxDurationSec: 900 });
    expect(spec.timeline.entries).toHaveLength(3);
    expect(spec.style).toMatchObject({
      arabicSize: DEFAULT_STUDIO_SETTINGS.arabicSize,
      textColor: DEFAULT_STUDIO_SETTINGS.textColor,
    });
    expect(spec.backgroundSelection).toEqual(DEFAULT_STUDIO_SETTINGS.background);
    expect(spec.background.ready).toBe(true);
  });

  it('refuses an empty selection before downloading anything', async () => {
    let called = false;
    await expect(
      buildRenderSpec([], DEFAULT_STUDIO_SETTINGS, deps({ loadAudio: async () => { called = true; return audio(1); } })),
    ).rejects.toThrow(/no verses/i);
    expect(called).toBe(false);
  });

  it('refuses a video over the 900-second ceiling before starting', async () => {
    await expect(
      buildRenderSpec(selection, DEFAULT_STUDIO_SETTINGS, deps({ loadAudio: async () => audio(901) })),
    ).rejects.toThrow(/900/i);
  });

  it('names the verse that is missing from the shipped text', async () => {
    await expect(
      buildRenderSpec([{ surah: 36, verse: 99 }], DEFAULT_STUDIO_SETTINGS, deps()),
    ).rejects.toThrow(/36:99/);
  });

  it('names the verse whose recitation could not be loaded', async () => {
    await expect(
      buildRenderSpec(
        selection,
        DEFAULT_STUDIO_SETTINGS,
        deps({
          loadAudio: async () => {
            throw new Error('HTTP 404');
          },
        }),
      ),
    ).rejects.toThrow(/36:1.*HTTP 404/);
  });

  it('wires an imported H.264 background into the render spec', async () => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    const createVideo = vi.fn(
      async () => ({ ready: true, paint() {}, dispose() {} }) as BackgroundPainter,
    );

    const spec = await buildRenderSpec(
      [selection[0]],
      {
        ...DEFAULT_STUDIO_SETTINGS,
        background: { kind: 'video', assetId: 'asset-1', name: 'fond.mp4' },
      },
      deps({ loadBackground: async () => ({ blob }), createVideo }),
    );

    expect(createVideo).toHaveBeenCalledWith(
      blob,
      { width: 1080, height: 1920 },
      spec.timeline.totalSec,
    );
    expect(spec.background.ready).toBe(true);
    expect(spec.backgroundSelection).toMatchObject({ kind: 'video', assetId: 'asset-1' });
  });

  it('leaves the translation out when the setting is off', async () => {
    const spec = await buildRenderSpec(
      selection,
      { ...DEFAULT_STUDIO_SETTINGS, showTranslation: false },
      deps(),
    );
    expect(spec.verses.map((v) => v.translation)).toEqual(['', '', '']);
  });

  it('estimates word timings at the verse start in word mode', async () => {
    const spec = await buildRenderSpec(
      selection,
      { ...DEFAULT_STUDIO_SETTINGS, subtitleMode: 'word' },
      deps(),
    );
    const words = spec.verses[0].words;
    expect(words).not.toBeNull();
    expect(words![0].start).toBeCloseTo(0.8, 2);
    expect(words!.at(-1)!.end).toBeCloseTo(1.8, 2);
  });

  it('uses the requested aspect ratio for the frame and the painter', async () => {
    const spec = await buildRenderSpec(
      selection,
      { ...DEFAULT_STUDIO_SETTINGS, aspectRatio: '16:9' },
      deps(),
    );
    expect(spec).toMatchObject({ width: 1920, height: 1080 });
  });
});
