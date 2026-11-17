import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderedVideo } from '@quran/render';
import {
  shareVideo,
  videoToFile,
  type ShareEnvironment,
  type ShareOptions,
} from '../src/lib/share';

function file(): File {
  return new File(['mp4 bytes'], 'quran-job.mp4', { type: 'video/mp4' });
}

/** An environment that records what the share chose to do. */
function env(overrides: Partial<ShareEnvironment> = {}): ShareEnvironment {
  return {
    canShare: () => true,
    share: vi.fn(async () => undefined),
    download: vi.fn(),
    electron: false,
    revealInFolder: vi.fn(),
    ...overrides,
  };
}

/** The plan's option-style controls, layered over an observable environment. */
function options(
  environment: ShareEnvironment,
  overrides: Partial<ShareOptions> = {},
): ShareOptions {
  return { ...environment, ...overrides };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('shareVideo', () => {
  it('uses the native share sheet when the file can be shared', async () => {
    const environment = env();
    const clip = file();

    const result = await shareVideo(clip, 'Yassin', options(environment, { canShare: true }));

    expect(result).toBe('shared');
    expect(environment.share).toHaveBeenCalledWith({ files: [clip], title: 'Yassin' });
    expect(environment.download).not.toHaveBeenCalled();
  });

  it('downloads instead when sharing files is unavailable', async () => {
    const environment = env();

    const result = await shareVideo(file(), 'Yassin', options(environment, { canShare: false }));

    expect(result).toBe('downloaded');
    expect(environment.download).toHaveBeenCalledOnce();
    expect(environment.share).not.toHaveBeenCalled();
  });

  it('treats AbortError as a quiet cancellation, not a failure', async () => {
    const environment = env({
      share: vi.fn(async () => {
        const error = new Error('the user dismissed the sheet');
        error.name = 'AbortError';
        throw error;
      }),
    });

    const result = await shareVideo(
      file(),
      'Yassin',
      options(environment, { canShare: true, shareThrows: 'AbortError' }),
    );

    expect(result).toBe('cancelled');
    expect(environment.download).not.toHaveBeenCalled();
  });

  it('falls back to download when a real share error occurs', async () => {
    const environment = env({
      share: vi.fn(async () => {
        const error = new Error('permission denied');
        error.name = 'NotAllowedError';
        throw error;
      }),
    });

    const result = await shareVideo(
      file(),
      'Yassin',
      options(environment, { canShare: true, shareThrows: 'NotAllowedError' }),
    );

    expect(result).toBe('downloaded');
    expect(environment.download).toHaveBeenCalledOnce();
  });

  it('reveals in the folder on Electron instead of using the share sheet', async () => {
    const environment = env({ electron: true });
    const clip = file();

    const result = await shareVideo(clip, 'Yassin', options(environment, { electron: true }));

    expect(result).toBe('shared');
    expect(environment.revealInFolder).toHaveBeenCalledWith(clip);
    expect(environment.share).not.toHaveBeenCalled();
    expect(environment.download).not.toHaveBeenCalled();
  });

  it('downloads on Electron until the native bridge is installed', async () => {
    const environment = env({ electron: true, revealInFolder: undefined });

    const result = await shareVideo(file(), 'Yassin', options(environment, { electron: true }));

    expect(result).toBe('downloaded');
    expect(environment.download).toHaveBeenCalledOnce();
  });

  it('wraps a RenderedVideo blob into a named File for sharing', async () => {
    const video: RenderedVideo = {
      blob: new Blob(['mp4'], { type: 'video/mp4' }),
      durationSec: 3,
      width: 1080,
      height: 1920,
      container: 'mp4',
      videoCodec: 'avc1',
    };

    const clip = videoToFile(video, 'job-7');

    expect(clip.name).toBe('quran-job-7.mp4');
    expect(clip.type).toBe('video/mp4');
    expect(await clip.text()).toBe('mp4');
  });
});
