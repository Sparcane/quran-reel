import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS, type Timeline } from '@quran/core';
import type { BackgroundSelection, GradientSelection } from '@quran/core';
import {
  createGradientPainter,
  createQueue,
  type BackgroundPainter,
  type PlanarAudio,
  type RenderJob,
  type RenderSpec,
  type SubtitleStyle,
  type VideoRenderer,
} from '@quran/render';
import { jobStore, resetQueueStore } from '@/lib/queue-store';

/**
 * The queue store rebuilds painters when it reads records back. A painter
 * cannot cross IndexedDB, and the render flow always re-reads the job after a
 * full page load, so the rebuilt painter is what actually gets rendered.
 */
const { createImportedBackground, ensureImportedAsset } = vi.hoisted(() => ({
  createImportedBackground: vi.fn(),
  ensureImportedAsset: vi.fn(),
}));
vi.mock('@/lib/background-painter', () => ({ createImportedBackground, ensureImportedAsset }));

const SENTINEL = { paint() {}, dispose() {} } as unknown as BackgroundPainter;

const GRADIENT: GradientSelection = {
  kind: 'gradient',
  from: '#0b1026',
  to: '#1e3a5f',
  angle: 135,
  motion: true,
};

const VIDEO: BackgroundSelection = { kind: 'video', assetId: 'asset-1', name: 'fond.mp4' };

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
  id = 'stored-job',
  createdAt = 1,
): RenderJob {
  return {
    id,
    spec: spec(selection, timeline),
    status,
    progress: status === 'done' ? 100 : 0,
    createdAt,
  };
}

const RESULT = {
  blob: new Blob(['mp4'], { type: 'video/mp4' }),
  durationSec: 3,
  width: 640,
  height: 360,
  container: 'mp4' as const,
  videoCodec: 'avc1',
};

describe('queue-store round trip', () => {
  beforeEach(() => {
    resetQueueStore();
    createImportedBackground.mockReset();
    ensureImportedAsset.mockReset();
    ensureImportedAsset.mockResolvedValue(undefined);
  });

  it('rebuilds an imported video background when the queue reads jobs to render', async () => {
    createImportedBackground.mockResolvedValue(SENTINEL);

    // The real spec carries a timeline; the looped video must cover its whole
    // length, lead-in included.
    await jobStore.put(
      job(VIDEO, 'queued', { entries: [], totalSec: 3.9 }),
    );
    const [read] = await jobStore.list();

    expect(createImportedBackground).toHaveBeenCalledWith(
      VIDEO,
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
    const [read] = await jobStore.list();

    expect(createImportedBackground).toHaveBeenCalledWith(
      { kind: 'image', assetId: 'asset-2', name: 'fond.png' },
      { width: 640, height: 360 },
      3,
    );
    expect(read?.spec.background).toBe(SENTINEL);
  });

  it('shows a queued imported background without decoding it on every poll', async () => {
    await jobStore.put(job(VIDEO));
    const read = await jobStore.get('stored-job');

    // The result page polls every 500 ms; only the queue's own read, right
    // before a render, may pay the demux and the decode.
    expect(createImportedBackground).not.toHaveBeenCalled();
    expect(read?.status).toBe('queued');
    expect(read?.spec.background).toBeDefined();
  });

  it('fails a queued job whose imported background is gone instead of faking one', async () => {
    ensureImportedAsset.mockRejectedValue(
      new Error('render: le fond importé n’est plus sur cet appareil'),
    );

    await jobStore.put(job(VIDEO));
    const read = await jobStore.get('stored-job');

    expect(read?.status).toBe('failed');
    expect(read?.error).toMatch(/fond importé/);
  });

  it('persists that failure so later reads skip the retry', async () => {
    ensureImportedAsset.mockRejectedValue(new Error('render: le fond importé n’est plus sur cet appareil'));

    await jobStore.put(job(VIDEO));
    await jobStore.get('stored-job');

    ensureImportedAsset.mockClear();
    const again = await jobStore.get('stored-job');
    expect(again?.status).toBe('failed');
    expect(ensureImportedAsset).not.toHaveBeenCalled();
  });

  it('does not load assets just to display a finished job', async () => {
    await jobStore.put(job(VIDEO, 'done'));
    const read = await jobStore.get('stored-job');

    expect(ensureImportedAsset).not.toHaveBeenCalled();
    expect(createImportedBackground).not.toHaveBeenCalled();
    expect(read?.status).toBe('done');
  });

  it('keeps rebuilding a gradient without touching the device', async () => {
    await jobStore.put(job(GRADIENT));
    const read = await jobStore.get('stored-job');

    expect(ensureImportedAsset).not.toHaveBeenCalled();
    expect(createImportedBackground).not.toHaveBeenCalled();
    expect(read?.status).toBe('queued');
    expect(read?.spec.background).toBeDefined();
  });

  it('lets a relaunched job run while the stale one stays failed', async () => {
    // The original import was deleted: the first read fails and persists.
    ensureImportedAsset.mockRejectedValue(new Error('render: le fond importé n’est plus sur cet appareil'));
    await jobStore.put(job(VIDEO, 'queued', undefined, 'stale-job', 1));
    await jobStore.get('stale-job');

    // The user re-imports the background (a new asset id) and relaunches.
    ensureImportedAsset.mockResolvedValue(undefined);
    createImportedBackground.mockResolvedValue(SENTINEL);
    const relaunched = job(
      { kind: 'video', assetId: 'asset-new', name: 'fond.mp4' },
      'queued',
      undefined,
      'relaunched-job',
      2,
    );
    await jobStore.put(relaunched);

    const renderedSpecs: RenderSpec[] = [];
    const renderer = {
      render: async (spec: RenderSpec) => {
        renderedSpecs.push(spec);
        return RESULT;
      },
      cancel() {},
    } as unknown as VideoRenderer;

    await createQueue(jobStore).runNext(renderer);

    expect(renderedSpecs).toHaveLength(1);
    expect(renderedSpecs[0].background).toBe(SENTINEL);
    expect((await jobStore.get('stale-job'))?.status).toBe('failed');
    expect((await jobStore.get('relaunched-job'))?.status).toBe('done');
  });
});
