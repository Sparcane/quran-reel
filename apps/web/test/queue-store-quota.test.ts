import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS, type GradientSelection } from '@quran/core';
import {
  createGradientPainter,
  createQueue,
  type PlanarAudio,
  type RenderJob,
  type RenderSpec,
  type SubtitleStyle,
  type VideoRenderer,
} from '@quran/render';
import { jobStore, resetQueueStore } from '@/lib/queue-store';

/**
 * A full device rejects the write and keeps serving reads. That is the state a
 * quota error leaves behind, and the one the fallback has to survive: the job
 * only exists in the session copy, so anything that reads the database alone
 * cannot see it.
 */
const device = vi.hoisted(() => ({ full: false }));

vi.mock('@/lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage')>();
  return {
    ...actual,
    async openStudioDatabase() {
      const db = await actual.openStudioDatabase();
      if (!device.full) return db;
      return new Proxy(db, {
        get(target, property) {
          if (property === 'put') {
            return () => Promise.reject(new Error('QuotaExceededError'));
          }
          // Hand the real database's own methods back, bound to it: `idb`
          // checks the receiver and a proxy of the proxy breaks the brand.
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

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
      {
        arabic: 'آية',
        translation: 'Verset',
        words: null,
        audio: audio(1),
        durationSec: 1,
      },
    ],
    style: STYLE,
    background: createGradientPainter(GRADIENT, { width: 640, height: 360 }),
    backgroundSelection: GRADIENT,
    maxDurationSec: MAX_VIDEO_SECONDS,
  };
}

function job(id = 'quota-job'): RenderJob {
  return { id, spec: spec(), status: 'queued', progress: 0, createdAt: 1 };
}

const RESULT = {
  blob: new Blob(['mp4'], { type: 'video/mp4' }),
  durationSec: 1,
  width: 640,
  height: 360,
  container: 'mp4' as const,
  videoCodec: 'avc1',
};

describe('queue store on a full device', () => {
  beforeEach(() => {
    resetQueueStore();
    device.full = true;
  });

  it('keeps a job whose write did not fit visible to the queue', async () => {
    await jobStore.put(job());

    const listed = await jobStore.list();

    expect(listed.map((record) => record.id)).toEqual(['quota-job']);
  });

  it('lets the queue render that job instead of leaving it queued forever', async () => {
    await jobStore.put(job());

    const rendered: RenderSpec[] = [];
    const renderer = {
      render: async (renderSpec: RenderSpec) => {
        rendered.push(renderSpec);
        return RESULT;
      },
      cancel() {},
    } as unknown as VideoRenderer;

    await createQueue(jobStore).runNext(renderer);

    expect(rendered).toHaveLength(1);
    expect((await jobStore.get('quota-job'))?.status).toBe('done');
  });
});
