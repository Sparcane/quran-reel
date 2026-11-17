import { describe, expect, it } from 'vitest';
import { buildTimeline } from '@quran/core';
import { createGradientPainter, type BackgroundPainter } from '../src/background';
import {
  EncoderUnavailableError,
  videoBitrateFor,
  type EncodePlan,
  type PlanarAudio,
  type VerseClip,
} from '../src/encoder-plan';
import {
  defaultEncoderEnvironment,
  encodeWebCodecs,
  videoCodecCandidates,
  webCodecsAvailable,
  type AudioEncoderFactory,
  type AudioEncoderInitLike,
  type AudioEncoderLike,
  type EncodedChunkLike,
  type EncodedVideoChunkLike,
  type EncoderEnvironment,
  type VideoEncoderFactory,
  type VideoEncoderInitLike,
  type VideoEncoderLike,
} from '../src/encoder-webcodecs';
import { createSink } from '../src/sink';
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

/** What a real encoder reports with its first chunk. The contents do not matter. */
const AVC_C = Uint8Array.of(
  0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x28, 0x01, 0x00, 0x04, 0x68,
  0xee, 0x3c, 0x80,
);

/** AAC-LC, 48 kHz, stereo. */
const ASC = Uint8Array.of(0x11, 0x90);

const SAMPLE_RATE = 48_000;

function recordingCanvas(width: number, height: number): OffscreenCanvas {
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

  return { width, height, getContext: () => ctx } as unknown as OffscreenCanvas;
}

function gradient(width: number, height: number): BackgroundPainter {
  return createGradientPainter(
    { kind: 'gradient', from: '#000000', to: '#111111', angle: 0, motion: false },
    { width, height },
  );
}

function audioOf(
  durationSec: number,
  options: { sampleRate?: number; channels?: number } = {},
): PlanarAudio {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? 2;
  const length = Math.round(durationSec * sampleRate);
  const channelData = Array.from({ length: channels }, (_, channel) =>
    Float32Array.from(
      { length },
      (_, index) => 0.25 + channel * 0.5 + (index % 7) * 0.001,
    ),
  );

  return {
    sampleRate,
    length,
    numberOfChannels: channels,
    getChannelData: (channel) => channelData[channel],
  };
}

function verse(
  durationSec: number,
  options: { audio?: PlanarAudio | null } = {},
): VerseClip {
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

interface RecordedFrame {
  timestamp: number;
  duration: number;
  closed: boolean;
}

class FakeAudioData {
  readonly format: AudioSampleFormat;
  readonly sampleRate: number;
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  readonly timestamp: number;
  readonly data: Float32Array;
  closed = false;

  constructor(init: AudioDataInit) {
    this.format = init.format;
    this.sampleRate = init.sampleRate;
    this.numberOfFrames = init.numberOfFrames;
    this.numberOfChannels = init.numberOfChannels;
    this.timestamp = init.timestamp;
    this.data = init.data as Float32Array;
  }

  close(): void {
    this.closed = true;
  }

  /** Whether this chunk is a stretch of silence the timeline asked for. */
  isSilence(): boolean {
    return this.data.every((sample) => sample === 0);
  }
}

interface HarnessOptions {
  /** Which configs the fake encoder claims to support. Default: all of them. */
  videoSupported?: (config: VideoEncoderConfig) => boolean;
  audioSupported?: boolean;
  /** Frames already queued when the render starts, to exercise back-pressure. */
  videoQueueStart?: number;
  /** Make the encoder call its error callback on this encode call (1-based). */
  failVideoEncodeAt?: number;
  /** Withhold the `avcC`, as a broken encoder would. */
  sendVideoDescription?: boolean;
}

interface Harness {
  env: EncoderEnvironment;
  frames: RecordedFrame[];
  audioData: FakeAudioData[];
  videoConfigsAsked: VideoEncoderConfig[];
  videoConfigured: VideoEncoderConfig[];
  audioConfigsAsked: AudioEncoderConfig[];
  audioConfigured: AudioEncoderConfig[];
  encodes: { timestamp: number; keyFrame: boolean }[];
  keyFrames: number[];
  audioEncodes: number;
  dequeueCount: number;
  maxQueueSeen: number;
  yields: number;
}

/**
 * jsdom has no canvas, no `VideoFrame`, no `AudioData` and no codecs. This
 * harness replaces each of them with the smallest stand-in that records what the
 * encoder did with it, so the sequencing — codec choice, timestamps, order,
 * back-pressure — is what the tests check.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const frames: RecordedFrame[] = [];
  const audioData: FakeAudioData[] = [];
  const videoConfigsAsked: VideoEncoderConfig[] = [];
  const videoConfigured: VideoEncoderConfig[] = [];
  const audioConfigsAsked: AudioEncoderConfig[] = [];
  const audioConfigured: AudioEncoderConfig[] = [];
  const encodes: { timestamp: number; keyFrame: boolean }[] = [];
  const keyFrames: number[] = [];

  let clock = 0;
  let yields = 0;
  let dequeueCount = 0;
  let maxQueueSeen = 0;
  let videoQueue = options.videoQueueStart ?? 0;
  let audioEncodes = 0;
  let videoDescriptionSent = false;
  let audioDescriptionSent = false;

  class FakeVideoEncoder implements VideoEncoderLike {
    state = 'unconfigured';
    private readonly init: VideoEncoderInitLike;

    constructor(init: VideoEncoderInitLike) {
      this.init = init;
    }

    get encodeQueueSize(): number {
      return videoQueue;
    }

    configure(config: VideoEncoderConfig): void {
      this.state = 'configured';
      videoConfigured.push(config);
    }

    encode(frame: VideoFrame, encodeOptions?: { keyFrame?: boolean }): void {
      const recorded = frame as unknown as { timestamp: number; duration: number };
      const keyFrame = Boolean(encodeOptions?.keyFrame);
      encodes.push({ timestamp: recorded.timestamp, keyFrame });
      if (keyFrame) keyFrames.push(recorded.timestamp);

      if (options.failVideoEncodeAt !== undefined && encodes.length === options.failVideoEncodeAt) {
        this.init.error(new Error('GPU lost the device'));
        return;
      }

      videoQueue += 1;
      maxQueueSeen = Math.max(maxQueueSeen, videoQueue);

      const chunk: EncodedVideoChunkLike = {
        byteLength: 4,
        timestamp: recorded.timestamp,
        duration: recorded.duration,
        type: keyFrame ? 'key' : 'delta',
        copyTo(destination) {
          destination.set(Uint8Array.of(0xde, 0xad, 0xbe, 0xef).subarray(0, destination.length));
        },
      };

      const sendDescription = options.sendVideoDescription ?? true;
      const metadata =
        sendDescription && !videoDescriptionSent
          ? { decoderConfig: { description: AVC_C } }
          : undefined;
      if (sendDescription) videoDescriptionSent = true;

      this.init.output(chunk, metadata);
    }

    async flush(): Promise<void> {
      this.state = 'configured';
    }

    close(): void {
      this.state = 'closed';
    }

    addEventListener(type: 'dequeue', listener: () => void): void {
      if (type !== 'dequeue') return;
      dequeueCount += 1;
      queueMicrotask(() => {
        if (videoQueue > 0) videoQueue -= 1;
        listener();
      });
    }

    removeEventListener(): void {}

    static async isConfigSupported(config: VideoEncoderConfig) {
      videoConfigsAsked.push(config);
      const supported = options.videoSupported ? options.videoSupported(config) : true;
      return { supported };
    }
  }

  class FakeAudioEncoder implements AudioEncoderLike {
    state = 'unconfigured';
    private readonly init: AudioEncoderInitLike;

    constructor(init: AudioEncoderInitLike) {
      this.init = init;
    }

    get encodeQueueSize(): number {
      return 0;
    }

    configure(config: AudioEncoderConfig): void {
      this.state = 'configured';
      audioConfigured.push(config);
    }

    encode(data: AudioData): void {
      const recorded = data as unknown as FakeAudioData;
      audioEncodes += 1;

      const chunk: EncodedChunkLike = {
        byteLength: 8,
        timestamp: recorded.timestamp,
        duration: Math.round((recorded.numberOfFrames / recorded.sampleRate) * 1_000_000),
        copyTo(destination) {
          destination.fill(0x5a);
        },
      };

      const metadata = audioDescriptionSent
        ? undefined
        : { decoderConfig: { description: ASC } };
      audioDescriptionSent = true;

      this.init.output(chunk, metadata);
    }

    async flush(): Promise<void> {
      this.state = 'configured';
    }

    close(): void {
      this.state = 'closed';
    }

    static async isConfigSupported(config: AudioEncoderConfig) {
      audioConfigsAsked.push(config);
      return { supported: options.audioSupported ?? true };
    }
  }

  const env: EncoderEnvironment = {
    createCanvas: (width, height) => recordingCanvas(width, height),
    createVideoFrame: (_canvas, init) => {
      const frame: RecordedFrame = {
        timestamp: init.timestamp,
        duration: init.duration,
        closed: false,
      };
      frame.closed = false;
      const fake = {
        timestamp: init.timestamp,
        duration: init.duration,
        close() {
          frame.closed = true;
        },
      };
      frames.push(frame);
      return fake as unknown as VideoFrame;
    },
    createAudioData: (init) => {
      const data = new FakeAudioData(init);
      audioData.push(data);
      return data as unknown as AudioData;
    },
    videoEncoder: FakeVideoEncoder as unknown as VideoEncoderFactory,
    audioEncoder: FakeAudioEncoder as unknown as AudioEncoderFactory,
    now: () => {
      clock += 4;
      return clock;
    },
    yieldToEventLoop: async () => {
      yields += 1;
    },
  };

  return {
    env,
    frames,
    audioData,
    videoConfigsAsked,
    videoConfigured,
    audioConfigsAsked,
    audioConfigured,
    encodes,
    keyFrames,
    get audioEncodes() {
      return audioEncodes;
    },
    get dequeueCount() {
      return dequeueCount;
    },
    get maxQueueSeen() {
      return maxQueueSeen;
    },
    get yields() {
      return yields;
    },
  };
}

async function render(plan: EncodePlan, harness: Harness = makeHarness()) {
  const sink = await createSink('memory', 'video.mp4');
  const progress: Progress[] = [];

  const result = await encodeWebCodecs(plan, sink, (value) => progress.push(value), harness.env);
  const bytes = new Uint8Array(await (await sink.finalize()).arrayBuffer());

  return { result, bytes, progress, sink, harness };
}

async function renderFailure(plan: EncodePlan, harness: Harness = makeHarness()) {
  const sink = await createSink('memory', 'video.mp4');
  const progress: Progress[] = [];

  let error: unknown;
  try {
    await encodeWebCodecs(plan, sink, (value) => progress.push(value), harness.env);
  } catch (caught) {
    error = caught;
  }

  return { error, sink, progress, harness };
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  outer: for (let start = 0; start + needle.length <= bytes.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[start + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function countAscii(bytes: Uint8Array, text: string): number {
  const needle = new TextEncoder().encode(text);
  let count = 0;
  outer: for (let start = 0; start + needle.length <= bytes.length; start += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[start + index] !== needle[index]) continue outer;
    }
    count += 1;
  }
  return count;
}

/** Whether the file holds `length` consecutive bytes of `value`. */
function containsRun(bytes: Uint8Array, value: number, length: number): boolean {
  let run = 0;
  for (const byte of bytes) {
    run = byte === value ? run + 1 : 0;
    if (run >= length) return true;
  }
  return false;
}

/** Whether the file holds these bytes, in this order, somewhere in it. */
function containsSequence(bytes: Uint8Array, sequence: readonly number[]): boolean {
  outer: for (let start = 0; start + sequence.length <= bytes.length; start += 1) {
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[start + index] !== sequence[index]) continue outer;
    }
    return true;
  }
  return false;
}

describe('videoBitrateFor', () => {
  it('targets 6 Mbps above 720p and 3.5 Mbps at or below it', () => {
    expect(videoBitrateFor(1080, 1920)).toBe(6_000_000);
    expect(videoBitrateFor(1920, 1080)).toBe(6_000_000);
    expect(videoBitrateFor(720, 1280)).toBe(3_500_000);
    expect(videoBitrateFor(1280, 720)).toBe(3_500_000);
    expect(videoBitrateFor(1080, 1080)).toBe(6_000_000);
  });
});

describe('videoCodecCandidates', () => {
  it('starts at High 4.0 for a 1080p-class frame', () => {
    expect(videoCodecCandidates(1080, 1920, 30)[0]).toBe('avc1.640028');
  });

  it('starts at Baseline for a 720p frame, where level 3.1 is enough', () => {
    expect(videoCodecCandidates(720, 1280, 30)[0]).toBe('avc1.42001f');
  });

  it('asks for a higher level at 60 fps', () => {
    expect(videoCodecCandidates(1080, 1920, 60)[0]).toBe('avc1.64002a');
  });

  it('always offers Baseline, so a weak device still has a choice', () => {
    for (const [width, height, fps] of [
      [1080, 1920, 30],
      [1080, 1920, 60],
      [720, 1280, 30],
    ] as const) {
      const candidates = videoCodecCandidates(width, height, fps);
      expect(candidates).toContain('avc1.42001f');
      expect(new Set(candidates).size).toBe(candidates.length);
    }

    // Where Baseline cannot carry the frame, it is the last resort.
    expect(videoCodecCandidates(1080, 1920, 30).at(-1)).toBe('avc1.42001f');
    expect(videoCodecCandidates(1080, 1920, 60).at(-1)).toBe('avc1.42001f');
  });
});

describe('webCodecsAvailable', () => {
  it('is false under jsdom, where the nominal path cannot run', () => {
    expect(webCodecsAvailable()).toBe(false);
    expect(() => defaultEncoderEnvironment()).toThrow(EncoderUnavailableError);
  });

  it('needs all four APIs, not just the encoders', () => {
    const complete = {
      VideoEncoder: function () {},
      AudioEncoder: function () {},
      VideoFrame: function () {},
      OffscreenCanvas: function () {},
    };

    expect(webCodecsAvailable(complete)).toBe(true);
    expect(webCodecsAvailable({ ...complete, OffscreenCanvas: undefined })).toBe(false);
    expect(webCodecsAvailable({ ...complete, AudioEncoder: undefined })).toBe(false);
  });
});

describe('encodeWebCodecs', () => {
  it('writes an MP4 with an ftyp before anything else', async () => {
    const { result, bytes, sink } = await render(planFor([verse(1), verse(1), verse(1)]));

    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp');
    expect(result.container).toBe('mp4');
    expect(result.videoCodec).toBe('avc1');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(bytes.length);
    expect(sink.bytesWritten).toBe(bytes.length);
  });

  it('reports the timeline duration and the requested frame size', async () => {
    const plan = planFor([verse(1), verse(1), verse(1)]);
    const { result } = await render(plan);

    expect(result.durationSec).toBeCloseTo(plan.timeline.totalSec, 6);
    expect(result.durationSec).toBe(4.4);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  });

  it('declares both an H.264 and an AAC track when the verses have sound', async () => {
    const { bytes } = await render(planFor([verse(1)]));

    expect(containsAscii(bytes, 'avc1')).toBe(true);
    expect(containsAscii(bytes, 'mp4a')).toBe(true);
  });

  it('interleaves the encoded audio into the file, not just its track header', async () => {
    const { bytes } = await render(planFor([verse(1), verse(1), verse(1)]));

    // The fake audio chunks are eight 0x5a bytes; finding them in the file
    // proves they travelled through the muxer instead of being dropped.
    expect(containsRun(bytes, 0x5a, 8)).toBe(true);
    expect(containsSequence(bytes, [0xde, 0xad, 0xbe, 0xef])).toBe(true);
  });

  it('leaves the AAC track out of a silent render, and never builds an audio encoder', async () => {
    const { bytes, harness } = await render(
      planFor([verse(1, { audio: null }), verse(1, { audio: null })]),
    );

    expect(containsAscii(bytes, 'avc1')).toBe(true);
    expect(containsAscii(bytes, 'mp4a')).toBe(false);
    expect(harness.audioConfigsAsked).toHaveLength(0);
    expect(harness.audioEncodes).toBe(0);
  });

  it('picks High 4.0 and 6 Mbps for a 1080 × 1920 frame', async () => {
    const { harness } = await render(planFor([verse(0.4)]));

    expect(harness.videoConfigured).toHaveLength(1);
    expect(harness.videoConfigured[0]).toMatchObject({
      codec: 'avc1.640028',
      width: 1080,
      height: 1920,
      bitrate: 6_000_000,
      framerate: 30,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      avc: { format: 'avc' },
    });
  });

  it('picks Baseline and 3.5 Mbps for a 720 × 1280 frame', async () => {
    const { harness } = await render(planFor([verse(0.4)], { width: 720, height: 1280 }));

    expect(harness.videoConfigured[0]).toMatchObject({
      codec: 'avc1.42001f',
      bitrate: 3_500_000,
      width: 720,
      height: 1280,
    });
  });

  it('falls back to the next codec the device accepts', async () => {
    const harness = makeHarness({
      videoSupported: (config) => config.codec === 'avc1.4d0028',
    });

    await render(planFor([verse(0.4)]), harness);

    expect(harness.videoConfigsAsked.map((config) => config.codec)).toEqual([
      'avc1.640028',
      'avc1.4d0028',
    ]);
    expect(harness.videoConfigured[0].codec).toBe('avc1.4d0028');
  });

  it('refuses, loudly, when no H.264 codec exists', async () => {
    const harness = makeHarness({ videoSupported: () => false });
    const { error, sink } = await renderFailure(planFor([verse(1)]), harness);

    expect(error).toBeInstanceOf(EncoderUnavailableError);
    expect(String(error)).toMatch(/no H\.264 encoder/);
    expect(harness.frames).toHaveLength(0);
    expect(sink.bytesWritten).toBe(0);
  });

  it('refuses when the device has no AAC encoder, before encoding anything', async () => {
    const harness = makeHarness({ audioSupported: false });
    const { error, sink } = await renderFailure(planFor([verse(1)]), harness);

    expect(error).toBeInstanceOf(EncoderUnavailableError);
    expect(String(error)).toMatch(/no AAC encoder/);
    expect(harness.audioEncodes).toBe(0);
    expect(harness.frames).toHaveLength(0);
    expect(sink.bytesWritten).toBe(0);
  });

  it('gives every frame a deterministic timestamp and duration', async () => {
    const { harness } = await render(planFor([verse(1), verse(1), verse(1)]));

    expect(harness.frames).toHaveLength(132);
    harness.frames.forEach((frame, index) => {
      const start = Math.round((index * 1_000_000) / 30);
      const end = Math.round(((index + 1) * 1_000_000) / 30);
      expect(frame.timestamp).toBe(start);
      expect(frame.duration).toBe(Math.max(1, end - start));
    });
    expect(harness.frames.every((frame) => frame.closed)).toBe(true);
  });

  it('asks for a keyframe every two seconds, starting at the first frame', async () => {
    const { harness } = await render(planFor([verse(1), verse(1), verse(1)]));

    expect(harness.keyFrames).toEqual([0, 2_000_000, 4_000_000]);
    expect(harness.encodes.filter((encode) => encode.keyFrame)).toHaveLength(3);
  });

  it('streams the file out as fragments instead of buffering the whole video', async () => {
    const { bytes } = await render(planFor([verse(1), verse(1), verse(1)]));

    // Two seconds per fragment over 4.4 s: at 2 s, at 4 s, then the remainder.
    expect(countAscii(bytes, 'moof')).toBe(3);
  });

  it('keeps the encoder queue bounded when the device encodes slowly', async () => {
    const harness = makeHarness({ videoQueueStart: 30 });
    await render(planFor([verse(0.5)]), harness);

    expect(harness.dequeueCount).toBeGreaterThanOrEqual(22);
    expect(harness.maxQueueSeen).toBeLessThanOrEqual(9);
  });

  it('reports progress from zero to a hundred, without going backwards', async () => {
    const { progress } = await render(planFor([verse(1), verse(1), verse(1)]));

    expect(progress).toHaveLength(133);
    expect(progress[0]).toMatchObject({ frame: 0, totalFrames: 132, percent: 0 });
    expect(progress.at(-1)).toMatchObject({ frame: 132, totalFrames: 132, percent: 100 });

    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index].percent).toBeGreaterThanOrEqual(progress[index - 1].percent);
      expect(progress[index].etaSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('encodes the silences between verses, so the sound stays in step', async () => {
    const { harness } = await render(planFor([verse(1), verse(1), verse(1)]));

    const totalFrames = harness.audioData.reduce((total, chunk) => total + chunk.numberOfFrames, 0);
    // 4.4 s at 48 kHz: lead-in, three one-second verses, two gaps.
    expect(totalFrames).toBe(211_200);

    const silences = harness.audioData.filter((chunk) => chunk.isSilence());
    expect(silences.map((chunk) => chunk.timestamp)).toEqual([0, 1_800_000, 3_100_000]);
    expect(harness.audioData.every((chunk) => chunk.closed)).toBe(true);
    expect(harness.audioData.every((chunk) => chunk.format === 'f32-planar')).toBe(true);
  });

  it('encodes the verse samples at the timeline position of their verse', async () => {
    const { harness } = await render(planFor([verse(1), verse(1), verse(1)]));

    const verses = harness.audioData.filter((chunk) => !chunk.isSilence());
    expect(verses.map((chunk) => chunk.timestamp)).toEqual([800_000, 2_100_000, 3_400_000]);
    expect(verses.every((chunk) => chunk.numberOfFrames === SAMPLE_RATE)).toBe(true);
  });

  it('configures AAC at 128 kbps, matching the sample rate of the clips', async () => {
    const { harness } = await render(planFor([verse(1)]));

    expect(harness.audioConfigsAsked).toHaveLength(1);
    expect(harness.audioConfigsAsked[0]).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      bitrate: 128_000,
    });
  });

  it('keeps a mono recitation mono', async () => {
    const mono = audioOf(1, { channels: 1 });
    const { harness } = await render(planFor([verse(1, { audio: mono })]));

    expect(harness.audioConfigsAsked[0].numberOfChannels).toBe(1);
    const silences = harness.audioData.filter((chunk) => chunk.isSilence());
    expect(silences[0].data).toHaveLength(silences[0].numberOfFrames);
  });

  it('aborts the sink and rethrows when the encoder fails mid-render', async () => {
    const harness = makeHarness({ failVideoEncodeAt: 70 });
    const { error, sink, progress } = await renderFailure(
      planFor([verse(1), verse(1), verse(1)]),
      harness,
    );

    expect(String(error)).toMatch(/GPU lost the device/);
    // A fragment had already been written by frame 70; abort must take it back.
    expect(sink.bytesWritten).toBe(0);
    expect(progress.at(-1)!.percent).toBeLessThan(100);
  });

  it('fails when the encoder produces no avcC description', async () => {
    const harness = makeHarness({ sendVideoDescription: false });
    const { error, sink } = await renderFailure(planFor([verse(1)]), harness);

    expect(String(error)).toMatch(/avcC/);
    expect(sink.bytesWritten).toBe(0);
  });

  it('aborts the sink when the platform has no WebCodecs at all', async () => {
    const sink = await createSink('memory', 'video.mp4');

    await expect(
      encodeWebCodecs(planFor([verse(1)]), sink, () => {}),
    ).rejects.toBeInstanceOf(EncoderUnavailableError);
    expect(sink.bytesWritten).toBe(0);
  });

  it('refuses an empty plan', async () => {
    const { error } = await renderFailure(
      planFor([], { timeline: { entries: [], totalSec: 0 } }),
    );

    expect(String(error)).toMatch(/nothing to render/);
  });

  it('refuses a timeline that does not match the verses', async () => {
    const verses = [verse(1), verse(1)];
    const { error } = await renderFailure(
      planFor(verses, { timeline: buildTimeline([1]) }),
    );

    expect(String(error)).toMatch(/timeline has 1 entries for 2 verses/);
  });

  it('refuses a frame rate the encoder does not support', async () => {
    const { error } = await renderFailure(planFor([verse(1)], { fps: 24 as 30 }));

    expect(String(error)).toMatch(/fps must be 30 or 60/);
  });

  it('refuses a video longer than fifteen minutes before encoding anything', async () => {
    // Silent, so the test allocates nothing: the duration check must come first.
    const { error, sink } = await renderFailure(planFor([verse(901, { audio: null })]));

    expect(String(error)).toMatch(/over the 900 s limit/);
    expect(sink.bytesWritten).toBe(0);
  });

  it('refuses verses recorded at different sample rates', async () => {
    const { error } = await renderFailure(
      planFor([
        verse(1, { audio: audioOf(1, { sampleRate: 48_000 }) }),
        verse(1, { audio: audioOf(1, { sampleRate: 44_100 }) }),
      ]),
    );

    expect(String(error)).toMatch(/one sample rate/);
  });
});
