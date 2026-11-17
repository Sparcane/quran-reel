import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderJob } from '@quran/render';
import { addToHistory } from '@/lib/history';
import { resumeRender } from '@/lib/render-runtime';

const { runNext, isBusy } = vi.hoisted(() => ({
  runNext: vi.fn(),
  isBusy: vi.fn(() => false),
}));

vi.mock('@quran/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@quran/render')>();
  return {
    ...actual,
    createQueue: () => ({
      enqueue: vi.fn(),
      runNext,
      recover: vi.fn(),
      isBusy,
    }),
    createRenderer: () => ({ render: vi.fn(), cancel: vi.fn() }),
    defaultRendererEnvironment: () => ({}),
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
});
