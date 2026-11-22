/**
 * The fallback render path: record the canvas and its sound in real time.
 *
 * Some browsers can paint a canvas and record it, but cannot encode frame by
 * frame. `MediaRecorder` is slower than WebCodecs — a fifteen-minute video takes
 * fifteen minutes — and it chooses the container itself, so the file's format is
 * read back from the recorder instead of assumed.
 *
 * The picture is still drawn from the timeline, not from the wall clock: the
 * recitation is scheduled on the audio graph at its verse's start, and every
 * animation frame paints the frame the composition has at that instant.
 */

import { Compositor } from './compositor';
import {
  EncoderUnavailableError,
  validateEncodePlan,
  videoBitrateFor,
  type EncodePlan,
  type PlanarAudio,
} from './encoder-plan';
import type { OutputSink } from './sink';
import type { Progress, RenderedVideo } from './types';

/** The audio track is cut about once a second, so the file streams out. */
export const RECORDER_TIMESLICE_MS = 1_000;

/**
 * Containers to try, best first. MP4 is preferred because that is what social
 * platforms accept without re-encoding; WebM is what most browsers can record.
 */
export const MEDIA_RECORDER_MIME_TYPES = [
  'video/mp4;codecs=avc1.42001f,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

/** A recorded file's format, read from the recorder instead of guessed. */
export interface RecordingDescription {
  container: 'mp4' | 'webm';
  videoCodec: string;
}

/**
 * Reads the container and picture codec out of the MIME type the recorder
 * reports, e.g. `video/webm;codecs=vp9,opus`.
 */
export function describeRecording(mimeType: string): RecordingDescription {
  const [base, ...parameters] = mimeType.split(';');
  const container = base.trim().toLowerCase() === 'video/mp4' ? 'mp4' : 'webm';
  const codecs =
    parameters
      .join(';')
      .match(/codecs=([^;]+)/i)?.[1]
      ?.trim()
      .toLowerCase() ?? '';
  const first = codecs.split(',')[0].trim();

  let videoCodec: string;
  if (first.startsWith('avc1') || first.startsWith('avc3')) videoCodec = 'avc1';
  else if (first.startsWith('vp09') || first.startsWith('vp9')) videoCodec = 'vp9';
  else if (first.startsWith('vp8')) videoCodec = 'vp8';
  else if (first.startsWith('hvc1') || first.startsWith('hev1')) videoCodec = 'hevc';
  else videoCodec = container === 'mp4' ? 'avc1' : 'vp8';

  return { container, videoCodec };
}

/** Picks the best container this browser says it can record, or null. */
export function pickMediaRecorderMimeType(
  environment: Pick<MediaRecorderEnvironment, 'isTypeSupported'>,
): string | null {
  for (const type of MEDIA_RECORDER_MIME_TYPES) {
    if (environment.isTypeSupported(type)) return type;
  }
  return null;
}

/** The slice of a canvas the recorder needs: a size and a capture stream. */
export interface RecordableCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): unknown;
  captureStream(frameRate?: number): MediaStreamLike;
}

export interface MediaStreamTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  addTrack(track: MediaStreamTrackLike): void;
  getTracks(): MediaStreamTrackLike[];
  getAudioTracks(): MediaStreamTrackLike[];
}

/** The part of an `AudioBuffer` the fallback fills. */
export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(destination: unknown): void;
  start(when?: number): void;
}

export interface MediaStreamDestinationLike {
  readonly stream: MediaStreamLike;
}

export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createMediaStreamDestination(): MediaStreamDestinationLike;
  close(): Promise<void>;
}

export interface BlobEventLike {
  readonly data: Blob;
}

export interface MediaRecorderErrorLike {
  readonly error?: Error;
}

export interface MediaRecorderLike {
  readonly mimeType: string;
  readonly state: string;
  ondataavailable: ((event: BlobEventLike) => void) | null;
  onstop: ((event: Event) => void) | null;
  onerror: ((event: MediaRecorderErrorLike) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface MediaRecorderOptionsLike {
  mimeType?: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface MediaRecorderFactory {
  new (stream: MediaStreamLike, options?: MediaRecorderOptionsLike): MediaRecorderLike;
  isTypeSupported?(type: string): boolean;
}

/**
 * Everything the fallback touches that jsdom does not have. Injecting it keeps
 * the sequencing testable without a real browser, and without timers.
 */
export interface MediaRecorderEnvironment {
  createCanvas(width: number, height: number): RecordableCanvas;
  createAudioContext(sampleRate: number): AudioContextLike;
  MediaRecorder: MediaRecorderFactory;
  isTypeSupported(type: string): boolean;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  /** Milliseconds on a monotone clock, for the progress estimate. */
  now(): number;
}

interface AudioContextScope {
  AudioContext?: new (options?: { sampleRate?: number }) => unknown;
  webkitAudioContext?: new (options?: { sampleRate?: number }) => unknown;
  MediaRecorder?: unknown;
  HTMLCanvasElement?: { prototype?: { captureStream?: unknown } };
}

function scopeOf(scope: typeof globalThis): AudioContextScope {
  return scope as unknown as AudioContextScope;
}

/**
 * Whether this browser can record a canvas with its sound. MediaRecorder alone
 * is not enough: the fallback needs a canvas that can be captured and an audio
 * graph to mix the recitation into.
 */
export function mediaRecorderAvailable(scope: typeof globalThis = globalThis): boolean {
  const candidates = scopeOf(scope);
  const hasRecorder = typeof candidates.MediaRecorder === 'function';
  const hasAudio =
    typeof candidates.AudioContext === 'function' ||
    typeof candidates.webkitAudioContext === 'function';
  const hasCapture = typeof candidates.HTMLCanvasElement?.prototype?.captureStream === 'function';
  return hasRecorder && hasAudio && hasCapture;
}

export function defaultMediaRecorderEnvironment(): MediaRecorderEnvironment {
  if (!mediaRecorderAvailable()) {
    throw new EncoderUnavailableError(
      'mediarecorder: this browser cannot record a canvas with sound',
    );
  }

  const scope = scopeOf(globalThis);
  const AudioContextClass = (scope.AudioContext ?? scope.webkitAudioContext)!;
  const Recorder = scope.MediaRecorder as unknown as MediaRecorderFactory;

  return {
    createCanvas(width, height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas as unknown as RecordableCanvas;
    },
    createAudioContext(sampleRate) {
      // Safari rejects some explicit rates (for example the 8 kHz of a test
      // WAV) with a generic UnknownError. A buffer carries its own rate, so
      // the context is free to run at the device's rate instead.
      try {
        return new AudioContextClass({ sampleRate }) as unknown as AudioContextLike;
      } catch {
        return new AudioContextClass() as unknown as AudioContextLike;
      }
    },
    MediaRecorder: Recorder,
    isTypeSupported(type) {
      return typeof Recorder.isTypeSupported === 'function' ? Recorder.isTypeSupported(type) : true;
    },
    requestFrame(callback) {
      return requestAnimationFrame(() => callback());
    },
    cancelFrame(handle) {
      cancelAnimationFrame(handle);
    },
    now() {
      return performance.now();
    },
  };
}

/**
 * Mixes every verse into one audio graph, each starting at its timeline
 * position, and returns the stream to add to the recorded picture.
 */
function scheduleAudio(
  plan: EncodePlan,
  audioContext: AudioContextLike,
  sampleRate: number,
): MediaStreamLike {
  const destination = audioContext.createMediaStreamDestination();
  const origin = audioContext.currentTime;

  plan.verses.forEach((verse, index) => {
    const audio: PlanarAudio | null = verse.audio;
    if (!audio) return;

    const buffer = audioContext.createBuffer(
      audio.numberOfChannels,
      audio.length,
      sampleRate,
    );
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      buffer.getChannelData(channel).set(audio.getChannelData(channel));
    }

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.start(origin + plan.timeline.entries[index].start);
  });

  return destination.stream;
}

/**
 * Records the plan in real time and writes the bytes to the sink as the
 * recorder produces them.
 *
 * A four-minute recitation takes four minutes here. That is the cost of
 * browsers without WebCodecs, and the reason Task 22 only uses this path when
 * `selectEncoder` has no better one.
 */
export async function encodeMediaRecorder(
  plan: EncodePlan,
  sink: OutputSink,
  onProgress: (progress: Progress) => void,
  environment: MediaRecorderEnvironment = defaultMediaRecorderEnvironment(),
): Promise<RenderedVideo> {
  validateEncodePlan(plan);

  const { width, height, fps, timeline, verses } = plan;
  const mimeType = pickMediaRecorderMimeType(environment);

  if (!mimeType) {
    await sink.abort();
    throw new EncoderUnavailableError(
      'mediarecorder: this browser records neither MP4 nor WebM',
    );
  }

  const hasAudio = verses.some((verse) => verse.audio);
  const sampleRate = verses.find((verse) => verse.audio)?.audio?.sampleRate ?? 48_000;
  const totalFrames = Math.max(1, Math.round(timeline.totalSec * fps));

  let audioContext: AudioContextLike | null = null;
  let stream: MediaStreamLike | null = null;
  let recorder: MediaRecorderLike | null = null;
  let recorderError: Error | null = null;
  let recorderStopped: Promise<void> = Promise.resolve();
  let writeError: Error | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let frameHandle: number | null = null;
  let drawn = 0;

  try {
    const canvas = environment.createCanvas(width, height);
    const compositor = new Compositor(canvas as unknown as OffscreenCanvas, plan.style, plan.background, {
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

    stream = canvas.captureStream(fps);

    if (hasAudio) {
      audioContext = environment.createAudioContext(sampleRate);
      for (const track of scheduleAudio(plan, audioContext, sampleRate).getAudioTracks()) {
        stream.addTrack(track);
      }
    }

    recorder = new environment.MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBitrateFor(width, height),
      audioBitsPerSecond: 128_000,
    });

    const activeRecorder = recorder;
    recorderStopped = new Promise<void>((resolve) => {
      activeRecorder.onstop = () => resolve();
      activeRecorder.onerror = (event) => {
        recorderError = event.error ?? new Error('mediarecorder: the recorder failed');
        resolve();
      };
    });

    recorder.ondataavailable = (event) => {
      const data = event.data;
      if (!data || data.size === 0) return;
      writeChain = writeChain
        .then(async () => {
          const bytes = new Uint8Array(await data.arrayBuffer());
          await sink.write(bytes);
        })
        .catch((error) => {
          writeError ??= error instanceof Error ? error : new Error(String(error));
        });
    };

    recorder.start(RECORDER_TIMESLICE_MS);
    const startedAt = environment.now();
    const activeCompositor = compositor;
    onProgress({ frame: 0, totalFrames, percent: 0, etaSec: 0 });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let painted = -1;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (frameHandle !== null) environment.cancelFrame(frameHandle);
        if (error) reject(error);
        else resolve();
      };

      const tick = () => {
        if (settled) return;
        try {
          if (recorderError) throw recorderError;
          if (writeError) throw writeError;

          // The clock, not the frame counter, decides where the picture is:
          // `requestAnimationFrame` fires at the display's rate, which has
          // nothing to do with the video's 30 or 60 fps.
          const elapsedSec = Math.max(0, (environment.now() - startedAt) / 1000);
          const frameIndex = Math.min(
            totalFrames - 1,
            Math.floor(elapsedSec * fps + 1e-6),
          );

          if (frameIndex !== painted) {
            activeCompositor.drawAt(frameIndex / fps);
            painted = frameIndex;
          }

          drawn = frameIndex + 1;
          const percent = Math.min(100, Math.round((drawn / totalFrames) * 100));
          const etaSec = drawn > 0 ? (elapsedSec / drawn) * (totalFrames - drawn) : 0;
          onProgress({ frame: drawn, totalFrames, percent, etaSec });

          if (elapsedSec >= timeline.totalSec) {
            settle();
            return;
          }
          frameHandle = environment.requestFrame(tick);
        } catch (error) {
          settle(error);
        }
      };

      tick();
    });

    if (recorderError) throw recorderError;
    if (recorder.state === 'recording') recorder.stop();
    await recorderStopped;
    if (recorderError) throw recorderError;

    await writeChain;
    if (writeError) throw writeError;

    const blob = await sink.finalize();
    const description = describeRecording(recorder.mimeType || mimeType);

    return {
      blob,
      durationSec: timeline.totalSec,
      width,
      height,
      container: description.container,
      videoCodec: description.videoCodec,
    };
  } catch (error) {
    if (frameHandle !== null) {
      environment.cancelFrame(frameHandle);
      frameHandle = null;
    }
    if (recorder && recorder.state === 'recording') {
      try {
        recorder.stop();
      } catch {
        // The recorder is already tearing itself down.
      }
    }
    if (stream) for (const track of stream.getTracks()) track.stop();
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // Closing a context twice, or a context that failed, is not an error.
      }
      audioContext = null;
    }
    await sink.abort();
    throw error;
  } finally {
    if (frameHandle !== null) environment.cancelFrame(frameHandle);
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Stopping an already-stopped track is harmless.
        }
      }
    }
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        // See above.
      }
    }
  }
}
