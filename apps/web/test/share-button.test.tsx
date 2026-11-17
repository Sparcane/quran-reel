import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ShareButton } from '../src/components/ShareButton';
import { shareVideo } from '../src/lib/share';

vi.mock('../src/lib/share', () => ({
  shareVideo: vi.fn(),
}));

const mockedShare = vi.mocked(shareVideo);

function clip(): File {
  return new File(['mp4'], 'quran-job.mp4', { type: 'video/mp4' });
}

beforeEach(() => {
  mockedShare.mockReset();
});

describe('ShareButton', () => {
  it('offers a share action', () => {
    render(<ShareButton file={clip()} title="Yassin" />);

    expect(screen.getByRole('button', { name: /partager/i })).toBeEnabled();
  });

  it('shares the file with its title and reports the result', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    mockedShare.mockResolvedValue('shared');
    const file = clip();

    render(<ShareButton file={file} title="Yassin" onResult={onResult} />);
    await user.click(screen.getByRole('button', { name: /partager/i }));

    expect(mockedShare).toHaveBeenCalledWith(file, 'Yassin');
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('shared'));
  });

  it('stays quiet when the user cancels the share sheet', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    mockedShare.mockResolvedValue('cancelled');

    render(<ShareButton file={clip()} title="Yassin" onResult={onResult} />);
    await user.click(screen.getByRole('button', { name: /partager/i }));

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('cancelled'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an honest error when sharing really fails', async () => {
    const user = userEvent.setup();
    mockedShare.mockRejectedValue(new Error('share unavailable'));

    render(<ShareButton file={clip()} title="Yassin" />);
    await user.click(screen.getByRole('button', { name: /partager/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
