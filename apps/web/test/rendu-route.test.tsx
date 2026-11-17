import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS } from '@quran/core';
import { createGradientPainter, type RenderJob } from '@quran/render';
import { RenduRoute } from '@/components/RenduRoute';

const REAL_ID = '2fb683f8-7bc0-48fe-9f06-758dcd0089a1';

const { getJob, resumeRender } = vi.hoisted(() => ({
  getJob: vi.fn(),
  resumeRender: vi.fn(),
}));

function makeJob(status: RenderJob['status']): RenderJob {
  return {
    id: REAL_ID,
    spec: {
      width: 1080,
      height: 1920,
      fps: 30,
      verses: [],
      style: {
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
      },
      background: createGradientPainter(
        { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
        { width: 1080, height: 1920 },
      ),
      maxDurationSec: MAX_VIDEO_SECONDS,
    },
    status,
    progress: status === 'done' ? 100 : 0,
    createdAt: 1,
    finishedAt: status === 'done' ? 2 : undefined,
    result:
      status === 'done'
        ? {
            blob: new Blob(['mp4'], { type: 'video/mp4' }),
            durationSec: 2,
            width: 1080,
            height: 1920,
            container: 'mp4' as const,
            videoCodec: 'avc1',
          }
        : undefined,
  };
}

getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
  id === REAL_ID ? makeJob('done') : null,
);

vi.mock('next/navigation', () => ({
  // A static export prerenders /rendu/[id] as /rendu/_, so the router's params
  // carry the placeholder id while the address bar holds the real one.
  useParams: () => ({ id: '_' }),
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('@/lib/queue-store', () => ({ jobStore: { get: getJob } }));
vi.mock('@/lib/render-runtime', () => ({
  recoverQueue: async () => undefined,
  startRender: vi.fn(),
  resumeRender,
}));

describe('RenduRoute', () => {
  beforeEach(() => {
    window.history.pushState({}, '', `/rendu/${REAL_ID}/`);
    getJob.mockClear();
    resumeRender.mockClear();
    getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
      id === REAL_ID ? makeJob('done') : null,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the job from the address bar, not the prerendered placeholder id', async () => {
    render(<RenduRoute />);

    expect(await screen.findByRole('video', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(getJob).toHaveBeenCalledWith(REAL_ID);
    expect(getJob).not.toHaveBeenCalledWith('_');
  });

  it('pumps a queued job on arrival, since a full page load starts a fresh queue', async () => {
    const queued = makeJob('queued');
    getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
      id === REAL_ID ? queued : null,
    );

    render(<RenduRoute />);

    expect(await screen.findByText(/en attente/i)).toBeInTheDocument();
    expect(resumeRender).toHaveBeenCalledWith(queued);
  });

  it('stops polling once the job is done, so the player URL is not recreated', async () => {
    render(<RenduRoute />);
    await screen.findByRole('video', {}, { timeout: 3000 });

    const callsWhenDone = getJob.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(getJob.mock.calls.length).toBe(callsWhenDone);
  });
});
