/**
 * A small fragmented-MP4 writer.
 *
 * The renderer produces H.264 and AAC chunks at whatever speed the device
 * allows, not in real time, so the file has to be assembled as those chunks
 * arrive. A fragmented MP4 is exactly that shape: `ftyp` + `moov` describe the
 * tracks once, then each fragment carries a couple of seconds of samples in a
 * `moof` + `mdat` pair. Nothing here buffers the whole video.
 *
 * Only the boxes a player needs are written. That is deliberate: an encoder
 * that produces a file nobody can open is worse than one that fails loudly, and
 * a small, fully tested surface is the only way to be sure of the bytes.
 */

/** Video timing is written in microseconds so frame bounds stay exact. */
export const VIDEO_TIMESCALE = 1_000_000;

/** Milliseconds, the customary `mvhd` timescale. */
const MOVIE_TIMESCALE = 1000;

export interface Mp4VideoTrackConfig {
  /** Full codec string, e.g. `avc1.640028`. */
  codec: string;
  width: number;
  height: number;
}

export interface Mp4AudioTrackConfig {
  sampleRate: number;
  channels: number;
}

export interface Mp4MuxerOptions {
  video: Mp4VideoTrackConfig;
  audio?: Mp4AudioTrackConfig | null;
  /** Length of the whole movie, in microseconds. */
  durationUs: number;
}

export interface Mp4VideoSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
  keyframe: boolean;
}

export interface Mp4AudioSample {
  data: Uint8Array;
  timestampUs: number;
  durationUs: number;
}

const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

// Every sample is described in full (size, duration, flags) rather than
// relying on track defaults, so a fragment can be read without its prehistory.
const TRUN_DATA_OFFSET = 0x000001;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTO = 0x000800;

const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

const SAMPLE_FLAGS_SYNC = 0x02000000;
const SAMPLE_FLAGS_DELTA = 0x01010000;

const IDENTITY_MATRIX = Uint8Array.of(
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
);

function u8(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff);
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u24(value: number): Uint8Array {
  return Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function u64(value: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    out[index] = text.charCodeAt(index) & 0xff;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 8 + body.length);
  header.set(ascii(type), 4);
  return concat([header, body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, Uint8Array.of(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
}

/** AAC sampling frequencies, indexed by the four-bit field of the config. */
const AUDIO_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * AudioSpecificConfig for AAC-LC. Used only when the encoder does not hand one
 * over with its first chunk — the header has to be written before the media,
 * and a config synthesised from the values we configured it with is correct
 * for everything the studio produces.
 */
export function audioSpecificConfig(sampleRate: number, channels: number): Uint8Array {
  const rateIndex = AUDIO_SAMPLE_RATES.indexOf(sampleRate);
  if (rateIndex < 0) {
    throw new Error(`muxer: ${sampleRate} Hz is not an AAC sampling frequency`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 7) {
    throw new Error(`muxer: AAC supports 1 to 7 channels, got ${channels}`);
  }
  const bits = (2 << 11) | (rateIndex << 7) | (channels << 3);
  return Uint8Array.of((bits >>> 8) & 0xff, bits & 0xff);
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  if (body.length > 0x7f) {
    throw new Error('muxer: descriptor payload is too long for a one-byte length');
  }
  return concat([u8(tag), u8(body.length), body]);
}

function esDescriptor(trackId: number, asc: Uint8Array, bitrate: number): Uint8Array {
  const decoderConfig = descriptor(
    0x04,
    concat([
      // 0x40 = MPEG-4 audio; the byte below says "audio stream" (5) and that
      // the upstream/reserved bits are clear.
      u8(0x40),
      u8(0x15),
      u24(6144),
      u32(bitrate),
      u32(bitrate),
      descriptor(0x05, asc),
    ]),
  );
  const slConfig = descriptor(0x06, u8(0x02));

  return descriptor(0x03, concat([u16(trackId), u8(0), decoderConfig, slConfig]));
}

function videoSampleEntry(width: number, height: number, avcC: Uint8Array): Uint8Array {
  return box(
    'avc1',
    new Uint8Array(6),
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    // Compressor name: a length-prefixed, space-padded 32-byte field.
    concat([u8(0), new Uint8Array(31)]),
    u16(0x0018),
    u16(0xffff),
    box('avcC', avcC),
  );
}

function audioSampleEntry(config: Mp4AudioTrackConfig, asc: Uint8Array, bitrate: number): Uint8Array {
  return box(
    'mp4a',
    new Uint8Array(6),
    u16(1),
    u32(0),
    u32(0),
    u16(config.channels),
    u16(16),
    u16(0),
    u16(0),
    u32(config.sampleRate << 16),
    fullBox('esds', 0, 0, esDescriptor(AUDIO_TRACK_ID, asc, bitrate)),
  );
}

function emptySampleTable(): Uint8Array[] {
  return [
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  ];
}

function dataInformation(): Uint8Array {
  return box(
    'dinf',
    fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)),
  );
}

function trackHeader(
  trackId: number,
  durationMs: number,
  width: number,
  height: number,
  volume: number,
): Uint8Array {
  return fullBox(
    'tkhd',
    0,
    0x000007, // enabled, in movie, in preview
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(durationMs),
    u64(0),
    u16(0),
    u16(0),
    u16(volume),
    u16(0),
    IDENTITY_MATRIX,
    u32(width << 16),
    u32(height << 16),
  );
}

/**
 * A fragmented track's media header carries duration 0 — the real length lives
 * in `mvhd`/`mehd` and in the fragments themselves.
 */
function mediaHeader(timescale: number): Uint8Array {
  return fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(0),
    u16(0x55c4), // "und"
    u16(0),
  );
}

function videoTrack(
  config: Mp4VideoTrackConfig,
  avcC: Uint8Array,
  durationMs: number,
): Uint8Array {
  return box(
    'trak',
    trackHeader(VIDEO_TRACK_ID, durationMs, config.width, config.height, 0),
    box(
      'mdia',
      mediaHeader(VIDEO_TIMESCALE),
      fullBox('hdlr', 0, 0, u32(0), ascii('vide'), new Uint8Array(12), concat([ascii('VideoHandler'), u8(0)])),
      box(
        'minf',
        fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
        dataInformation(),
        box(
          'stbl',
          fullBox('stsd', 0, 0, u32(1), videoSampleEntry(config.width, config.height, avcC)),
          ...emptySampleTable(),
        ),
      ),
    ),
  );
}

function audioTrack(
  config: Mp4AudioTrackConfig,
  asc: Uint8Array,
  durationMs: number,
  bitrate: number,
): Uint8Array {
  return box(
    'trak',
    trackHeader(AUDIO_TRACK_ID, durationMs, 0, 0, 0x0100),
    box(
      'mdia',
      mediaHeader(config.sampleRate),
      fullBox('hdlr', 0, 0, u32(0), ascii('soun'), new Uint8Array(12), concat([ascii('SoundHandler'), u8(0)])),
      box(
        'minf',
        fullBox('smhd', 0, 0, u16(0), u16(0)),
        dataInformation(),
        box(
          'stbl',
          fullBox('stsd', 0, 0, u32(1), audioSampleEntry(config, asc, bitrate)),
          ...emptySampleTable(),
        ),
      ),
    ),
  );
}

function trackExtends(trackId: number): Uint8Array {
  return fullBox('trex', 0, 0, u32(trackId), u32(1), u32(0), u32(0), u32(0));
}

function movieHeader(durationMs: number): Uint8Array {
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(durationMs),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    IDENTITY_MATRIX,
    new Uint8Array(24),
    u32(3),
  );
}

function fileTypeBox(): Uint8Array {
  return box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
}

export class Mp4Muxer {
  private readonly options: Mp4MuxerOptions;
  private videoDescription: Uint8Array | null = null;
  private audioDescription: Uint8Array | null = null;
  private pendingVideo: Mp4VideoSample[] = [];
  private pendingAudio: Mp4AudioSample[] = [];
  private sequence = 0;
  private videoSamplesWritten = 0;
  private audioSamplesWritten = 0;

  constructor(options: Mp4MuxerOptions) {
    if (!Number.isFinite(options.durationUs) || options.durationUs < 0) {
      throw new Error('muxer: durationUs must be a finite, non-negative number');
    }
    this.options = options;
  }

  /** The `avcC` bytes reported with the first encoded video chunk. */
  setVideoDescription(description: Uint8Array | undefined): void {
    if (!description || description.length === 0) {
      throw new Error('muxer: the video encoder did not report an avcC description');
    }
    this.videoDescription = description.slice();
  }

  /** The AudioSpecificConfig reported with the first encoded audio chunk. */
  setAudioDescription(description: Uint8Array | undefined): void {
    if (description && description.length > 0) this.audioDescription = description.slice();
  }

  hasVideoDescription(): boolean {
    return this.videoDescription !== null;
  }

  get sampleCounts(): { video: number; audio: number } {
    return { video: this.videoSamplesWritten, audio: this.audioSamplesWritten };
  }

  /** `ftyp` + `moov`. Must be written before any fragment. */
  buildHeader(): Uint8Array {
    if (!this.videoDescription) {
      throw new Error('muxer: the header needs the video description from the first encoded frame');
    }

    const { video, audio, durationUs } = this.options;
    const durationMs = Math.round(durationUs / 1000);
    const tracks: Uint8Array[] = [
      movieHeader(durationMs),
      videoTrack(video, this.videoDescription, durationMs),
    ];
    const extended: Uint8Array[] = [fullBox('mehd', 0, 0, u32(durationMs)), trackExtends(VIDEO_TRACK_ID)];

    if (audio) {
      const asc = this.audioDescription ?? audioSpecificConfig(audio.sampleRate, audio.channels);
      tracks.push(audioTrack(audio, asc, durationMs, 128_000));
      extended.push(trackExtends(AUDIO_TRACK_ID));
    }

    return concat([fileTypeBox(), box('moov', ...tracks, box('mvex', ...extended))]);
  }

  addVideoSample(sample: Mp4VideoSample): void {
    this.pendingVideo.push(sample);
  }

  addAudioSample(sample: Mp4AudioSample): void {
    if (!this.options.audio) {
      throw new Error('muxer: audio samples were added to a muxer configured without audio');
    }
    this.pendingAudio.push(sample);
  }

  /**
   * `moof` + `mdat` for every pending video sample and the audio samples that
   * start before `beforeUs`. Returns null when there is nothing to write.
   */
  takeFragment(beforeUs = Number.POSITIVE_INFINITY): Uint8Array | null {
    const video = this.pendingVideo;
    const audio = this.pendingAudio.filter((sample) => sample.timestampUs < beforeUs);

    if (video.length === 0 && audio.length === 0) return null;

    this.pendingVideo = [];
    this.pendingAudio = this.pendingAudio.filter((sample) => sample.timestampUs >= beforeUs);
    this.sequence += 1;

    const videoData = video.map((sample) => sample.data);
    const audioData = audio.map((sample) => sample.data);
    const videoBytes = videoData.reduce((total, data) => total + data.length, 0);

    const buildMoof = (videoOffset: number, audioOffset: number): Uint8Array => {
      const trafs: Uint8Array[] = [];
      if (video.length > 0) {
        trafs.push(buildTraf(VIDEO_TRACK_ID, video, VIDEO_TIMESCALE, videoOffset, true));
      }
      if (audio.length > 0) {
        trafs.push(buildTraf(AUDIO_TRACK_ID, audio, this.options.audio!.sampleRate, audioOffset, false));
      }
      return box('moof', fullBox('mfhd', 0, 0, u32(this.sequence)), ...trafs);
    };

    // `tfhd` says the data offsets are relative to the start of this `moof`, so
    // the offsets depend on the `moof`'s own length. Build it once to measure,
    // then again with the real offsets; the size cannot change between the two
    // because offsets are fixed-width fields.
    const measured = buildMoof(0, 0);
    const firstData = measured.length + 8;
    const moof = buildMoof(firstData, firstData + videoBytes);
    const mdat = box('mdat', ...videoData, ...audioData);

    this.videoSamplesWritten += video.length;
    this.audioSamplesWritten += audio.length;

    return concat([moof, mdat]);
  }
}

function buildTraf(
  trackId: number,
  samples: readonly { data: Uint8Array; timestampUs: number; durationUs: number; keyframe?: boolean }[],
  timescale: number,
  dataOffset: number,
  withFlags: boolean,
): Uint8Array {
  const toTicks = (microseconds: number) => Math.max(1, Math.round((microseconds * timescale) / 1_000_000));
  const baseTime = Math.round((samples[0].timestampUs * timescale) / 1_000_000);

  const flagBits =
    TRUN_DATA_OFFSET |
    TRUN_SAMPLE_DURATION |
    TRUN_SAMPLE_SIZE |
    TRUN_SAMPLE_CTO |
    (withFlags ? TRUN_SAMPLE_FLAGS : 0);

  const sampleFields: Uint8Array[] = [];
  for (const sample of samples) {
    sampleFields.push(u32(toTicks(sample.durationUs)));
    sampleFields.push(u32(sample.data.length));
    if (withFlags) sampleFields.push(u32(sample.keyframe ? SAMPLE_FLAGS_SYNC : SAMPLE_FLAGS_DELTA));
    // No frame reordering is requested from the encoder, so presentation time
    // equals decode time and every composition offset is zero.
    sampleFields.push(i32(0));
  }

  return box(
    'traf',
    fullBox('tfhd', 0, TFHD_DEFAULT_BASE_IS_MOOF, u32(trackId)),
    fullBox('tfdt', 1, 0, u64(baseTime)),
    fullBox('trun', 0, flagBits, u32(samples.length), i32(dataOffset), ...sampleFields),
  );
}
