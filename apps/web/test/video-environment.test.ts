import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemuxedSource } from '@quran/render';
import { videoBackgroundEnvironment } from '@/lib/video-environment';

const SOURCE: DemuxedSource = {
  codec: 'avc1.42e01e',
  codedWidth: 64,
  codedHeight: 64,
  samples: [],
  durationSec: 0,
};

/** jsdom has no codecs; only the constructor shape is used here. */
class FakeDecoder {
  configure(): void {}
  decode(): void {}
  async flush(): Promise<void> {}
  close(): void {}
}

class FakeChunk {
  constructor(_init: unknown) {}
}

const created: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminate = vi.fn();

  constructor(
    readonly url: URL,
    readonly options: unknown,
  ) {
    created.push(this);
  }

  postMessage(message: { id: number }): void {
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, source: SOURCE } }));
  }
}

function codecs(): void {
  vi.stubGlobal('VideoDecoder', FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk', FakeChunk);
}

afterEach(() => {
  vi.unstubAllGlobals();
  created.length = 0;
});

describe('videoBackgroundEnvironment', () => {
  it('has no worker to offer on a platform without one', () => {
    codecs();
    vi.stubGlobal('Worker', undefined);

    expect(videoBackgroundEnvironment().demuxSource).toBeUndefined();
  });

  it('sends the demux to a module worker, and spawns it only when needed', async () => {
    codecs();
    vi.stubGlobal('Worker', FakeWorker);

    const environment = videoBackgroundEnvironment();
    expect(created).toHaveLength(0);

    const source = await environment.demuxSource?.(new Blob(['bytes']));

    expect(source).toBe(SOURCE);
    expect(created).toHaveLength(1);
    expect(created[0].url.pathname).toMatch(/demux-worker-entry/);
    expect(created[0].options).toEqual({ type: 'module' });
    expect(created[0].terminate).toHaveBeenCalledOnce();
  });
});
