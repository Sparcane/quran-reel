import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderJob } from '@quran/render';
import { addToHistory } from '@/lib/history';
import { recoverQueue, resumeRender, startRender } from '@/lib/render-runtime';

const { runNext, isBusy, enqueue, recover } = vi.hoisted(() => ({
  runNext: vi.fn(),
  isBusy: vi.fn(() => false),
  enqueue: vi.fn(),
  recover: vi.fn(),
}));

const captured: { createWorker?: (() => unknown) | undefined } = {};

vi.mock('@quran/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@quran/render')>();
  return {
    ...actual,
    createQueue: () => ({
      enqueue,
      runNext,
      recover,
      isBusy,
    }),
    createRenderer: () => ({ render: vi.fn(), cancel: vi.fn() }),
    defaultRendererEnvironment: (createWorker: () => unknown) => {
      captured.createWorker = createWorker;
      return {};
    },
  };
});

vi.mock('@/lib/queue-store', () => ({ jobStore: {} }));
vi.mock('@/lib/history', () => ({ addToHistory: vi.fn() }));

/**
 * Only id, createdAt, status, result and spec.backgroundSelection matter to
 * resumeRender; the renderer is mocked and never sees the rest.
 */
function job(status: RenderJob['status']): RenderJob {
  return {
    id: 'job-1',
    createdAt: 123,
    status,
    spec: { backgroundSelection: { kind: 'gradient' } },
    result:
      status === 'done'
        ? {
            blob: new Blob(['mp4'], { type: 'video/mp4' }),
            durationSec: 2,
            width: 1080,
            height: 1920,
            container: 'mp4',
            videoCodec: 'avc1',
          }
        : undefined,
  } as unknown as RenderJob;
}

describe('resumeRender', () => {
  beforeEach(() => {
    runNext.mockReset();
    enqueue.mockReset();
    recover.mockReset();
    isBusy.mockReturnValue(false);
    vi.mocked(addToHistory).mockClear();
  });

  it('adds a finished video to the history with its size', async () => {
    const done = job('done');
    runNext.mockResolvedValue(done);

    await resumeRender(done);

    expect(addToHistory).toHaveBeenCalledWith({
      id: done.id,
      createdAt: done.createdAt,
      size: done.result!.blob.size,
      video: done.result,
    });
  });

  it('does not add failed or cancelled renders to the history', async () => {
    for (const status of ['failed', 'cancelled'] as const) {
      runNext.mockResolvedValue(job(status));
      await resumeRender(job(status));
    }

    expect(addToHistory).not.toHaveBeenCalled();
  });

  it('survives a history write failure, since the render itself succeeded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    runNext.mockResolvedValue(job('done'));
    vi.mocked(addToHistory).mockRejectedValue(new Error('quota'));

    // resumeRender is called fire-and-forget from the result page; a rejection
    // here would be an unhandled promise rejection on a successful render.
    await expect(resumeRender(job('done'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('history:', expect.any(Error));
    error.mockRestore();
  });

  it('does not start a second render while one is busy', async () => {
    isBusy.mockReturnValue(true);

    await resumeRender(job('queued'));

    expect(runNext).not.toHaveBeenCalled();
  });

  it('offloads a gradient to a worker when the platform has one', async () => {
    class FakeWorker {}
    vi.stubGlobal('Worker', FakeWorker);
    runNext.mockResolvedValue(null);

    await resumeRender(job('queued'));

    expect(captured.createWorker?.()).toBeInstanceOf(FakeWorker);
    vi.unstubAllGlobals();
  });

  it('keeps an imported background on the main thread', async () => {
    class FakeWorker {}
    vi.stubGlobal('Worker', FakeWorker);
    runNext.mockResolvedValue(null);
    const imported = job('queued');
    imported.spec.backgroundSelection = { kind: 'video', assetId: 'a', name: 'fond.mp4' };

    await resumeRender(imported);

    // The painter and the asset bytes cannot cross the worker boundary.
    expect(captured.createWorker?.()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('startRender and recoverQueue', () => {
  beforeEach(() => {
    enqueue.mockReset();
    recover.mockReset();
  });

  it('stores the job without starting it, so the worker lives on the result page', async () => {
    const spec = job('queued').spec;
    enqueue.mockResolvedValue(job('queued'));

    await expect(startRender(spec)).resolves.toMatchObject({ id: 'job-1' });
    expect(enqueue).toHaveBeenCalledWith(spec);
    expect(runNext).not.toHaveBeenCalled();
  });

  it('hands interrupted jobs back to the store on load', async () => {
    recover.mockResolvedValue(undefined);

    await recoverQueue();

    expect(recover).toHaveBeenCalledOnce();
  });
});
