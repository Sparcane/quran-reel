import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS, type Timeline } from '@quran/core';
import type { BackgroundSelection, GradientSelection } from '@quran/core';
import {
  createGradientPainter,
  type BackgroundPainter,
  type PlanarAudio,
  type RenderJob,
  type RenderSpec,
  type SubtitleStyle,
} from '@quran/render';
import { jobStore, resetQueueStore } from '@/lib/queue-store';

/**
 * The queue store rebuilds painters when it reads records back. A painter
 * cannot cross IndexedDB, and the render flow always re-reads the job after a
 * full page load, so the rebuilt painter is what actually gets rendered.
 */
const { createImportedBackground } = vi.hoisted(() => ({ createImportedBackground: vi.fn() }));
vi.mock('@/lib/background-painter', () => ({ createImportedBackground }));

const SENTINEL = { paint() {}, dispose() {} } as unknown as BackgroundPainter;

const GRADIENT: GradientSelection = {
  kind: 'gradient',
  from: '#0b1026',
  to: '#1e3a5f',
  angle: 135,
  motion: true,
};

const STYLE: SubtitleStyle = {
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

function audio(durationSec: number): PlanarAudio {
  const length = Math.round(durationSec * 48_000);
  return {
    sampleRate: 48_000,
    length,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(length),
  };
}

function spec(selection: BackgroundSelection, timeline?: Timeline): RenderSpec {
  return {
    width: 640,
    height: 360,
    fps: 30,
    verses: [1, 2].map((number) => ({
      arabic: `آية ${number}`,
      translation: `Verset ${number}`,
      words: null,
      audio: audio(number),
      durationSec: number,
    })),
    style: STYLE,
    background: createGradientPainter(GRADIENT, { width: 640, height: 360 }),
    backgroundSelection: selection,
    timeline,
    maxDurationSec: MAX_VIDEO_SECONDS,
  };
}

function job(
  selection: BackgroundSelection,
  status: RenderJob['status'] = 'queued',
  timeline?: Timeline,
): RenderJob {
  return {
    id: 'stored-job',
    spec: spec(selection, timeline),
    status,
    progress: status === 'done' ? 100 : 0,
    createdAt: 1,
  };
}

describe('queue-store round trip', () => {
  beforeEach(() => {
    resetQueueStore();
    createImportedBackground.mockReset();
  });

  it('rebuilds an imported video background when a queued job is read back', async () => {
    createImportedBackground.mockResolvedValue(SENTINEL);

    // The real spec carries a timeline; the looped video must cover its whole
    // length, lead-in included.
    await jobStore.put(
      job(
        { kind: 'video', assetId: 'asset-1', name: 'fond.mp4' },
        'queued',
        { entries: [], totalSec: 3.9 },
      ),
    );
    const read = await jobStore.get('stored-job');

    expect(createImportedBackground).toHaveBeenCalledWith(
      { kind: 'video', assetId: 'asset-1', name: 'fond.mp4' },
      { width: 640, height: 360 },
      3.9,
    );
    expect(read?.spec.background).toBe(SENTINEL);
    expect(read?.status).toBe('queued');
  });

  it('rebuilds an imported picture the same way', async () => {
    createImportedBackground.mockResolvedValue(SENTINEL);

    // Without a timeline, the verse durations are the floor to cover.
    await jobStore.put(job({ kind: 'image', assetId: 'asset-2', name: 'fond.png' }));
    const read = await jobStore.get('stored-job');

    expect(createImportedBackground).toHaveBeenCalledWith(
      { kind: 'image', assetId: 'asset-2', name: 'fond.png' },
      { width: 640, height: 360 },
      3,
    );
    expect(read?.spec.background).toBe(SENTINEL);
  });

  it('fails a queued job whose imported background is gone instead of faking one', async () => {
    createImportedBackground.mockRejectedValue(
      new Error('render: le fond importé n’est plus sur cet appareil'),
    );

    await jobStore.put(job({ kind: 'video', assetId: 'gone', name: 'fond.mp4' }));
    const read = await jobStore.get('stored-job');

    expect(read?.status).toBe('failed');
    expect(read?.error).toMatch(/fond importé/);
  });

  it('does not load assets just to display a finished job', async () => {
    await jobStore.put(job({ kind: 'video', assetId: 'asset-1', name: 'fond.mp4' }, 'done'));
    const read = await jobStore.get('stored-job');

    expect(createImportedBackground).not.toHaveBeenCalled();
    expect(read?.status).toBe('done');
  });

  it('keeps rebuilding a gradient without touching the device', async () => {
    await jobStore.put(job(GRADIENT));
    const read = await jobStore.get('stored-job');

    expect(createImportedBackground).not.toHaveBeenCalled();
    expect(read?.status).toBe('queued');
    expect(read?.spec.background).toBeDefined();
  });
});
