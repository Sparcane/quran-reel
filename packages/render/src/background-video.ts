/**
 * A video background decoded frame by frame with WebCodecs.
 *
 * Rendering is not real time: the compositor asks for a frame at time `t` and
 * expects it immediately. The source clip is therefore demuxed and decoded up
 * front, then replayed as a loop. Keeping the decoded frames resident is what
 * makes `paint` synchronous and free of any re-decoding when the playhead moves
 * backwards — which is also why the number of frames kept is capped
 * (`frameBudget`): past that point the loop is the beginning of the clip, not
 * the whole of it.
 */

import { createFile, DataStream, type Sample } from 'mp4box';
import type { BackgroundPainter, PaintContext, Size } from './background';

/** The structural subset of `EncodedVideoChunk` the decoder is given. */
export interface VideoChunkLike {
  readonly type: 'key' | 'delta';
  readonly timestamp: number;
  readonly duration: number;
  readonly byteLength: number;
  copyTo(destination: Uint8Array): void;
}

/** A decoded frame. Real `VideoFrame`s are directly drawable on a canvas. */
export interface VideoFrameLike {
  readonly timestamp: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

export interface VideoChunkInit {
  type: 'key' | 'delta';
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

export interface VideoDecoderConfigLike {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  optimizeForLatency?: boolean;
}

export interface VideoDecoderInitLike {
  output(frame: VideoFrameLike): void;
  error(error: Error): void;
}

export interface VideoDecoderLike {
  readonly state: string;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfigLike): void;
  decode(chunk: VideoChunkLike): void;
  flush(): Promise<void>;
  close(): void;
}

export interface VideoDecoderFactory {
  new (init: VideoDecoderInitLike): VideoDecoderLike;
  isConfigSupported?(config: VideoDecoderConfigLike): Promise<{ supported?: boolean }>;
}

/**
 * jsdom has no codecs and no frames, so the decoder and the chunk constructor
 * sit behind one seam — the same approach the encoders use.
 */
export interface BackgroundVideoEnvironment {
  videoDecoder: VideoDecoderFactory;
  createChunk(init: VideoChunkInit): VideoChunkLike;
}

/** Whether the platform can actually decode a video background. */
export function defaultBackgroundVideoEnvironment(
  scope: object = globalThis,
): BackgroundVideoEnvironment {
  const globals = scope as { VideoDecoder?: unknown; EncodedVideoChunk?: unknown };
  if (
    typeof globals.VideoDecoder !== 'function' ||
    typeof globals.EncodedVideoChunk !== 'function'
  ) {
    throw new Error(
      'background-video: WebCodecs VideoDecoder and EncodedVideoChunk are required',
    );
  }

  return {
    videoDecoder: globals.VideoDecoder as unknown as VideoDecoderFactory,
    createChunk: (init) =>
      new (globals.EncodedVideoChunk as new (init: VideoChunkInit) => VideoChunkLike)(init),
  };
}

/** H.264 is the one codec every browser we target can decode via WebCodecs. */
const H264_CODEC = /^avc[13]\./;

/** A decoder may emit B-frames out of order; hold at most this many to reorder. */
const REORDER_WINDOW = 30;

/**
 * How many decoded frames a painter may keep, and how much decoded picture
 * that may add up to.
 *
 * Every frame is held in memory so `paint` can stay synchronous, so a long or a
 * high-resolution source would otherwise be decoded in full: a five-minute
 * 1080p clip is 9 000 frames, tens of gigabytes. Four seconds at 30 fps is the
 * longest loop kept for a small source; the pixel ceiling keeps a 4K source to
 * roughly twenty frames, which is a fraction of a second, but bounded.
 */
export const MAX_FRAMES = 120;
const MAX_FRAME_PIXELS = 160_000_000;

/** The frame budget for a source decoded at `codedWidth × codedHeight`. */
export function frameBudget(codedWidth: number, codedHeight: number): number {
  const pixels = codedWidth > 0 && codedHeight > 0 ? codedWidth * codedHeight : 0;
  // An unknown size is no reason to tighten a budget nobody can check.
  if (pixels <= 0) return MAX_FRAMES;
  return Math.max(1, Math.min(MAX_FRAMES, Math.floor(MAX_FRAME_PIXELS / pixels)));
}

interface SourceSample {
  type: 'key' | 'delta';
  timestampUs: number;
  durationUs: number;
  data: Uint8Array;
}

interface DemuxedSource {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
  samples: SourceSample[];
  durationSec: number;
}

interface AvcC {
  configurationVersion: number;
  AVCProfileIndication: number;
  profile_compatibility: number;
  AVCLevelIndication: number;
  lengthSizeMinusOne: number;
  SPS?: Array<{ data: Uint8Array }>;
  PPS?: Array<{ data: Uint8Array }>;
}

/** Rebuild the AVCDecoderConfigurationRecord mp4box parsed into fields. */
function encoderDescription(
  file: ReturnType<typeof createFile>,
  trackId: number,
): Uint8Array | undefined {
  const entry = file.getTrackById(trackId)?.mdia?.minf?.stbl?.stsd?.entries?.[0] as
    | { avcC?: AvcC }
    | undefined;
  const config = entry?.avcC;
  if (!config) return undefined;

  const sps = config.SPS ?? [];
  const pps = config.PPS ?? [];
  const parameterBytes = [...sps, ...pps].reduce((sum, nalu) => sum + nalu.data.length, 0);
  // The first six bytes already include the SPS count; only the PPS count is
  // an extra byte after the parameter sets.
  const record = new Uint8Array(6 + sps.length * 2 + 1 + pps.length * 2 + parameterBytes);

  let offset = 0;
  record[offset++] = config.configurationVersion;
  record[offset++] = config.AVCProfileIndication;
  record[offset++] = config.profile_compatibility;
  record[offset++] = config.AVCLevelIndication;
  record[offset++] = 0xfc | (config.lengthSizeMinusOne & 0x03);
  record[offset++] = 0xe0 | (sps.length & 0x1f);
  for (const nalu of sps) {
    record[offset++] = nalu.data.length >> 8;
    record[offset++] = nalu.data.length & 0xff;
    record.set(nalu.data, offset);
    offset += nalu.data.length;
  }
  record[offset++] = pps.length & 0x1f;
  for (const nalu of pps) {
    record[offset++] = nalu.data.length >> 8;
    record[offset++] = nalu.data.length & 0xff;
    record.set(nalu.data, offset);
    offset += nalu.data.length;
  }
  return record;
}

/** Demux the whole MP4 through mp4box, including fragmented files. */
function demux(arrayBuffer: ArrayBuffer): DemuxedSource {
  const file = createFile();
  const extracted: Sample[] = [];

  file.onSamples = (_id, _user, samples) => {
    extracted.push(...samples);
  };
  file.onReady = (info) => {
    const track = info.videoTracks?.[0];
    if (!track) return;
    // mp4box only copies sample bytes once extraction has been asked for.
    file.setExtractionOptions(track.id, null, { nbSamples: 30 });
    file.start();
  };

  try {
    // The DataStream wrapper is what mp4box recognises as an owned buffer.
    file.appendBuffer(new DataStream(arrayBuffer).buffer, true);
    file.flush();
  } catch {
    throw new Error('background-video: the file is not a readable MP4 with a video track');
  }

  const track = file.getInfo().videoTracks?.[0];
  if (!track) {
    throw new Error('background-video: the file has no video track');
  }

  const samples: SourceSample[] = extracted
    .slice()
    .sort((a, b) => a.cts - b.cts)
    .map((sample) => ({
      type: sample.is_sync ? ('key' as const) : ('delta' as const),
      timestampUs: Math.round((sample.cts / sample.timescale) * 1_000_000),
      durationUs: Math.round((sample.duration / sample.timescale) * 1_000_000),
      data: sample.data ?? new Uint8Array(0),
    }));
  if (samples.length === 0) {
    throw new Error('background-video: the video track has no frames');
  }

  const last = extracted[extracted.length - 1];
  return {
    codec: track.codec,
    codedWidth: track.video?.width ?? 0,
    codedHeight: track.video?.height ?? 0,
    description: encoderDescription(file, track.id),
    samples,
    durationSec: (last.cts + last.duration) / last.timescale,
  };
}

/** Index of the frame covering `seconds`, looping the source as needed. */
function frameIndexAt(seconds: number, frames: VideoFrameLike[], loopSec: number): number {
  const position = ((seconds % loopSec) + loopSec) % loopSec;
  const targetUs = position * 1_000_000;

  let low = 0;
  let high = frames.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frames[middle].timestamp <= targetUs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** A test seam: production always uses the memory budget. */
export interface VideoPainterLimits {
  /**
   * Replaces the computed budget. The fixture in the tests is a fraction of a
   * second of a 64 px picture, so reaching the cap would otherwise need a
   * large binary file.
   */
  maxFrames?: number;
}

export async function createVideoPainter(
  file: Blob,
  size: Size,
  durationSec: number,
  environment: BackgroundVideoEnvironment = defaultBackgroundVideoEnvironment(),
  limits: VideoPainterLimits = {},
): Promise<BackgroundPainter> {
  for (const [name, value] of [
    ['width', size.width],
    ['height', size.height],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`background-video: size ${name} must be a positive number, got ${value}`);
    }
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`background-video: duration must be a positive number, got ${durationSec}`);
  }

  const source = demux(await file.arrayBuffer());
  if (!H264_CODEC.test(source.codec)) {
    throw new Error(
      `background-video: unsupported codec ${JSON.stringify(source.codec)}; only H.264 (avc1/avc3) backgrounds are supported`,
    );
  }

  const frames: VideoFrameLike[] = [];
  const pending: VideoFrameLike[] = [];
  let decodeError: Error | null = null;
  let disposed = false;
  let decoder: VideoDecoderLike | undefined;

  const release = () => {
    if (disposed) return;
    disposed = true;
    for (const frame of [...frames, ...pending]) frame.close();
    frames.length = 0;
    pending.length = 0;
    decoder?.close();
  };

  decoder = new environment.videoDecoder({
    output(frame) {
      pending.push(frame);
      if (pending.length < REORDER_WINDOW) return;
      pending.sort((a, b) => a.timestamp - b.timestamp);
      // The newest third may still be overtaken by a late B-frame, so commit
      // only the frames that are safe in presentation order.
      const commitCount = pending.length - Math.floor(REORDER_WINDOW / 3);
      frames.push(...pending.splice(0, commitCount));
    },
    error(error) {
      if (!decodeError) decodeError = error;
    },
  });

  let decoded = 0;
  let retainedEndUs = 0;

  try {
    decoder.configure({
      codec: source.codec,
      codedWidth: source.codedWidth,
      codedHeight: source.codedHeight,
      description: source.description,
      optimizeForLatency: true,
    });

    // Frames past the requested video length are never shown, so do not pay to
    // decode them. A shorter source is simply looped by `paint`.
    const decodeUntilUs = Math.min(source.durationSec, durationSec) * 1_000_000;
    const budget = Math.max(
      1,
      Math.floor(limits.maxFrames ?? frameBudget(source.codedWidth, source.codedHeight)),
    );
    for (const sample of source.samples) {
      if (sample.timestampUs >= decodeUntilUs) break;
      // The frames already decoded are the loop; going further would only cost
      // memory that nothing on screen ever asks for.
      if (decoded >= budget) break;
      decoder.decode(
        environment.createChunk({
          type: sample.type,
          timestamp: sample.timestampUs,
          duration: sample.durationUs,
          data: sample.data,
        }),
      );
      decoded += 1;
      retainedEndUs = sample.timestampUs + sample.durationUs;
    }
    await decoder.flush();
    if (decodeError) throw decodeError;
  } catch (error) {
    release();
    throw error;
  }

  pending.sort((a, b) => a.timestamp - b.timestamp);
  frames.push(...pending);
  pending.length = 0;
  frames.sort((a, b) => a.timestamp - b.timestamp);
  if (frames.length === 0) {
    release();
    throw new Error('background-video: the decoder produced no frames');
  }

  const loopSec = decoded < source.samples.length && retainedEndUs > 0
    ? Math.min(source.durationSec, retainedEndUs / 1_000_000)
    : source.durationSec;

  return {
    get ready() {
      return !disposed;
    },
    paint(ctx: PaintContext, t: number) {
      if (disposed || !Number.isFinite(t)) return;
      const frame = frames[frameIndexAt(t, frames, loopSec)];
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, size.width, size.height);
    },
    dispose: release,
  };
}
