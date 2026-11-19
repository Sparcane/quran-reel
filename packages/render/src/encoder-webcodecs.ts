/**
 * The nominal render path: draw frames on an offscreen canvas, encode them with
 * WebCodecs, mux the chunks into a fragmented MP4 as they arrive.
 *
 * Nothing here runs in real time. Frames are produced as fast as the device can
 * paint and encode them, and the timeline — not the clock — decides what each
 * frame shows. That is what makes a fifteen-minute video possible on a phone
 * without keeping it in memory.
 */

import { Compositor } from './compositor';
import {
  EncoderUnavailableError,
  validateEncodePlan,
  videoBitrateFor,
  type EncodePlan,
  type PlanarAudio,
} from './encoder-plan';
import { Mp4Muxer } from './muxer';
import type { OutputSink } from './sink';
import type { Progress, RenderedVideo } from './types';

/** A chunk of encoded audio, or the common part of an encoded video chunk. */
export interface EncodedChunkLike {
  readonly byteLength: number;
  readonly timestamp: number;
  readonly duration: number | null;
  copyTo(destination: Uint8Array): void;
}

export interface EncodedVideoChunkLike extends EncodedChunkLike {
  readonly type: 'key' | 'delta';
}

export interface VideoEncoderInitLike {
  output: (
    chunk: EncodedVideoChunkLike,
    metadata?: { decoderConfig?: { description?: Uint8Array | ArrayBuffer } },
  ) => void;
  error: (error: Error) => void;
}

export interface AudioEncoderInitLike {
  output: (
    chunk: EncodedChunkLike,
    metadata?: { decoderConfig?: { description?: Uint8Array | ArrayBuffer } },
  ) => void;
  error: (error: Error) => void;
}

export interface VideoEncoderLike {
  readonly state: string;
  readonly encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: VideoFrame, options?: { keyFrame?: boolean }): void;
  flush(): Promise<void>;
  close(): void;
  addEventListener?(type: 'dequeue', listener: () => void): void;
  removeEventListener?(type: 'dequeue', listener: () => void): void;
}

export interface AudioEncoderLike {
  readonly state: string;
  readonly encodeQueueSize: number;
  configure(config: AudioEncoderConfig): void;
  encode(data: AudioData): void;
  flush(): Promise<void>;
  close(): void;
  addEventListener?(type: 'dequeue', listener: () => void): void;
  removeEventListener?(type: 'dequeue', listener: () => void): void;
}

export interface VideoEncoderFactory {
  new (init: VideoEncoderInitLike): VideoEncoderLike;
  isConfigSupported(config: VideoEncoderConfig): Promise<{ supported?: boolean }>;
}

export interface AudioEncoderFactory {
  new (init: AudioEncoderInitLike): AudioEncoderLike;
  isConfigSupported(config: AudioEncoderConfig): Promise<{ supported?: boolean }>;
}

/**
 * The browser APIs the encoder needs, behind one seam. jsdom has no canvas, no
 * frames and no codecs; the tests supply stand-ins for all of them instead of
 * pretending the renderer runs there.
 */
export interface EncoderEnvironment {
  createCanvas(width: number, height: number): OffscreenCanvas;
  createVideoFrame(
    canvas: OffscreenCanvas,
    init: { timestamp: number; duration: number },
  ): VideoFrame;
  createAudioData(init: AudioDataInit): AudioData;
  videoEncoder: VideoEncoderFactory;
  audioEncoder: AudioEncoderFactory;
  now(): number;
  yieldToEventLoop(): Promise<void>;
}

/** Whether this platform has the whole nominal path: canvas, frames, codecs. */
export function webCodecsAvailable(scope: object = globalThis): boolean {
  const globals = scope as {
    VideoEncoder?: unknown;
    AudioEncoder?: unknown;
    VideoFrame?: unknown;
    OffscreenCanvas?: unknown;
  };
  return (
    typeof globals.VideoEncoder === 'function' &&
    typeof globals.AudioEncoder === 'function' &&
    typeof globals.VideoFrame === 'function' &&
    typeof globals.OffscreenCanvas === 'function'
  );
}

export function defaultEncoderEnvironment(): EncoderEnvironment {
  if (!webCodecsAvailable()) {
    throw new EncoderUnavailableError('encoder: WebCodecs is not available in this browser');
  }

  return {
    createCanvas: (width, height) => new OffscreenCanvas(width, height),
    createVideoFrame: (canvas, init) => new VideoFrame(canvas, { ...init, alpha: 'discard' }),
    createAudioData: (init) => new AudioData(init),
    videoEncoder: VideoEncoder as unknown as VideoEncoderFactory,
    audioEncoder: AudioEncoder as unknown as AudioEncoderFactory,
    now: () => Date.now(),
    yieldToEventLoop: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

/** Encoder waits while its queue is longer than this, so memory stays bounded. */
const MAX_ENCODE_QUEUE = 8;

/** The UI gets a turn at least this often; otherwise the tab looks frozen. */
const YIELD_EVERY_FRAMES = 60;

/** A fragment every two seconds, aligned with the keyframe interval. */
const FRAGMENT_SECONDS = 2;

/** One video keyframe every two seconds: seeking stays cheap, files stay small. */
const KEYFRAME_SECONDS = 2;

const H264_HIGH_4_2 = 'avc1.64002a';
const H264_HIGH_4_0 = 'avc1.640028';
const H264_MAIN_4_0 = 'avc1.4d0028';
const H264_BASELINE_3_1 = 'avc1.42001f';

const AUDIO_BITRATE = 128_000;

function copyChunk(chunk: EncodedChunkLike): Uint8Array {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}

/** Codec candidates from best to most conservative for this frame size. */
export function videoCodecCandidates(width: number, height: number, fps: 30 | 60): string[] {
  const longSide = Math.max(width, height);
  if (fps === 60 && longSide >= 1280) {
    return [H264_HIGH_4_2, H264_HIGH_4_0, H264_MAIN_4_0, H264_BASELINE_3_1];
  }
  // Level 3.1 covers 1280×720 only; anything larger, including a square 1080
  // frame, needs level 4.0.
  if (longSide > 1280 || width * height > 1280 * 720) {
    return [H264_HIGH_4_0, H264_MAIN_4_0, H264_BASELINE_3_1];
  }
  return [H264_BASELINE_3_1, H264_HIGH_4_0];
}

/** The exact config the encoder asks for, shared with the pre-flight probe. */
export function videoEncoderConfig(
  codec: string,
  width: number,
  height: number,
  fps: 30 | 60,
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    bitrate: videoBitrateFor(width, height),
    framerate: fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: { format: 'avc' },
  };
}

/**
 * API presence is not the same as codec support: Firefox has `VideoEncoder` but
 * no H.264 encoder. Ask the device before committing to the MP4 path so the
 * caller can take the MediaRecorder fallback instead of failing at frame zero.
 */
export async function h264EncoderAvailable(
  factory: Pick<VideoEncoderFactory, 'isConfigSupported'>,
  width: number,
  height: number,
  fps: 30 | 60,
): Promise<boolean> {
  for (const codec of videoCodecCandidates(width, height, fps)) {
    try {
      if ((await factory.isConfigSupported(videoEncoderConfig(codec, width, height, fps))).supported) {
        return true;
      }
    } catch {
      // A probe that rejects a config is answering "no" for that config.
    }
  }
  return false;
}

/**
 * The audio track has to line up with the picture, so the silences the timeline
 * describes are encoded too. Without them a player would play the verses back
 * to back and every subtitle would arrive early.
 */
interface AudioSegment {
  startUs: number;
  durationUs: number;
  /** null is silence. */
  audio: PlanarAudio | null;
}

function audioSegments(plan: EncodePlan, sampleRate: number): AudioSegment[] {
  const segments: AudioSegment[] = [];
  let cursorUs = 0;

  plan.verses.forEach((verse, index) => {
    const startUs = Math.round(plan.timeline.entries[index].start * 1_000_000);
    if (startUs > cursorUs) {
      segments.push({ startUs: cursorUs, durationUs: startUs - cursorUs, audio: null });
    }
    const audio = verse.audio;
    if (audio) {
      const durationUs = Math.round((audio.length / sampleRate) * 1_000_000);
      if (durationUs > 0) segments.push({ startUs, durationUs, audio });
      cursorUs = startUs + durationUs;
    } else {
      cursorUs = startUs;
    }
  });

  // A silent verse at the end, or a clip shorter than its subtitle slot, used
  // to leave the audio track early: the last words of the video played over
  // nothing. Fill the tail of the timeline with silence as well.
  const endUs = Math.round(plan.timeline.totalSec * 1_000_000);
  if (endUs > cursorUs) {
    segments.push({ startUs: cursorUs, durationUs: endUs - cursorUs, audio: null });
  }

  return segments;
}

async function waitForQueue(
  encoder: VideoEncoderLike | AudioEncoderLike,
  environment: EncoderEnvironment,
): Promise<void> {
  while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    if (typeof encoder.addEventListener !== 'function') {
      await environment.yieldToEventLoop();
      continue;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        encoder.removeEventListener?.('dequeue', done);
        resolve();
      };
      encoder.addEventListener?.('dequeue', done);
      // Some implementations never fire `dequeue`; the timer keeps the loop
      // alive without turning back-pressure into a hang.
      setTimeout(done, 4);
    });
  }
}

export async function encodeWebCodecs(
  plan: EncodePlan,
  sink: OutputSink,
  onProgress: (progress: Progress) => void,
  environment: EncoderEnvironment = defaultEncoderEnvironment(),
): Promise<RenderedVideo> {
  validateEncodePlan(plan);

  const { width, height, fps, timeline, verses } = plan;
  const totalFrames = Math.max(1, Math.round(timeline.totalSec * fps));
  const frameTimestampUs = (frame: number) => Math.round((frame * 1_000_000) / fps);
  const frameDurationUs = (frame: number) =>
    Math.max(1, frameTimestampUs(frame + 1) - frameTimestampUs(frame));

  const hasAudio = verses.some((verse) => verse.audio);
  const sampleRate = verses.find((verse) => verse.audio)?.audio?.sampleRate ?? 48_000;
  const channels = verses.find((verse) => verse.audio)?.audio?.numberOfChannels ?? 2;

  const muxer = new Mp4Muxer({
    video: { codec: 'avc1', width, height },
    audio: hasAudio ? { sampleRate, channels } : null,
    durationUs: Math.round(timeline.totalSec * 1_000_000),
  });

  const audioSamples: { data: Uint8Array; timestampUs: number; durationUs: number }[] = [];
  let failure: Error | null = null;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };

  const canvas = environment.createCanvas(width, height);
  const compositor = new Compositor(canvas, plan.style, plan.background, {
    overlayOpacity: plan.overlayOpacity,
    centerY: plan.centerY,
    watermark: plan.watermark,
  });
  compositor.prepare(
    verses.map((verse) => ({
      arabic: verse.arabic,
      translation: verse.translation,
      words: verse.words,
    })),
    timeline,
  );

  let videoEncoder: VideoEncoderLike | null = null;
  let audioEncoder: AudioEncoderLike | null = null;
  let headerWritten = false;

  const videoConfigFor = (codec: string): VideoEncoderConfig =>
    videoEncoderConfig(codec, width, height, fps);

  const audioConfig: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channels,
    bitrate: AUDIO_BITRATE,
  };

  const writeFragment = async (beforeUs = Number.POSITIVE_INFINITY): Promise<void> => {
    if (!muxer.hasVideoDescription()) return;
    if (!headerWritten) {
      await sink.write(muxer.buildHeader());
      headerWritten = true;
    }
    const fragment = muxer.takeFragment(beforeUs);
    if (fragment) await sink.write(fragment);
  };

  const startedAt = environment.now();

  const report = (frame: number): void => {
    const elapsedMs = environment.now() - startedAt;
    const etaSec = frame > 0 ? ((elapsedMs / frame) * (totalFrames - frame)) / 1000 : 0;
    onProgress({
      frame,
      totalFrames,
      percent: Math.min(100, (frame / totalFrames) * 100),
      etaSec: Math.max(0, etaSec),
    });
  };

  const throwIfFailed = () => {
    if (failure) throw failure;
  };

  try {
    // Pick the first codec the device actually accepts: asking for High 4.0 on
    // a phone that only has Baseline is how a render fails at frame zero.
    let videoConfig: VideoEncoderConfig | null = null;
    for (const codec of videoCodecCandidates(width, height, fps)) {
      const config = videoConfigFor(codec);
      const support = await environment.videoEncoder.isConfigSupported(config);
      if (support.supported) {
        videoConfig = config;
        break;
      }
    }
    if (!videoConfig) {
      throw new EncoderUnavailableError(
        `encoder: no H.264 encoder accepts ${width}×${height} at ${fps} fps`,
      );
    }

    if (hasAudio) {
      const audioSupport = await environment.audioEncoder.isConfigSupported(audioConfig);
      if (!audioSupport.supported) {
        throw new EncoderUnavailableError('encoder: no AAC encoder is available on this device');
      }
    }

    // Audio is encoded first and kept as compressed chunks: a 15-minute track
    // at 128 kbps is about 14 MB, while the video is hundreds.
    if (hasAudio) {
      audioEncoder = new environment.audioEncoder({
        output: (chunk, metadata) => {
          try {
            muxer.setAudioDescription(metadata?.decoderConfig?.description);
            const durationUs = chunk.duration ?? Math.round((1024 / sampleRate) * 1_000_000);
            audioSamples.push({
              data: copyChunk(chunk),
              timestampUs: chunk.timestamp,
              durationUs: Math.max(1, Math.round(durationUs)),
            });
          } catch (error) {
            fail(error);
          }
        },
        error: (error) => fail(error),
      });
      audioEncoder.configure(audioConfig);

      for (const segment of audioSegments(plan, sampleRate)) {
        if (segment.audio) {
          const audio = segment.audio;
          const frames = audio.length;
          const sliceFrames = Math.max(1, Math.min(frames, sampleRate));
          for (let offset = 0; offset < frames; offset += sliceFrames) {
            const count = Math.min(sliceFrames, frames - offset);
            const data = new Float32Array(count * channels);
            for (let channel = 0; channel < channels; channel += 1) {
              const source = audio.getChannelData(channel);
              data.set(source.subarray(offset, offset + count), channel * count);
            }
            const audioData = environment.createAudioData({
              format: 'f32-planar',
              sampleRate,
              numberOfFrames: count,
              numberOfChannels: channels,
              timestamp: segment.startUs + Math.round((offset / sampleRate) * 1_000_000),
              data,
            });
            await waitForQueue(audioEncoder, environment);
            audioEncoder.encode(audioData);
            audioData.close();
            throwIfFailed();
          }
          await environment.yieldToEventLoop();
        } else {
          let cursorUs = segment.startUs;
          const endUs = segment.startUs + segment.durationUs;
          while (cursorUs < endUs) {
            const frames = Math.min(
              sampleRate,
              Math.round(((endUs - cursorUs) * sampleRate) / 1_000_000),
            );
            if (frames <= 0) break;
            const audioData = environment.createAudioData({
              format: 'f32-planar',
              sampleRate,
              numberOfFrames: frames,
              numberOfChannels: channels,
              timestamp: cursorUs,
              data: new Float32Array(frames * channels),
            });
            await waitForQueue(audioEncoder, environment);
            audioEncoder.encode(audioData);
            audioData.close();
            throwIfFailed();
            cursorUs += Math.round((frames / sampleRate) * 1_000_000);
          }
        }
      }

      await audioEncoder.flush();
      throwIfFailed();
      audioEncoder.close();
      audioEncoder = null;

      // Hand the compressed track to the muxer before the picture starts. The
      // muxer writes it out fragment by fragment, interleaved with the video,
      // so nothing is held beyond the next two seconds.
      for (const sample of audioSamples) muxer.addAudioSample(sample);
      audioSamples.length = 0;
    }

    videoEncoder = new environment.videoEncoder({
      output: (chunk, metadata) => {
        try {
          if (!muxer.hasVideoDescription()) {
            muxer.setVideoDescription(metadata?.decoderConfig?.description);
          }
          muxer.addVideoSample({
            data: copyChunk(chunk),
            timestampUs: chunk.timestamp,
            durationUs: Math.max(1, Math.round(chunk.duration ?? 1_000_000 / fps)),
            keyframe: chunk.type === 'key',
          });
        } catch (error) {
          fail(error);
        }
      },
      error: (error) => fail(error),
    });
    videoEncoder.configure(videoConfig);

    report(0);
    const fragmentEvery = Math.round(FRAGMENT_SECONDS * fps);
    const keyframeEvery = Math.round(KEYFRAME_SECONDS * fps);

    for (let frame = 0; frame < totalFrames; frame += 1) {
      throwIfFailed();
      compositor.drawAt(frame / fps);

      const videoFrame = environment.createVideoFrame(canvas, {
        timestamp: frameTimestampUs(frame),
        duration: frameDurationUs(frame),
      });

      await waitForQueue(videoEncoder, environment);
      videoEncoder.encode(videoFrame, { keyFrame: frame % keyframeEvery === 0 });
      videoFrame.close();

      report(frame + 1);

      if ((frame + 1) % fragmentEvery === 0) {
        await writeFragment(frameTimestampUs(frame + 1));
      }
      if ((frame + 1) % YIELD_EVERY_FRAMES === 0) {
        await environment.yieldToEventLoop();
        throwIfFailed();
      }
    }

    await videoEncoder.flush();
    throwIfFailed();
    await writeFragment();

    if (!headerWritten) {
      throw new EncoderUnavailableError('encoder: the video encoder produced no frames');
    }

    const blob = await sink.finalize();
    return {
      blob,
      durationSec: timeline.totalSec,
      width,
      height,
      container: 'mp4',
      videoCodec: 'avc1',
    };
  } catch (error) {
    await sink.abort().catch(() => undefined);
    throw error;
  } finally {
    if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
    if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    compositor.dispose();
  }
}
