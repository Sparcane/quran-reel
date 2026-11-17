import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderedVideo } from '@quran/render';
import type { HistoryEntry } from '../src/lib/history';
import { HistoryList } from '../src/components/HistoryList';

const listHistory = vi.fn();
const deleteFromHistory = vi.fn();

vi.mock('../src/lib/history', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/history')>(
    '../src/lib/history',
  );
  return {
    ...actual,
    listHistory: (...args: unknown[]) => listHistory(...args),
    deleteFromHistory: (...args: unknown[]) => deleteFromHistory(...args),
  };
});

function entry(id: string, createdAt: number): HistoryEntry {
  const video: RenderedVideo = {
    blob: new Blob(['mp4']),
    durationSec: 12,
    width: 1080,
    height: 1920,
    container: 'mp4',
    videoCodec: 'avc1',
  };
  return { id, createdAt, size: 2_400_000, video };
}

beforeEach(() => {
  listHistory.mockReset();
  deleteFromHistory.mockReset();
});

describe('HistoryList', () => {
  it('says so when there is no finished video yet', async () => {
    listHistory.mockResolvedValue([]);

    render(<HistoryList />);

    expect(await screen.findByText(/aucune vidéo/i)).toBeInTheDocument();
  });

  it('lists the videos with a link to their result page', async () => {
    listHistory.mockResolvedValue([entry('clip-1', 1000)]);

    render(<HistoryList />);

    expect(await screen.findByRole('link', { name: /voir/i })).toHaveAttribute(
      'href',
      '/rendu/clip-1/',
    );
    expect(screen.getByText(/12\s?s/)).toBeInTheDocument();
  });

  it('deletes a video when asked', async () => {
    const user = userEvent.setup();
    listHistory.mockResolvedValue([entry('clip-1', 1000)]);
    deleteFromHistory.mockResolvedValue(undefined);

    render(<HistoryList />);

    await user.click(await screen.findByRole('button', { name: /supprimer/i }));

    expect(deleteFromHistory).toHaveBeenCalledWith('clip-1');
    await waitFor(() => expect(screen.getByText(/aucune vidéo/i)).toBeInTheDocument());
  });
});
