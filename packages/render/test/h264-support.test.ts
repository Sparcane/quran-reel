import { describe, expect, it } from 'vitest';
import { h264EncoderAvailable, type VideoEncoderFactory } from '../src/encoder-webcodecs';

/** A factory that answers from the codec name, the way a browser would. */
function factory(supported: (codec: string) => boolean): VideoEncoderFactory {
  return {
    isConfigSupported: async (config) => ({ supported: supported(config.codec) }),
  } as VideoEncoderFactory;
}

describe('h264EncoderAvailable', () => {
  it('is true as soon as one H.264 profile is accepted', async () => {
    const probe = factory((codec) => codec === 'avc1.42001f');

    await expect(h264EncoderAvailable(probe, 1080, 1920, 30)).resolves.toBe(true);
  });

  it('is false when every profile is refused', async () => {
    const probe = factory(() => false);

    await expect(h264EncoderAvailable(probe, 1080, 1920, 30)).resolves.toBe(false);
  });

  it('treats a probe that throws as a refusal', async () => {
    const probe = {
      async isConfigSupported() {
        throw new Error('no encoder for this config');
      },
    } as unknown as VideoEncoderFactory;

    await expect(h264EncoderAvailable(probe, 1080, 1920, 30)).resolves.toBe(false);
  });
});
