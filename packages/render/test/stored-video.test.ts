import { describe, expect, it } from 'vitest';
import { fromStoredVideo, toStoredVideo } from '../src/stored-video';
import type { RenderedVideo } from '../src/types';

const video: RenderedVideo = {
  blob: new Blob(['mp4 bytes'], { type: 'video/mp4' }),
  durationSec: 12.5,
  width: 1080,
  height: 1920,
  container: 'mp4',
  videoCodec: 'avc1',
};

describe('stored video', () => {
  it('keeps the bytes and the MIME type in a plain record', async () => {
    const stored = await toStoredVideo(video);

    expect(stored.mime).toBe('video/mp4');
    expect(new TextDecoder().decode(stored.bytes)).toBe('mp4 bytes');
    expect(stored).toMatchObject({
      durationSec: 12.5,
      width: 1080,
      height: 1920,
      container: 'mp4',
      videoCodec: 'avc1',
    });
    expect(stored).not.toHaveProperty('blob');
  });

  it('rebuilds a blob with the same bytes and metadata', async () => {
    const restored = fromStoredVideo(await toStoredVideo(video));

    expect(restored.blob.type).toBe(video.blob.type);
    expect(await restored.blob.text()).toBe(await video.blob.text());
    expect(restored).toMatchObject({
      durationSec: video.durationSec,
      width: video.width,
      height: video.height,
      container: video.container,
      videoCodec: video.videoCodec,
    });
  });
});
