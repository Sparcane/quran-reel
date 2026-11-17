import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MAX_VIDEO_SECONDS } from '@quran/core';
import { createGradientPainter } from '@quran/render';
import type { RenderJob } from '@quran/render';
import { RenduPage } from '../src/components/ResultPlayer';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

function job(overrides: Partial<RenderJob> = {}): RenderJob {
  return {
    id: 'job-42',
    spec: {
      width: 1080,
      height: 1920,
      fps: 30,
      verses: [
        {
          arabic: 'يس',
          translation: 'Yâ-Sîn',
          words: null,
          audio: null,
          durationSec: 2,
        },
      ],
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
    status: 'running',
    progress: 42,
    createdAt: 1,
    ...overrides,
  };
}

describe('RenduPage', () => {
  it('shows the progress of a running job, and no player yet', () => {
    render(<RenduPage job={job({ status: 'running', progress: 42 })} />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByText(/42\s?%/)).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('waits visibly for a queued job', () => {
    render(<RenduPage job={job({ status: 'queued' })} />);

    expect(screen.getByText(/en attente/i)).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('shows a failed job honestly, with its error and a way to relaunch', () => {
    const onRetry = vi.fn();
    render(
      <RenduPage
        job={job({ status: 'failed', error: 'codec indisponible' })}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/codec indisponible/i)).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /relancer/i })).toBeInTheDocument();
  });

  it('calls onRetry when the user relaunches a failed job', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<RenduPage job={job({ status: 'failed', error: 'codec' })} onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: /relancer/i }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows the player and a real download link for a done job', () => {
    const done = job({
      status: 'done',
      progress: 100,
      result: {
        blob: new Blob(['mp4'], { type: 'video/mp4' }),
        durationSec: 2,
        width: 1080,
        height: 1920,
        container: 'mp4',
        videoCodec: 'avc1',
      },
    });
    render(<RenduPage job={done} />);

    expect(screen.getByRole('video')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /télécharger/i })).toHaveAttribute('download');
  });

  it('never presents a cancelled job as ready', () => {
    render(<RenduPage job={job({ status: 'cancelled', progress: 38 })} />);

    expect(screen.getByText(/annul/i)).toBeInTheDocument();
    expect(screen.queryByRole('video')).not.toBeInTheDocument();
  });

  it('sends an unknown job to a real 404', () => {
    expect(() => render(<RenduPage job={null} />)).toThrow('NEXT_NOT_FOUND');
  });
});
