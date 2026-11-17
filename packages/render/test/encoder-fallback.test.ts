import { describe, expect, it } from 'vitest';
import { buildTimeline } from '@quran/core';
import { createGradientPainter, type BackgroundPainter } from '../src/background';
import {
  EncoderUnavailableError,
  type EncodePlan,
  type PlanarAudio,
  type VerseClip,
} from '../src/encoder-plan';
import {
  defaultMediaRecorderEnvironment,
  describeRecording,
  encodeMediaRecorder,
  mediaRecorderAvailable,
  MEDIA_RECORDER_MIME_TYPES,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type MediaRecorderEnvironment,
  type MediaRecorderFactory,
  type MediaRecorderLike,
  type MediaRecorderOptionsLike,
  type MediaStreamLike,
  type MediaStreamTrackLike,
  type RecordableCanvas,
} from '../src/encoder-mediarecorder';
import { selectEncoder } from '../src/select-encoder';
import { createSink, type OutputSink } from '../src/sink';
import type { Progress, SubtitleStyle } from '../src/types';

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

const SAMPLE_RATE = 48_000;

function recordingCanvas(width: number, height: number): RecordableCanvas {
  const ctx = {
    fillStyle: '#000000' as string | CanvasGradient,
    globalAlpha: 1,
    font: '',
    direction: 'ltr' as CanvasDirection,
    textAlign: 'center' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    save() {},
    restore() {},
    fillRect() {},
    createLinearGradient() {
      return { addColorStop() {} };
    },
    drawImage() {},
    measureText(text: string) {
      return { width: text.length * 10 };
    },
    fillText() {},
  };

  return {
    width,
    height,
    getContext: () => ctx,
    captureStream: () => {
      throw new Error('captureStream must be replaced by the harness');
    },
  };
}

function gradient(width: number, height: number): BackgroundPainter {
  return createGradientPainter(
    { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
    { width, height },
  );
}

function audioOf(durationSec: number): PlanarAudio {
  const length = Math.round(durationSec * SAMPLE_RATE);
  const data = Float32Array.from({ length }, (_, index) => (index % 11) * 0.01);

  return {
    sampleRate: SAMPLE_RATE,
    length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

function verse(durationSec: number, options: { audio?: PlanarAudio | null } = {}): VerseClip {
  return {
    arabic: 'بسم الله الرحمن الرحيم',
    translation: 'Au nom de Dieu, le Tout Miséricordieux',
    words: null,
    audio: options.audio === undefined ? audioOf(durationSec) : options.audio,
    durationSec,
  };
}

function planFor(verses: VerseClip[], overrides: Partial<EncodePlan> = {}): EncodePlan {
  const width = overrides.width ?? 1080;
  const height = overrides.height ?? 1920;

  return {
    width,
    height,
    fps: 30,
    verses,
    style,
    timeline: buildTimeline(verses.map((clip) => clip.durationSec)),
    background: gradient(width, height),
    ...overrides,
  };
}

class FakeTrack implements MediaStreamTrackLike {
  stopped = false;

  constructor(readonly kind: 'audio' | 'video') {}

  stop(): void {
    this.stopped = true;
  }
}

class FakeStream implements MediaStreamLike {
  readonly tracks: FakeTrack[];

  constructor(...tracks: FakeTrack[]) {
    this.tracks = tracks;
  }

  addTrack(track: MediaStreamTrackLike): void {
    this.tracks.push(track as FakeTrack);
  }

  getTracks(): MediaStreamTrackLike[] {
    return this.tracks;
  }

  getAudioTracks(): MediaStreamTrackLike[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
}

class FakeBuffer implements AudioBufferLike {
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

class FakeSource implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null;
  connected: unknown[] = [];
  startedAt: number | null = null;

  connect(destination: unknown): void {
    this.connected.push(destination);
  }

  start(when?: number): void {
    this.startedAt = when ?? 0;
  }
}

class FakeAudioContext implements AudioContextLike {
  readonly sources: FakeSource[] = [];
  readonly destinations: MediaStreamLike[] = [];
  readonly buffers: FakeBuffer[] = [];
  currentTime = 0;
  closed = false;

  constructor(readonly sampleRate: number) {}

  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike {
    const buffer = new FakeBuffer(numberOfChannels, length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): AudioBufferSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createMediaStreamDestination(): { stream: MediaStreamLike } {
    const stream = new FakeStream(new FakeTrack('audio'));
    this.destinations.push(stream);
    return { stream };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeRecorder implements MediaRecorderLike {
  readonly mimeType: string;
  readonly options: MediaRecorderOptionsLike | undefined;
  readonly stream: MediaStreamLike;
  state = 'inactive';
  emitted = 0;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  onerror: ((event: { error?: Error }) => void) | null = null;

  constructor(stream: MediaStreamLike, options: MediaRecorderOptionsLike | undefined) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType ?? 'video/webm';
  }

  start(): void {
    this.state = 'recording';
    if (optionsOf(this).failOnStart) {
      queueMicrotask(() => {
        this.state = 'inactive';
        this.onerror?.({ error: new Error('the recorder could not start') });
      });
    }
  }

  /** One `dataavailable` chunk, as a timeslice would deliver. */
  emit(): void {
    if (!this.ondataavailable) return;
    this.emitted += 1;
    this.ondataavailable({ data: new Blob([Uint8Array.of(this.emitted & 0xff, 2, 3)]) });
  }

  stop(): void {
    if (this.state !== 'recording') return;
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([Uint8Array.of(0xff, 0xfe)]) });
      this.onstop?.(new Event('stop'));
    });
  }
}

/** Options the harness carries on the class so a recorder can read them. */
interface HarnessRecorderOptions extends MediaRecorderOptionsLike {
  failOnStart?: boolean;
}

function optionsOf(recorder: FakeRecorder): HarnessRecorderOptions {
  return (recorder.options ?? {}) as HarnessRecorderOptions;
}

interface HarnessOptions {
  /** MIME types the fake browser claims to support. Default: everything. */
  supported?: string[];
  /** Make the recorder fail as soon as it starts. */
  failOnStart?: boolean;
}

interface Harness {
  env: MediaRecorderEnvironment;
  audioContexts: FakeAudioContext[];
  recorders: FakeRecorder[];
  streams: FakeStream[];
  captureRates: number[];
  framesDrawn: number;
}

/**
 * jsdom has neither `MediaRecorder`, `AudioContext`, nor a canvas that can be
 * captured. This harness replaces the four with stand-ins driven by a virtual
 * clock, so the sequencing — codec choice, scheduled audio, chunk writes — is
 * what the tests check, without waiting fifteen minutes of real time.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const audioContexts: FakeAudioContext[] = [];
  const recorders: FakeRecorder[] = [];
  const streams: FakeStream[] = [];
  const captureRates: number[] = [];

  let recorder: FakeRecorder | null = null;
  let clock = 0;
  let frameHandle = 0;
  let framesDrawn = 0;
  const cancelled = new Set<number>();

  const supported = options.supported;

  class HarnessRecorder extends FakeRecorder {
    constructor(stream: MediaStreamLike, recorderOptions?: MediaRecorderOptionsLike) {
      super(
        stream,
        { ...recorderOptions, failOnStart: options.failOnStart } as HarnessRecorderOptions,
      );
      recorder = this;
      recorders.push(this);
    }
  }

  const MediaRecorderClass = HarnessRecorder as unknown as MediaRecorderFactory;
  (MediaRecorderClass as unknown as { isTypeSupported?: (type: string) => boolean }).isTypeSupported =
    (type) => (supported ? supported.includes(type) : true);

  const env: MediaRecorderEnvironment = {
    createCanvas: (width, height) => {
      const canvas = recordingCanvas(width, height);
      canvas.captureStream = (fps = 30) => {
        captureRates.push(fps);
        const stream = new FakeStream(new FakeTrack('video'));
        streams.push(stream);
        return stream;
      };
      return canvas;
    },
    createAudioContext: (sampleRate) => {
      const context = new FakeAudioContext(sampleRate);
      audioContexts.push(context);
      return context;
    },
    MediaRecorder: MediaRecorderClass,
    isTypeSupported: (type) => (supported ? supported.includes(type) : true),
    requestFrame: (callback) => {
      frameHandle += 1;
      const handle = frameHandle;
      queueMicrotask(() => {
        if (cancelled.has(handle)) return;
        framesDrawn += 1;
        // A timeslice of about half a second, delivered at frame boundaries.
        if (recorder && recorder.state === 'recording' && framesDrawn % 15 === 0) recorder.emit();
        clock += 1000 / 30;
        callback();
      });
      return handle;
    },
    cancelFrame: (handle) => {
      cancelled.add(handle);
    },
    now: () => clock,
  };

  return {
    env,
    audioContexts,
    recorders,
    streams,
    captureRates,
    get framesDrawn() {
      return framesDrawn;
    },
  };
}

async function render(plan: EncodePlan, harness: Harness, sink?: OutputSink) {
  const output = sink ?? (await createSink('memory', 'video.webm'));
  const progress: Progress[] = [];

  const result = await encodeMediaRecorder(plan, output, (value) => progress.push(value), harness.env);
  const bytes = new Uint8Array(await (await output.finalize()).arrayBuffer());

  return { result, bytes, progress, sink: output };
}

async function renderFailure(plan: EncodePlan, harness: Harness, sink?: OutputSink) {
  const output = sink ?? (await createSink('memory', 'video.webm'));
  const progress: Progress[] = [];

  let error: unknown;
  try {
    await encodeMediaRecorder(plan, output, (value) => progress.push(value), harness.env);
  } catch (caught) {
    error = caught;
  }

  return { error, progress, sink: output };
}

describe('selectEncoder', () => {
  it('prefers WebCodecs whenever the browser has it', () => {
    expect(selectEncoder({ webCodecs: true, mediaRecorder: true })).toBe('webcodecs');
    expect(selectEncoder({ webCodecs: true, mediaRecorder: false })).toBe('webcodecs');
  });

  it('falls back to MediaRecorder, and admits when there is nothing', () => {
    expect(selectEncoder({ webCodecs: false, mediaRecorder: true })).toBe('mediarecorder');
    expect(selectEncoder({ webCodecs: false, mediaRecorder: false })).toBe('none');
  });
});

describe('describeRecording', () => {
  it('reads the container and the picture codec from the recorder\u2019s own MIME type', () => {
    expect(describeRecording('video/webm;codecs=vp9,opus')).toEqual({
      container: 'webm',
      videoCodec: 'vp9',
    });
    expect(describeRecording('video/mp4;codecs=avc1.42001f,mp4a.40.2')).toEqual({
      container: 'mp4',
      videoCodec: 'avc1',
    });
  });

  it('names a plain container sensibly when no codec is spelled out', () => {
    expect(describeRecording('video/webm')).toEqual({ container: 'webm', videoCodec: 'vp8' });
    expect(describeRecording('video/mp4')).toEqual({ container: 'mp4', videoCodec: 'avc1' });
  });
});

describe('mediaRecorderAvailable', () => {
  it('is false under jsdom, and the default environment refuses to be built', () => {
    expect(mediaRecorderAvailable()).toBe(false);
    expect(() => defaultMediaRecorderEnvironment()).toThrow(EncoderUnavailableError);
  });
});

describe('encodeMediaRecorder', () => {
  it('records through MediaRecorder and reports the container it really got', async () => {
    const harness = makeHarness();
    const plan = planFor([verse(1), verse(1), verse(1)]);

    const { result, bytes, sink } = await render(plan, harness);

    expect(['mp4', 'webm']).toContain(result.container);
    expect(result.container).toBe('mp4');
    expect(result.videoCodec).toBe('avc1');
    expect(result.durationSec).toBeCloseTo(plan.timeline.totalSec, 1);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(bytes.length).toBe(sink.bytesWritten);
  });

  it('asks for MP4 first and takes WebM only when MP4 is refused', async () => {
    const all = makeHarness();
    await render(planFor([verse(0.5)]), all);
    expect(all.recorders[0].options?.mimeType).toBe(MEDIA_RECORDER_MIME_TYPES[0]);

    const webmOnly = makeHarness({ supported: ['video/webm;codecs=vp9,opus'] });
    const { result } = await render(planFor([verse(0.5)]), webmOnly);

    expect(webmOnly.recorders[0].options?.mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(result.container).toBe('webm');
    expect(result.videoCodec).toBe('vp9');
  });

  it('refuses, before recording, when the browser supports no container at all', async () => {
    const harness = makeHarness({ supported: [] });
    const { error, sink } = await renderFailure(planFor([verse(1)]), harness);

    expect(error).toBeInstanceOf(EncoderUnavailableError);
    expect(harness.recorders).toHaveLength(0);
    expect(sink.bytesWritten).toBe(0);
  });

  it('captures the canvas at the plan\u2019s frame rate and sizes the picture', async () => {
    const harness = makeHarness();
    await render(planFor([verse(0.5)], { fps: 60 }), harness);

    expect(harness.captureRates).toEqual([60]);
    expect(harness.recorders[0].options).toMatchObject({
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
    });
  });

  it('writes the chunks to the sink as they arrive, not all at the end', async () => {
    const harness = makeHarness();
    const writes: number[] = [];
    const memory = await createSink('memory', 'video.webm');
    const sink: OutputSink = {
      write: async (chunk) => {
        writes.push(chunk.length);
        await memory.write(chunk);
      },
      finalize: () => memory.finalize(),
      abort: () => memory.abort(),
      get bytesWritten() {
        return memory.bytesWritten;
      },
    };

    const { bytes } = await render(planFor([verse(1), verse(1), verse(1)]), harness, sink);

    expect(writes.length).toBeGreaterThan(1);
    expect(writes.every((size) => size > 0)).toBe(true);
    expect(writes.reduce((total, size) => total + size, 0)).toBe(bytes.length);
  });

  it('reports progress from zero to a hundred, without going backwards', async () => {
    const harness = makeHarness();
    const { progress } = await render(planFor([verse(1), verse(1), verse(1)]), harness);

    expect(progress[0]).toMatchObject({ frame: 0, totalFrames: 132, percent: 0 });
    expect(progress.at(-1)).toMatchObject({ frame: 132, totalFrames: 132, percent: 100 });
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index].percent).toBeGreaterThanOrEqual(progress[index - 1].percent);
      expect(progress[index].etaSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('schedules every verse on the audio clock at its timeline position', async () => {
    const harness = makeHarness();
    await render(planFor([verse(1), verse(1), verse(1)]), harness);

    expect(harness.audioContexts).toHaveLength(1);
    const context = harness.audioContexts[0];
    expect(context.sampleRate).toBe(SAMPLE_RATE);
    expect(context.sources.map((source) => source.startedAt)).toEqual([0.8, 2.1, 3.4]);
    expect(context.sources.every((source) => source.connected.length === 1)).toBe(true);

    // The recitation samples themselves were copied into the context's buffers.
    const first = context.buffers[0];
    const original = audioOf(1).getChannelData(0);
    expect(first.getChannelData(0)[0]).toBe(original[0]);
    expect(first.getChannelData(0).length).toBe(original.length);
  });

  it('adds the audio track to the recorded stream', async () => {
    const harness = makeHarness();
    await render(planFor([verse(0.5)]), harness);

    const tracks = harness.streams[0].getTracks();
    expect(tracks.map((track) => (track as FakeTrack).kind)).toEqual(['video', 'audio']);
  });

  it('stays silent, and never builds an audio context, for a silent plan', async () => {
    const harness = makeHarness();
    await render(planFor([verse(0.5, { audio: null }), verse(0.5, { audio: null })]), harness);

    expect(harness.audioContexts).toHaveLength(0);
    expect(harness.streams[0].getTracks()).toHaveLength(1);
  });

  it('aborts the sink and stops every track when the recorder fails', async () => {
    const harness = makeHarness({ failOnStart: true });
    const { error, sink } = await renderFailure(planFor([verse(1)]), harness);

    expect(String(error)).toMatch(/could not start/);
    expect(sink.bytesWritten).toBe(0);
    expect(harness.streams[0].getTracks().every((track) => (track as FakeTrack).stopped)).toBe(true);
    expect(harness.audioContexts[0].closed).toBe(true);
  });

  it('propagates a failing sink and takes back what it wrote', async () => {
    const harness = makeHarness();
    const memory = await createSink('memory', 'video.webm');
    const sink: OutputSink = {
      write: async () => {
        throw new Error('the disk is full');
      },
      finalize: () => memory.finalize(),
      abort: () => memory.abort(),
      get bytesWritten() {
        return memory.bytesWritten;
      },
    };

    const { error } = await renderFailure(planFor([verse(1)]), harness, sink);

    expect(String(error)).toMatch(/disk is full/);
    expect(memory.bytesWritten).toBe(0);
    expect(harness.streams[0].getTracks().every((track) => (track as FakeTrack).stopped)).toBe(true);
  });

  it('refuses a plan no fallback could honour, before recording', async () => {
    const harness = makeHarness();
    const { error, sink } = await renderFailure(planFor([verse(901, { audio: null })]), harness);

    expect(String(error)).toMatch(/over the 900 s limit/);
    expect(harness.recorders).toHaveLength(0);
    expect(sink.bytesWritten).toBe(0);
  });
});
