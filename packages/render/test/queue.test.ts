import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_SECONDS } from '@quran/core';
import { createGradientPainter } from '../src/background';
import { createMemoryJobStore, createQueue, type JobStore, type RenderJob } from '../src/queue';
import { RenderCancelledError, type VideoRenderer } from '../src/worker';
import type { Progress, RenderedVideo, RenderSpec, SubtitleStyle } from '../src/types';

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

function spec(label: string, durationSec = 2): RenderSpec {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    verses: [{ arabic: label, translation: label, words: null, audio: null, durationSec }],
    style,
    background: createGradientPainter(
      { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
      { width: 1080, height: 1920 },
    ),
    maxDurationSec: MAX_VIDEO_SECONDS,
  };
}

/** Distinct ids in enqueue order, so equal timestamps still sort deterministically. */
function ids(prefix = 'job'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function video(label: string): RenderedVideo {
  return {
    blob: new Blob([label]),
    durationSec: 2,
    width: 1080,
    height: 1920,
    container: 'mp4',
    videoCodec: 'avc1',
  };
}

interface FakeRenderer extends VideoRenderer {
  calls: RenderSpec[];
  cancelled: boolean;
  progressSeen: number[];
}

/** A renderer that finishes immediately, reporting three progress steps. */
function fastRenderer(result = video('ok')): FakeRenderer {
  return {
    calls: [],
    cancelled: false,
    progressSeen: [],
    async render(renderSpec, onProgress) {
      this.calls.push(renderSpec);
      for (const percent of [0, 40, 90]) {
        this.progressSeen.push(percent);
        onProgress({
          frame: Math.round((percent / 100) * 60),
          totalFrames: 60,
          percent,
          etaSec: 1,
        });
      }
      return result;
    },
    cancel() {
      this.cancelled = true;
    },
  };
}

/** A renderer whose promise only settles when `cancel()` or `reject()` is called. */
function hangingRenderer(): FakeRenderer & {
  reject(error: unknown): void;
  started: Promise<void>;
} {
  let reject!: (error: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const renderer: FakeRenderer & {
    reject(error: unknown): void;
    started: Promise<void>;
  } = {
    calls: [],
    cancelled: false,
    progressSeen: [],
    started,
    render(renderSpec) {
      this.calls.push(renderSpec);
      markStarted();
      return new Promise<RenderedVideo>((_resolve, fail) => {
        reject = fail;
      });
    },
    cancel() {
      this.cancelled = true;
      reject(new RenderCancelledError());
    },
    reject(error) {
      reject(error);
    },
  };
  return renderer;
}

describe('createQueue', () => {
  it('runs queued jobs one at a time in FIFO order', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: ids(), now: () => 1 });
    const renderer = fastRenderer();

    const a = await queue.enqueue(spec('A'));
    const b = await queue.enqueue(spec('B'));
    expect((await queue.listJobs()).map((job) => job.status)).toEqual(['queued', 'queued']);

    const first = await queue.runNext(renderer);
    expect(first?.id).toBe(a.id);
    expect((await queue.listJobs()).map((job) => job.status)).toEqual(['done', 'queued']);

    const second = await queue.runNext(renderer);
    expect(second?.id).toBe(b.id);
    expect((await queue.listJobs()).map((job) => job.status)).toEqual(['done', 'done']);
    expect(renderer.calls.map((value) => value.verses[0].arabic)).toEqual(['A', 'B']);
  });

  it('returns null when the queue is empty', async () => {
    const queue = createQueue(createMemoryJobStore());
    expect(await queue.runNext(fastRenderer())).toBeNull();
  });

  it('refuses to start a second job while one is running', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: ids(), now: () => 1 });
    await queue.enqueue(spec('A'));
    await queue.enqueue(spec('B'));

    const renderer = hangingRenderer();
    const pending = queue.runNext(renderer);
    await renderer.started;
    expect(await queue.runNext(fastRenderer())).toBeNull();

    renderer.cancel();
    await pending;
  });

  it('cancels a running job and records its cancelled status', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'long', now: () => 1 });
    const job = await queue.enqueue(spec('long'));
    const renderer = hangingRenderer();

    const pending = queue.runNext(renderer);
    await renderer.started;
    await queue.cancelJob(job.id);
    const finished = await pending;

    expect(renderer.cancelled).toBe(true);
    expect(finished?.status).toBe('cancelled');
    expect((await queue.getJob(job.id))?.status).toBe('cancelled');
  });

  it('ignores progress reported after the job was cancelled', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'stale', now: () => 1 });
    const job = await queue.enqueue(spec('stale'));

    // The inline encoder does not stop the instant it is cancelled: a frame it
    // is already painting still reports progress. That late report must not put
    // a cancelled job back to `running`; `recover()` would then call it
    // interrupted and the result page would show the wrong story.
    const control: {
      report?: (progress: Progress) => void;
      finish?: () => void;
    } = {};
    const renderer: FakeRenderer = {
      calls: [],
      cancelled: false,
      progressSeen: [],
      render(_renderSpec, onProgress) {
        control.report = onProgress;
        return new Promise<RenderedVideo>((resolve) => {
          control.finish = () => resolve(video('late'));
        });
      },
      cancel() {
        this.cancelled = true;
      },
    };

    const pending = queue.runNext(renderer);
    await Promise.resolve();
    await queue.cancelJob(job.id);

    control.report?.({ frame: 48, totalFrames: 60, percent: 80, etaSec: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect((await queue.getJob(job.id))?.status).toBe('cancelled');

    control.finish?.();
    const finished = await pending;
    expect(finished?.status).toBe('cancelled');
  });

  it('records a failure with its message', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'bad', now: () => 1 });
    await queue.enqueue(spec('bad'));
    const renderer = hangingRenderer();

    const pending = queue.runNext(renderer);
    await renderer.started;
    renderer.reject(new Error('codec unavailable'));
    const finished = await pending;

    expect(finished?.status).toBe('failed');
    expect(finished?.error).toMatch(/codec unavailable/);
  });

  it('persists progress updates and the final 100 percent', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'p', now: () => 1 });
    const job = await queue.enqueue(spec('progress'));

    const finished = await queue.runNext(fastRenderer());

    expect(finished?.progress).toBe(100);
    expect((await queue.getJob(job.id))?.progress).toBe(100);
  });

  it('reports every tick to a store fast path instead of rewriting the job', async () => {
    const store = createMemoryJobStore();
    const writes: number[] = [];
    const ticks: number[] = [];
    const put = store.put.bind(store);
    store.put = async (runningJob) => {
      if (runningJob.status === 'running') writes.push(runningJob.progress);
      return put(runningJob);
    };
    store.putProgress = (_id, percent) => ticks.push(percent);

    const queue = createQueue(store, { newId: () => 'ticks', now: () => 1 });
    const job = await queue.enqueue(spec('ticks'));
    await queue.runNext(fastRenderer());

    // The job is written once when it starts running; its ticks only reach the
    // fast path. A full write per tick would rewrite the recitation audio.
    expect(writes).toEqual([0]);
    expect(ticks).toEqual([40, 90]);
    expect((await queue.getJob(job.id))?.progress).toBe(100);
  });

  it('writes a store without the fast path once per whole percent', async () => {
    const inner = createMemoryJobStore();
    const written: number[] = [];
    const slowStore: JobStore = {
      get: (id) => inner.get(id),
      list: () => inner.list(),
      delete: (id) => inner.delete(id),
      async put(runningJob) {
        if (runningJob.status === 'running') written.push(runningJob.progress);
        await inner.put(runningJob);
      },
    };
    const renderer: VideoRenderer = {
      async render(_renderSpec, onProgress) {
        for (const percent of [0.4, 0.9, 1.1, 1.6, 2.2]) {
          onProgress({ frame: 1, totalFrames: 60, percent, etaSec: 1 });
        }
        return video('fractional');
      },
      cancel() {},
    };

    const queue = createQueue(slowStore, { newId: () => 'slow', now: () => 1 });
    await queue.enqueue(spec('slow'));
    const finished = await queue.runNext(renderer);

    // Five ticks, two whole percentages: 0.4 and 0.9 stay below the first one.
    expect(written).toEqual([0, 1.1, 2.2]);
    expect(finished?.status).toBe('done');
  });

  it('stores the rendered video on a done job', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'r', now: () => 1 });
    await queue.enqueue(spec('result'));
    const result = video('rendered');

    const finished = await queue.runNext(fastRenderer(result));

    expect(finished?.status).toBe('done');
    expect(finished?.result).toBe(result);
  });

  it('marks a job left running by a previous session as interrupted', async () => {
    const store = createMemoryJobStore();
    await store.put({
      id: 'interrupted',
      spec: spec('interrupted'),
      status: 'running',
      progress: 55,
      createdAt: 1,
    });
    const queue = createQueue(store);

    await queue.recover();

    const recovered = await queue.getJob('interrupted');
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toMatch(/interrompu/i);
    expect(recovered?.progress).toBe(55);
  });

  it('leaves a job alone while this very queue is rendering it', async () => {
    // The result page recovers stale jobs on mount. Right after "Générer" the
    // job is running in THIS tab, not interrupted in a previous one; a naive
    // recover() used to fail it and the download link never appeared.
    const store = createMemoryJobStore();
    const queue = createQueue(store, { newId: () => 'active', now: () => 1 });
    await queue.enqueue(spec('active'));
    const renderer = hangingRenderer();
    const running = queue.runNext(renderer);
    await renderer.started;

    await queue.recover();

    expect((await queue.getJob('active'))?.status).toBe('running');
    renderer.reject(new Error('stop'));
    await running;
  });

  it('leaves finished jobs untouched during recovery', async () => {
    const store = createMemoryJobStore();
    const done: RenderJob = {
      id: 'done',
      spec: spec('done'),
      status: 'done',
      progress: 100,
      createdAt: 1,
    };
    await store.put(done);
    const queue = createQueue(store);

    await queue.recover();

    expect((await queue.getJob('done'))?.status).toBe('done');
  });

  it('generates unique ids and stamps jobs when not given a clock', async () => {
    const store = createMemoryJobStore();
    const queue = createQueue(store);

    const a = await queue.enqueue(spec('a'));
    const b = await queue.enqueue(spec('b'));

    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBeLessThanOrEqual(b.createdAt);
  });
});
