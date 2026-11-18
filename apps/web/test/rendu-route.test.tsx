import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS } from '@quran/core';
import { createGradientPainter, type RenderJob } from '@quran/render';
import { MISSING_BACKGROUND_ASSET_ERROR } from '@/lib/background-painter';
import { currentId, RenduRoute } from '@/components/RenduRoute';

const REAL_ID = '2fb683f8-7bc0-48fe-9f06-758dcd0089a1';

const { getJob, resumeRender, startRender } = vi.hoisted(() => ({
  getJob: vi.fn(),
  resumeRender: vi.fn(),
  startRender: vi.fn(),
}));

function makeJob(status: RenderJob['status'], error?: string): RenderJob {
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
    error,
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
  startRender,
  resumeRender,
}));

describe('RenduRoute', () => {
  beforeEach(() => {
    window.history.pushState({}, '', `/rendu/${REAL_ID}/`);
    getJob.mockClear();
    resumeRender.mockClear();
    startRender.mockReset();
    getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
      id === REAL_ID ? makeJob('done') : null,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads a valid escaped id from the address bar', () => {
    window.history.pushState({}, '', `/rendu/${encodeURIComponent('job à accents')}/`);

    expect(currentId('_')).toBe('job à accents');
  });

  it('falls back to the router id when a copied link has a broken escape', () => {
    // A truncated link used to throw URIError during React rendering, leaving
    // a blank page instead of the usual unknown-id 404.
    window.history.pushState({}, '', '/rendu/%E0/');

    expect(currentId('_')).toBe('_');
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

  it('hides Relancer for a missing-background failure, whose spec cannot be repaired', async () => {
    // Retrying this job's spec would fail again: the re-import creates a new
    // asset id, and only the studio can put it into a fresh spec.
    const failed = makeJob('failed', MISSING_BACKGROUND_ASSET_ERROR);
    getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
      id === REAL_ID ? failed : null,
    );

    render(<RenduRoute />);

    expect(await screen.findByText(MISSING_BACKGROUND_ASSET_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /relancer le rendu/i })).toBeNull();
    expect(startRender).not.toHaveBeenCalled();
  });

  it('still offers Relancer for a failure the same spec can survive', async () => {
    startRender.mockResolvedValue({ id: 'new-job' });
    const failed = makeJob('failed', 'l’encodage a été interrompu');
    getJob.mockImplementation(async (id: string): Promise<RenderJob | null> =>
      id === REAL_ID ? failed : null,
    );

    render(<RenduRoute />);
    const user = await screen.findByRole('button', { name: /relancer le rendu/i });
    user.click();

    await vi.waitFor(() => expect(startRender).toHaveBeenCalledWith(failed.spec));
  });
});
