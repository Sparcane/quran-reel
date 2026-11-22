import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_SECONDS } from '@quran/core';
import { createGradientPainter, type BackgroundPainter } from '../src/background';
import type { EncodePlan } from '../src/encoder-plan';
import type { EncoderKind } from '../src/select-encoder';
import type { OutputSink, SinkKind } from '../src/sink';
import type { Progress, RenderedVideo, SubtitleStyle } from '../src/types';
import {
  createRenderer,
  runWorkerJob,
  type RenderEncode,
  type RenderWorkerLike,
  type RenderWorkerRequest,
  type RendererCapabilities,
  type RendererEnvironment,
  type WorkerRequest,
  type WorkerResponse,
} from '../src/worker';
import type { RenderSpec } from '../src/types';

const style: SubtitleStyle = {
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
};

function background(): BackgroundPainter {
  return createGradientPainter(
    { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
    { width: 1080, height: 1920 },
  );
}

function spec(overrides: Partial<RenderSpec> = {}): RenderSpec {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    verses: [{ arabic: 'بسم الله', translation: 'Au nom de Dieu', words: null, audio: null, durationSec: 2 }],
    style,
    background: background(),
    maxDurationSec: MAX_VIDEO_SECONDS,
    ...overrides,
  };
}

function video(): RenderedVideo {
  return {
    blob: new Blob(['video']),
    durationSec: 2,
    width: 1080,
    height: 1920,
    container: 'mp4',
    videoCodec: 'avc1',
  };
}

const ALL_CAPS: RendererCapabilities = {
  webCodecs: true,
  mediaRecorder: true,
  opfs: true,
  fsAccess: false,
};

function progress(percent: number): Progress {
  return { frame: Math.round((percent / 100) * 60), totalFrames: 60, percent, etaSec: 1 };
}

/** A stand-in for the module worker the renderer normally spawns. */
class FakeWorker implements RenderWorkerLike {
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  private cancelled = false;

  constructor(
    private readonly options: { percents?: number[]; block?: boolean; fail?: string; emitError?: string },
    readonly sent: WorkerRequest[],
  ) {}

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
    if (message.kind === 'cancel') {
      this.cancelled = true;
      if (this.release) this.release();
      return;
    }

    queueMicrotask(async () => {
      if (this.options.fail) {
        this.emit({ kind: 'error', id: message.id, message: this.options.fail });
        return;
      }
      if (this.options.emitError) {
        this.emitError(new Error(this.options.emitError));
        return;
      }
      if (this.options.block) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
        });
      }
      if (this.cancelled) {
        this.emit({ kind: 'cancelled', id: message.id });
        return;
      }
      for (const percent of this.options.percents ?? [0, 50, 100]) {
        this.emit({ kind: 'progress', id: message.id, progress: progress(percent) });
      }
      this.emit({ kind: 'done', id: message.id, video: video() });
    });
  }

  private release: (() => void) | null = null;

  emit(message: WorkerResponse): void {
    this.onmessage?.({ data: message });
  }

  emitError(error: unknown): void {
    this.onerror?.(error);
  }

  terminate(): void {
    this.terminated = true;
  }
}

interface WorkerHub {
  factory: () => RenderWorkerLike;
  sent: WorkerRequest[];
  worker: FakeWorker | null;
}

function workerHub(options: ConstructorParameters<typeof FakeWorker>[0] = {}): WorkerHub {
  const sent: WorkerRequest[] = [];
  const hub: WorkerHub = {
    sent,
    worker: null,
    factory: () => {
      hub.worker = new FakeWorker(options, sent);
      return hub.worker;
    },
  };
  return hub;
}

interface SinkSpy {
  sink: OutputSink;
  aborted: boolean;
  finalized: boolean;
}

function sinkSpy(): SinkSpy {
  const spy: SinkSpy = {
    aborted: false,
    finalized: false,
    sink: {
      bytesWritten: 0,
      async write() {},
      async finalize() {
        spy.finalized = true;
        return video().blob;
      },
      async abort() {
        spy.aborted = true;
      },
    },
  };
  return spy;
}

function environment(overrides: Partial<RendererEnvironment> = {}): RendererEnvironment {
  return {
    createWorker: () => null,
    capabilities: ALL_CAPS,
    createSink: async () => sinkSpy().sink,
    encode: async () => video(),
    now: () => Date.now(),
    ...overrides,
  };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('createRenderer', () => {
  it('runs the render in a worker and forwards monotone progress through 100', async () => {
    const hub = workerHub({ percents: [0, 25, 60, 100] });
    const renderer = createRenderer(environment({ createWorker: hub.factory }));
    const seen: number[] = [];

    const result = await renderer.render(spec(), (p) => seen.push(p.percent));

    expect(seen).toEqual([0, 25, 60, 100]);
    expect(seen.every((value, index) => index === 0 || value >= seen[index - 1])).toBe(true);
    expect(result).toMatchObject({ container: 'mp4', videoCodec: 'avc1', durationSec: 2 });
    expect(hub.sent).toHaveLength(1);
    expect(hub.sent[0]).toMatchObject({ kind: 'render', sinkKind: 'memory' });
    expect((hub.sent[0] as RenderWorkerRequest).plan.timeline.entries).toHaveLength(1);
  });

  it('never asks a worker for a sink the worker itself cannot create', async () => {
    // Chrome desktop advertises showSaveFilePicker on the window, but a module
    // worker has no such API. Picking it here hangs the render: createSink throws
    // in the worker before any response is posted back.
    const hub = workerHub({ percents: [100] });
    const renderer = createRenderer(
      environment({
        createWorker: hub.factory,
        capabilities: { ...ALL_CAPS, fsAccess: true },
      }),
    );

    await renderer.render(spec(), () => {});

    expect(hub.sent[0]).toMatchObject({ sinkKind: 'memory' });
  });

  it('refuses a video over 900 seconds before starting a worker', async () => {
    const hub = workerHub();
    const renderer = createRenderer(environment({ createWorker: hub.factory }));

    await expect(
      renderer.render(spec({ verses: [{ ...spec().verses[0], durationSec: 901 }] }), () => {}),
    ).rejects.toThrow(/900|limit/i);
    expect(hub.sent).toHaveLength(0);
  });

  it('refuses a limit above the hard 900-second ceiling', async () => {
    const renderer = createRenderer(environment());
    await expect(
      renderer.render(spec({ maxDurationSec: 1_000 }), () => {}),
    ).rejects.toThrow(/900|limit/i);
  });

  it('cancels a worker render and reports the cancellation', async () => {
    const hub = workerHub({ block: true });
    const renderer = createRenderer(environment({ createWorker: hub.factory }));

    const pending = renderer.render(spec(), () => {});
    await flush();
    renderer.cancel();

    await expect(pending).rejects.toThrow(/cancel/i);
    expect(hub.sent.map((message) => message.kind)).toEqual(['render', 'cancel']);
  });

  it('propagates an error reported by the worker', async () => {
    const renderer = createRenderer(environment({ createWorker: workerHub({ fail: 'GPU lost' }).factory }));
    await expect(renderer.render(spec(), () => {})).rejects.toThrow(/GPU lost/);
  });

  it('propagates a worker startup error event', async () => {
    const hub = workerHub({ emitError: 'worker failed to load' });
    const renderer = createRenderer(environment({ createWorker: hub.factory }));
    await expect(renderer.render(spec(), () => {})).rejects.toThrow(/worker failed to load/);
  });

  it('renders inline when no worker can be created and still ends at 100', async () => {
    const spy = sinkSpy();
    const kinds: EncoderKind[] = [];
    const renderer = createRenderer(
      environment({
        createSink: async () => spy.sink,
        encode: async (kind) => {
          kinds.push(kind);
          return video();
        },
      }),
    );
    const seen: number[] = [];

    const result = await renderer.render(spec(), (p) => seen.push(p.percent));

    expect(result.container).toBe('mp4');
    expect(kinds).toEqual(['webcodecs']);
    expect(seen.at(-1)).toBe(100);
    expect(spy.finalized).toBe(false);
  });

  it('uses the MediaRecorder path when WebCodecs is absent', async () => {
    const kinds: EncoderKind[] = [];
    const renderer = createRenderer(
      environment({
        capabilities: { ...ALL_CAPS, webCodecs: false },
        encode: async (kind) => {
          kinds.push(kind);
          return video();
        },
      }),
    );

    await renderer.render(spec(), () => {});

    expect(kinds).toEqual(['mediarecorder']);
  });

  it('uses MediaRecorder when WebCodecs has no H.264 encoder for this picture', async () => {
    // Firefox exposes VideoEncoder but cannot encode avc1. Asking it for a
    // worker here would fail at frame zero instead of taking the fallback.
    const hub = workerHub({ percents: [100] });
    const kinds: EncoderKind[] = [];
    const renderer = createRenderer(
      environment({
        createWorker: hub.factory,
        h264Supported: async () => false,
        encode: async (kind) => {
          kinds.push(kind);
          return video();
        },
      }),
    );

    await renderer.render(spec(), () => {});

    expect(kinds).toEqual(['mediarecorder']);
    expect(hub.sent).toHaveLength(0);
  });

  it('refuses a browser with no encoder at all', async () => {
    const renderer = createRenderer(
      environment({ capabilities: { ...ALL_CAPS, webCodecs: false, mediaRecorder: false } }),
    );
    await expect(renderer.render(spec(), () => {})).rejects.toThrow(/encoder/i);
  });

  it('aborts the sink when an inline render is cancelled', async () => {
    const spy = sinkSpy();
    const renderer = createRenderer(
      environment({
        createSink: async () => spy.sink,
        encode: () => new Promise<RenderedVideo>(() => {}),
      }),
    );

    const pending = renderer.render(spec(), () => {});
    await flush();
    renderer.cancel();

    await expect(pending).rejects.toThrow(/cancel/i);
    expect(spy.aborted).toBe(true);
  });

  it('stops the inline encoder instead of letting it run to completion', async () => {
    // One render outlives the click that cancels it: the encoder keeps painting
    // frames until it notices. On the main thread that is up to fifteen minutes
    // of CPU for a video nobody will ever see, plus a MediaRecorder and an
    // AudioContext left running.
    let encoded = 0;
    let completed = false;
    const renderer = createRenderer(
      environment({
        encode: async (_kind, _plan, _sink, onProgress) => {
          for (let frame = 1; frame <= 20; frame += 1) {
            encoded = frame;
            onProgress(progress(frame * 5));
            await Promise.resolve();
          }
          completed = true;
          return video();
        },
      }),
    );

    const pending = renderer.render(spec(), () => {});
    await flush();
    renderer.cancel();

    await expect(pending).rejects.toThrow(/cancel/i);
    await flush(40);

    expect(completed).toBe(false);
    expect(encoded).toBeLessThan(20);
  });

  it('aborts the sink when an inline encode fails', async () => {
    const spy = sinkSpy();
    const renderer = createRenderer(
      environment({
        createSink: async () => spy.sink,
        encode: async () => {
          throw new Error('encoder broke');
        },
      }),
    );

    await expect(renderer.render(spec(), () => {})).rejects.toThrow(/encoder broke/);
    expect(spy.aborted).toBe(true);
  });

  it('passes the chosen sink kind to createSink', async () => {
    const kinds: SinkKind[] = [];
    const renderer = createRenderer(
      environment({
        createSink: async (kind) => {
          kinds.push(kind);
          return sinkSpy().sink;
        },
      }),
    );

    await renderer.render(spec(), () => {});

    expect(kinds).toEqual(['memory']);
  });
});

describe('runWorkerJob', () => {
  function scope() {
    const messages: WorkerResponse[] = [];
    return { messages, post: (message: WorkerResponse) => messages.push(message) };
  }

  it('reports progress from the encoder and posts the finished video', async () => {
    const target = scope();
    let cancelled = false;
    const sink = sinkSpy();

    await runWorkerJob(
      { kind: 'render', id: 7, plan: {} as EncodePlan, sinkKind: 'memory', fileName: 'x.mp4' },
      target.post,
      () => cancelled,
      {
        createSink: async () => sink.sink,
        encode: async (_kind, _plan, _sink, onProgress) => {
          onProgress(progress(40));
          return video();
        },
      },
    );

    expect(target.messages.map((message) => message.kind)).toEqual(['progress', 'done']);
    expect(target.messages[0]).toMatchObject({ id: 7, progress: { percent: 40 } });
  });

  it('aborts the sink and reports cancellation when the flag flips', async () => {
    const target = scope();
    let cancelled = false;
    const sink = sinkSpy();
    const encode: RenderEncode = async (_kind, _plan, _sink, onProgress) => {
      cancelled = true;
      onProgress(progress(20));
      return video();
    };

    await runWorkerJob(
      { kind: 'render', id: 3, plan: {} as EncodePlan, sinkKind: 'memory', fileName: 'x.mp4' },
      target.post,
      () => cancelled,
      { createSink: async () => sink.sink, encode },
    );

    expect(target.messages.map((message) => message.kind)).toEqual(['cancelled']);
    expect(sink.aborted).toBe(true);
  });

  it('posts an error when the sink cannot be created', async () => {
    const target = scope();

    await runWorkerJob(
      { kind: 'render', id: 11, plan: {} as EncodePlan, sinkKind: 'fs-access', fileName: 'x.mp4' },
      target.post,
      () => false,
      {
        createSink: async () => {
          throw new Error('sink: the File System Access API is not available in this browser');
        },
        encode: async () => video(),
      },
    );

    expect(target.messages.map((message) => message.kind)).toEqual(['error']);
    expect(target.messages[0]).toMatchObject({ id: 11, message: /File System Access/ });
  });
});
