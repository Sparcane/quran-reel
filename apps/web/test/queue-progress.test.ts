import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_VIDEO_SECONDS, type GradientSelection } from '@quran/core';
import {
  createGradientPainter,
  type PlanarAudio,
  type RenderJob,
  type RenderSpec,
  type SubtitleStyle,
} from '@quran/render';
import { jobStore, resetQueueStore } from '@/lib/queue-store';
import { openStudioDatabase, STUDIO_JOB_STORE_NAME } from '@/lib/storage';

/**
 * Progress arrives once per frame, and a job record carries the recitation
 * audio of the whole video: persisting each tick rewrote the audio hundreds of
 * times and locked the tab. The running percentage therefore stays in memory
 * and is merged over the stored record; only status changes reach the device.
 */

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

function spec(): RenderSpec {
  return {
    width: 640,
    height: 360,
    fps: 30,
    verses: [
      { arabic: 'آية', translation: 'Verset', words: null, audio: audio(2), durationSec: 2 },
    ],
    style: STYLE,
    background: createGradientPainter(GRADIENT, { width: 640, height: 360 }),
    backgroundSelection: GRADIENT,
    maxDurationSec: MAX_VIDEO_SECONDS,
  };
}

function job(id: string, status: RenderJob['status'], progress: number): RenderJob {
  return { id, spec: spec(), status, progress, createdAt: 1 };
}

/** The record as the device holds it, without the in-memory overlay. */
async function storedProgress(id: string): Promise<number | undefined> {
  const db = await openStudioDatabase();
  const record = (await db.get(STUDIO_JOB_STORE_NAME, id)) as RenderJob | undefined;
  return record?.progress;
}

describe('queue store progress', () => {
  beforeEach(() => {
    resetQueueStore();
  });

  it('shows the running percentage without rewriting the job', async () => {
    await jobStore.put(job('running', 'running', 0));

    jobStore.putProgress?.('running', 37);

    // The reader sees the live value…
    expect((await jobStore.get('running'))?.progress).toBe(37);
    expect((await jobStore.list())[0]?.progress).toBe(37);
    // …and the device still holds the record written when the job started.
    expect(await storedProgress('running')).toBe(0);
  });

  it('lets the terminal write win over the last tick', async () => {
    await jobStore.put(job('finished', 'running', 0));
    jobStore.putProgress?.('finished', 42);

    await jobStore.put(job('finished', 'done', 100));

    expect((await jobStore.get('finished'))?.progress).toBe(100);
    expect(await storedProgress('finished')).toBe(100);
  });

  it('forgets the session percentage when the job is deleted', async () => {
    await jobStore.put(job('deleted', 'running', 0));
    jobStore.putProgress?.('deleted', 55);

    await jobStore.delete('deleted');

    expect(await jobStore.get('deleted')).toBeNull();
  });
});
