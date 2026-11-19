import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PaintContext, Size } from '../src/background';
import {
  createVideoPainter,
  defaultBackgroundVideoEnvironment,
  frameBudget,
  MAX_FRAMES,
  type BackgroundVideoEnvironment,
  type VideoChunkInit,
  type VideoChunkLike,
  type VideoDecoderConfigLike,
  type VideoDecoderInitLike,
  type VideoDecoderLike,
  type VideoFrameLike,
} from '../src/background-video';

const SIZE: Size = { width: 1080, height: 1920 };

/** 120 samples × 33 ticks at a 1000-tick timescale. */
const SOURCE_SECONDS = 3.96;

/** The exact AVCDecoderConfigurationRecord the fixture carries. */
const AVC_C = Uint8Array.of(
  0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1,
  0x00, 0x08, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x41, 0x41,
  0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80,
);

function fixture(name: string): Blob {
  const path = resolve(process.cwd(), 'packages/render/test/fixtures', name);
  return new Blob([new Uint8Array(readFileSync(path))]);
}

interface FakeFrame extends VideoFrameLike {
  readonly mark: number;
  closed: boolean;
}

interface FakeCopy {
  readonly timestamp: number;
  readonly image: { readonly mark: number };
  closed: boolean;
  close(): void;
}

interface Harness {
  env: BackgroundVideoEnvironment;
  configs: VideoDecoderConfigLike[];
  chunks: VideoChunkLike[];
  frames: FakeFrame[];
  closedFrames: FakeFrame[];
  copies: FakeCopy[];
  closedCopies: FakeCopy[];
  decoderClosed: boolean;
  failWith: Error | null;
}

/**
 * jsdom has no `VideoDecoder`, no `EncodedVideoChunk` and no `VideoFrame`.
 * The stand-in keeps the payload of each fake NAL unit as a `mark` so a test can
 * tell exactly which source frame was drawn, and delivers output asynchronously
 * like the real decoder does.
 */
function makeHarness(): Harness {
  const configs: VideoDecoderConfigLike[] = [];
  const chunks: VideoChunkLike[] = [];
  const frames: FakeFrame[] = [];
  const closedFrames: FakeFrame[] = [];
  const copies: FakeCopy[] = [];
  const closedCopies: FakeCopy[] = [];
  let decoderClosed = false;
  let failWith: Error | null = null;
  let pending = 0;

  class FakeVideoDecoder implements VideoDecoderLike {
    state = 'unconfigured';
    decodeQueueSize = 0;

    constructor(private readonly init: VideoDecoderInitLike) {}

    configure(config: VideoDecoderConfigLike): void {
      configs.push(config);
      this.state = 'configured';
    }

    decode(chunk: VideoChunkLike): void {
      chunks.push(chunk);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const frame: FakeFrame = {
        timestamp: chunk.timestamp,
        displayWidth: 64,
        displayHeight: 64,
        mark: data[4] | (data[5] << 8),
        closed: false,
        close() {
          this.closed = true;
          closedFrames.push(this);
        },
      };
      frames.push(frame);
      pending += 1;
      queueMicrotask(() => {
        pending -= 1;
        if (failWith) {
          this.init.error(failWith);
          return;
        }
        this.init.output(frame);
      });
    }

    async flush(): Promise<void> {
      while (pending > 0) await Promise.resolve();
      if (failWith) throw failWith;
    }

    close(): void {
      decoderClosed = true;
      this.state = 'closed';
    }
  }

  const env = {
    videoDecoder: FakeVideoDecoder,
    createChunk: (init: VideoChunkInit) => ({
      type: init.type,
      timestamp: init.timestamp,
      duration: init.duration,
      byteLength: init.data.byteLength,
      copyTo(destination: Uint8Array): void {
        destination.set(init.data.subarray(0, destination.length));
      },
    }),
    // What the real environment does: take an owned copy and free the decoder
    // buffer at once, so its small pool keeps rotating.
    copyFrame(frame: FakeFrame): FakeCopy {
      const copy: FakeCopy = {
        timestamp: frame.timestamp,
        image: { mark: frame.mark },
        closed: false,
        close() {
          this.closed = true;
          closedCopies.push(this);
        },
      };
      copies.push(copy);
      frame.close();
      return copy;
    },
  };

  return {
    env: env as unknown as BackgroundVideoEnvironment,
    configs,
    chunks,
    frames,
    closedFrames,
    copies,
    closedCopies,
    get decoderClosed() {
      return decoderClosed;
    },
    get failWith() {
      return failWith;
    },
    set failWith(value: Error | null) {
      failWith = value;
    },
  };
}

interface Draw {
  frame: FakeFrame;
  x: number;
  y: number;
  width: number;
  height: number;
}

function makePaintContext(): { ctx: PaintContext; draws: Draw[] } {
  const draws: Draw[] = [];
  const ctx = {
    fillStyle: '#000000',
    globalAlpha: 1,
    save() {},
    restore() {},
    fillRect() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    drawImage(image: unknown, x: number, y: number, width: number, height: number) {
      draws.push({ frame: image as FakeFrame, x, y, width, height });
    },
  };
  return { ctx: ctx as unknown as PaintContext, draws };
}

describe('createVideoPainter', () => {
  it('decodes the H.264 source and paints a different frame as t advances', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      4,
      harness.env,
    );

    expect(painter.ready).toBe(true);
    expect(harness.frames).toHaveLength(120);

    const { ctx, draws } = makePaintContext();
    painter.paint(ctx, 0);
    painter.paint(ctx, 2);

    expect(draws).toHaveLength(2);
    expect(draws[0].frame.mark).toBe(0);
    expect(draws[1].frame.mark).toBe(60);
    expect(draws[0].frame).not.toBe(draws[1].frame);
  });

  it('copies every decoded frame into an owned surface and frees the decoder buffer at once', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      4,
      harness.env,
    );

    expect(harness.copies).toHaveLength(120);
    // A real decoder stops pulling input once too many frames stay open.
    expect(harness.frames.every((frame) => frame.closed)).toBe(true);

    const { ctx, draws } = makePaintContext();
    painter.paint(ctx, 2);
    expect(draws[0].frame.mark).toBe(60);

    painter.dispose();
    expect(harness.closedCopies).toHaveLength(120);
  });

  it('bounds the picture bytes it keeps, not just the number of frames', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      new Blob(['movie']),
      SIZE,
      3,
      {
        ...harness.env,
        demuxSource: async () => ({
          codec: 'avc1.42e01e',
          codedWidth: 1920,
          codedHeight: 1080,
          samples: Array.from({ length: 90 }, (_, index) => ({
            type: 'key' as const,
            timestampUs: index * 33_000,
            durationUs: 33_000,
            data: Uint8Array.of(1),
          })),
          durationSec: 3,
        }),
      },
    );

    expect(harness.copies).toHaveLength(frameBudget(1920, 1080));
    expect(harness.copies.length).toBeLessThan(MAX_FRAMES);
    painter.dispose();
  });

  it('configures the decoder with the codec, size and avcC description', async () => {
    const harness = makeHarness();
    await createVideoPainter(fixture('background.h264.mp4'), SIZE, 4, harness.env);

    expect(harness.configs).toHaveLength(1);
    expect(harness.configs[0]).toMatchObject({
      codec: 'avc1.64001f',
      codedWidth: 64,
      codedHeight: 64,
      optimizeForLatency: true,
    });
    expect(Array.from(harness.configs[0].description ?? [])).toEqual(Array.from(AVC_C));
  });

  it('feeds length-prefixed samples with key flags and microsecond timestamps', async () => {
    const harness = makeHarness();
    await createVideoPainter(fixture('background.h264.mp4'), SIZE, 4, harness.env);

    expect(harness.chunks).toHaveLength(120);
    expect(harness.chunks[0]).toMatchObject({ type: 'key', timestamp: 0, duration: 33_000 });
    expect(harness.chunks[1]).toMatchObject({ type: 'delta', timestamp: 33_000 });
    expect(harness.chunks[60].timestamp).toBe(1_980_000);
  });

  it('rejects a non-H.264 codec before decoding anything', async () => {
    const harness = makeHarness();
    await expect(
      createVideoPainter(fixture('background.hevc.mp4'), SIZE, 4, harness.env),
    ).rejects.toThrow(/codec/i);
    expect(harness.chunks).toHaveLength(0);
  });

  it('accepts avc3, the H.264 flavour with in-band parameter sets', async () => {
    const painter = await createVideoPainter(
      fixture('background.avc3.mp4'),
      SIZE,
      4,
      makeHarness().env,
    );
    expect(painter.ready).toBe(true);
  });

  it('loops the short source over a longer requested duration', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      10,
      harness.env,
    );
    const { ctx, draws } = makePaintContext();

    painter.paint(ctx, 0);
    painter.paint(ctx, SOURCE_SECONDS);
    painter.paint(ctx, SOURCE_SECONDS + 2);

    expect(draws.map((draw) => draw.frame.mark)).toEqual([0, 0, 60]);
  });

  it('draws the selected frame across the whole requested size', async () => {
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      4,
      makeHarness().env,
    );
    const { ctx, draws } = makePaintContext();

    painter.paint(ctx, 1);

    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('reuses decoded frames instead of decoding again when painting backwards', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      4,
      harness.env,
    );
    const { ctx, draws } = makePaintContext();

    painter.paint(ctx, 0);
    painter.paint(ctx, 0);
    painter.paint(ctx, 2);
    painter.paint(ctx, 0);

    expect(harness.chunks).toHaveLength(120);
    expect(draws.map((draw) => draw.frame.mark)).toEqual([0, 0, 60, 0]);
  });

  it('closes decoded frames and the decoder on dispose', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      4,
      harness.env,
    );
    const { ctx, draws } = makePaintContext();

    painter.dispose();
    expect(painter.ready).toBe(false);
    expect(harness.closedFrames).toHaveLength(120);
    expect(harness.decoderClosed).toBe(true);

    painter.paint(ctx, 0);
    expect(draws).toHaveLength(0);
  });

  it('propagates a decoder failure', async () => {
    const harness = makeHarness();
    harness.failWith = new Error('decoder lost its device');
    await expect(
      createVideoPainter(fixture('background.h264.mp4'), SIZE, 4, harness.env),
    ).rejects.toThrow(/decoder lost its device/);
  });

  it('rejects a non-positive duration', async () => {
    await expect(
      createVideoPainter(fixture('background.h264.mp4'), SIZE, 0, makeHarness().env),
    ).rejects.toThrow(/duration/i);
  });

  it('rejects a file with no video track', async () => {
    await expect(
      createVideoPainter(new Blob([]), SIZE, 4, makeHarness().env),
    ).rejects.toThrow(/video/i);
  });

  it('demuxes through the environment instead of reading the bytes here', async () => {
    const harness = makeHarness();
    const demuxSource = vi.fn(async () => ({
      codec: 'avc1.42e01e',
      codedWidth: 64,
      codedHeight: 64,
      samples: [
        { type: 'key' as const, timestampUs: 0, durationUs: 33_000, data: Uint8Array.of(1) },
      ],
      durationSec: 0.033,
    }));

    // The bytes are not a movie at all: only the injected reader can succeed,
    // which is what proves the painter did not parse them on this thread.
    const painter = await createVideoPainter(new Blob(['pixels']), SIZE, 4, {
      ...harness.env,
      demuxSource,
    });

    expect(demuxSource).toHaveBeenCalledOnce();
    expect(harness.chunks).toHaveLength(1);
    painter.dispose();
  });

  it('reports a missing WebCodecs stack when there is no injected environment', () => {
    expect(() => defaultBackgroundVideoEnvironment({})).toThrow(/WebCodecs/i);
  });
});

describe('the frame budget', () => {
  it('keeps the whole clip for a small source', () => {
    expect(frameBudget(64, 64)).toBe(MAX_FRAMES);
    expect(frameBudget(0, 0)).toBe(MAX_FRAMES);
  });

  it('keeps fewer frames as the decoded picture grows', () => {
    const hd = frameBudget(1920, 1080);
    const uhd = frameBudget(3840, 2160);

    expect(hd).toBeLessThan(MAX_FRAMES);
    expect(uhd).toBeLessThan(hd);
    expect(uhd).toBeGreaterThan(0);
  });

  it('stops decoding once the budget is spent and loops the window it kept', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      10,
      harness.env,
      { maxFrames: 30 },
    );

    // Thirty frames of 33 ms: the loop is 0.99 s, not the 3.96 s of the file.
    expect(harness.chunks).toHaveLength(30);
    expect(harness.frames).toHaveLength(30);

    const { ctx, draws } = makePaintContext();
    painter.paint(ctx, 0);
    painter.paint(ctx, 0.5);
    painter.paint(ctx, 0.99);

    expect(draws.map((draw) => draw.frame.mark)).toEqual([0, 15, 0]);
  });

  it('closes only the frames it kept', async () => {
    const harness = makeHarness();
    const painter = await createVideoPainter(
      fixture('background.h264.mp4'),
      SIZE,
      10,
      harness.env,
      { maxFrames: 30 },
    );

    painter.dispose();

    expect(harness.frames).toHaveLength(30);
    expect(harness.closedFrames).toHaveLength(30);
  });
});
