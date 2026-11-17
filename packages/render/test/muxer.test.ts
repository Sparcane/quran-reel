import { describe, expect, it } from 'vitest';
import {
  audioSpecificConfig,
  Mp4Muxer,
  VIDEO_TIMESCALE,
  type Mp4AudioSample,
  type Mp4VideoSample,
} from '../src/muxer';

interface ParsedBox {
  type: string;
  start: number;
  size: number;
  payload: Uint8Array;
}

const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'mvex',
  'moof',
  'traf',
  'dinf',
  'mfra',
]);

function readBoxes(bytes: Uint8Array, start = 0, end = bytes.length): ParsedBox[] {
  const boxes: ParsedBox[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const size = view.getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > end) {
      throw new Error(`test parser: box ${type} at ${offset} has size ${size}`);
    }
    boxes.push({
      type,
      start: offset + bytes.byteOffset,
      size,
      payload: bytes.subarray(offset + 8, offset + size),
    });
    offset += size;
  }
  return boxes;
}

function children(box: ParsedBox): ParsedBox[] {
  if (CONTAINERS.has(box.type)) return readBoxes(box.payload);
  // Sample entries start with their own fixed fields before their child boxes.
  if (box.type === 'stsd') return readBoxes(box.payload, 8);
  if (box.type === 'avc1') return readBoxes(box.payload, 78);
  if (box.type === 'mp4a') return readBoxes(box.payload, 28);
  return [];
}

function descend(boxes: ParsedBox[], ...path: string[]): ParsedBox {
  let current: ParsedBox | undefined;
  let level = boxes;
  for (const type of path) {
    current = level.find((box) => box.type === type);
    if (!current) throw new Error(`test parser: no ${type} inside ${level.map((b) => b.type).join('/')}`);
    level = children(current);
  }
  return current as ParsedBox;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matches = true;
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[start + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

const AVC_C = Uint8Array.of(
  0x01, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0x00, 0x1f, 0x01, 0x00, 0x04, 0x68,
  0xce, 0x3c, 0x80,
);

function bytesOf(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function muxerWithBothTracks(durationUs = 6_100_000) {
  const muxer = new Mp4Muxer({
    video: { codec: 'avc1.640028', width: 1080, height: 1920 },
    audio: { sampleRate: 48000, channels: 2 },
    durationUs,
  });
  muxer.setVideoDescription(AVC_C);
  return muxer;
}

function videoSample(timestampUs: number, durationUs: number, fill: number, size = 10): Mp4VideoSample {
  return { data: bytesOf(size, fill), timestampUs, durationUs, keyframe: fill === 1 };
}

describe('audioSpecificConfig', () => {
  it('writes AAC-LC, 48 kHz, stereo', () => {
    expect([...audioSpecificConfig(48000, 2)]).toEqual([0x11, 0x90]);
  });

  it('refuses a rate or a channel count AAC cannot carry', () => {
    expect(() => audioSpecificConfig(12345, 2)).toThrow(/sampling frequency/);
    expect(() => audioSpecificConfig(48000, 0)).toThrow(/channels/);
  });
});

describe('Mp4Muxer header', () => {
  it('refuses to build a header before it has the avcC bytes', () => {
    const muxer = new Mp4Muxer({
      video: { codec: 'avc1.640028', width: 1080, height: 1920 },
      audio: { sampleRate: 48000, channels: 2 },
      durationUs: 1_000_000,
    });

    expect(() => muxer.buildHeader()).toThrow(/video description|avcC/);
  });

  it('starts with an ftyp a player recognises, before the moov', () => {
    const bytes = muxerWithBothTracks().buildHeader();
    const top = readBoxes(bytes);

    expect(top.map((box) => box.type)).toEqual(['ftyp', 'moov']);
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe('ftyp');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('isom');
    // Compatible brands: mp41 is what old players look for.
    const brands = new TextDecoder().decode(bytes.subarray(16, 32));
    expect(brands).toContain('mp41');
    expect(brands).toContain('avc1');
  });

  it('describes a video track with the avcC the encoder produced', () => {
    const bytes = muxerWithBothTracks().buildHeader();
    const top = readBoxes(bytes);
    const moov = top[1];

    const traks = children(moov).filter((box) => box.type === 'trak');
    expect(traks).toHaveLength(2);

    const avcC = descend(children(moov), 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC');
    expect([...avcC.payload]).toEqual([...AVC_C]);

    const mdhd = descend(children(moov), 'trak', 'mdia', 'mdhd');
    // version/flags are the first four bytes, then creation and modification.
    const view = new DataView(mdhd.payload.buffer, mdhd.payload.byteOffset);
    expect(view.getUint32(12)).toBe(VIDEO_TIMESCALE);
  });

  it('describes an AAC audio track with an esds carrying the config', () => {
    const bytes = muxerWithBothTracks().buildHeader();
    const stsd = descend(readBoxes(bytes), 'moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd');
    const tracks = children(readBoxes(bytes)[1]).filter((box) => box.type === 'trak');
    const audioStsd = descend([tracks[1]], 'trak', 'mdia', 'minf', 'stbl', 'stsd');
    const mp4a = children(audioStsd)[0];

    expect(stsd.type).toBe('stsd');
    expect(mp4a.type).toBe('mp4a');
    const esds = children(mp4a).find((box) => box.type === 'esds');
    expect(esds).toBeDefined();
    expect(contains(esds!.payload, Uint8Array.of(0x11, 0x90))).toBe(true);
    expect(contains(esds!.payload, Uint8Array.of(0x40, 0x15))).toBe(true);
  });

  it('writes the movie duration and the track extends defaults', () => {
    const bytes = muxerWithBothTracks(6_100_000).buildHeader();
    const moov = readBoxes(bytes)[1];
    const mvhd = children(moov)[0];
    const view = new DataView(mvhd.payload.buffer, mvhd.payload.byteOffset);

    // version/flags(4) + creation(4) + modification(4) + timescale(4) + duration(4)
    expect(view.getUint32(12)).toBe(1000);
    expect(view.getUint32(16)).toBe(6100);

    const trex = children(children(moov).find((box) => box.type === 'mvex')!);
    expect(trex.map((box) => box.type)).toEqual(['mehd', 'trex', 'trex']);
  });

  it('leaves the audio track out when the render has no sound', () => {
    const muxer = new Mp4Muxer({
      video: { codec: 'avc1.42001f', width: 1280, height: 720 },
      durationUs: 1_000_000,
    });
    muxer.setVideoDescription(AVC_C);

    const moov = readBoxes(muxer.buildHeader())[1];
    expect(children(moov).filter((box) => box.type === 'trak')).toHaveLength(1);
  });
});

describe('Mp4Muxer fragments', () => {
  it('returns nothing when no sample is pending', () => {
    expect(muxerWithBothTracks().takeFragment()).toBeNull();
  });

  it('writes a moof and an mdat whose sample offsets point at the sample bytes', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(0, 33_333, 1, 10));
    muxer.addVideoSample(videoSample(33_333, 33_333, 0, 20));
    muxer.addVideoSample(videoSample(66_666, 33_334, 0, 30));

    const fragment = muxer.takeFragment()!;
    const top = readBoxes(fragment);
    expect(top.map((box) => box.type)).toEqual(['moof', 'mdat']);

    const moof = top[0];
    const mdat = top[1];
    const traf = children(moof).find((box) => box.type === 'traf')!;
    const trun = children(traf).find((box) => box.type === 'trun')!;
    const view = new DataView(trun.payload.buffer, trun.payload.byteOffset);

    const sampleCount = view.getUint32(4);
    const dataOffset = view.getInt32(8);
    expect(sampleCount).toBe(3);

    // The offsets are relative to the start of the moof, and the mdat header is
    // eight bytes; the three samples follow one another.
    expect(dataOffset).toBe(moof.size + 8);
    const sizes = [10, 20, 30];
    let cursor = dataOffset - (moof.start - fragment.byteOffset);
    for (const size of sizes) {
      expect(fragment.subarray(cursor, cursor + size)).toEqual(
        mdat.payload.subarray(cursor - (moof.size + 8), cursor - (moof.size + 8) + size),
      );
      cursor += size;
    }
    expect(mdat.payload.length).toBe(60);
    expect([...mdat.payload.subarray(0, 10)]).toEqual([...bytesOf(10, 1)]);
  });

  it('records each sample duration, size and sync flag', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(0, 33_333, 1, 10));
    muxer.addVideoSample(videoSample(33_333, 33_334, 0, 20));

    const fragment = muxer.takeFragment()!;
    const trun = descend(readBoxes(fragment), 'moof', 'traf', 'trun');
    const view = new DataView(trun.payload.buffer, trun.payload.byteOffset);

    // version/flags(4), sample_count(4), data_offset(4), then samples.
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(12)).toBe(33_333); // duration of the first sample
    expect(view.getUint32(16)).toBe(10); // its size
    expect(view.getUint32(20)).toBe(0x02000000); // sync
    expect(view.getUint32(28)).toBe(33_334);
    expect(view.getUint32(36)).toBe(0x01010000); // delta
  });

  it('carries the decode time of the first sample in microseconds', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(2_000_000, 33_333, 1));

    const tfdt = descend(readBoxes(muxer.takeFragment()!), 'moof', 'traf', 'tfdt');
    const view = new DataView(tfdt.payload.buffer, tfdt.payload.byteOffset);
    expect(view.getUint32(0)).toBe(0x01000000); // version 1
    expect(view.getBigUint64(4)).toBe(2_000_000n);
  });

  it('interleaves audio in the same fragment, after the video bytes', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(0, 33_333, 1, 10));
    muxer.addAudioSample({ data: bytesOf(4, 9), timestampUs: 0, durationUs: 21_333 });
    muxer.addAudioSample({ data: bytesOf(4, 8), timestampUs: 21_333, durationUs: 21_333 });

    const fragment = muxer.takeFragment()!;
    const top = readBoxes(fragment);
    const trafs = children(top[0]).filter((box) => box.type === 'traf');
    expect(trafs).toHaveLength(2);
    expect(top[1].payload.length).toBe(18);

    const audioTrun = children(trafs[1]).find((box) => box.type === 'trun')!;
    const view = new DataView(audioTrun.payload.buffer, audioTrun.payload.byteOffset);
    expect(view.getUint32(4)).toBe(2);
    expect(view.getInt32(8)).toBe(top[0].size + 8 + 10); // after the video bytes
    // 48 kHz timescale: 21 333 µs is 1024 samples.
    expect(view.getUint32(12)).toBe(1024);

    const audioTfdt = children(trafs[1]).find((box) => box.type === 'tfdt')!;
    expect(
      new DataView(audioTfdt.payload.buffer, audioTfdt.payload.byteOffset).getBigUint64(4),
    ).toBe(0n);
  });

  it('splits audio at the requested time and keeps the rest for the next fragment', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(0, 33_333, 1, 10));
    muxer.addAudioSample({ data: bytesOf(4, 1), timestampUs: 0, durationUs: 21_333 });
    muxer.addAudioSample({ data: bytesOf(4, 2), timestampUs: 2_000_000, durationUs: 21_333 });

    const first = muxer.takeFragment(1_000_000)!;
    expect(readBoxes(first)[1].payload.length).toBe(14);

    const second = muxer.takeFragment()!;
    expect(readBoxes(second)[1].payload.length).toBe(4);
  });

  it('numbers the fragments in order and counts what it wrote', () => {
    const muxer = muxerWithBothTracks();
    muxer.addVideoSample(videoSample(0, 33_333, 1));
    const first = muxer.takeFragment()!;
    muxer.addVideoSample(videoSample(33_333, 33_333, 0));
    const second = muxer.takeFragment()!;

    const sequence = (fragment: Uint8Array) => {
      const mfhd = descend(readBoxes(fragment), 'moof', 'mfhd');
      return new DataView(mfhd.payload.buffer, mfhd.payload.byteOffset).getUint32(4);
    };

    expect([sequence(first), sequence(second)]).toEqual([1, 2]);
    expect(muxer.sampleCounts).toEqual({ video: 2, audio: 0 });
  });

  it('writes the same bytes for the same samples', () => {
    const build = () => {
      const muxer = muxerWithBothTracks();
      muxer.addVideoSample(videoSample(0, 33_333, 1));
      muxer.addAudioSample({ data: bytesOf(4, 9), timestampUs: 0, durationUs: 21_333 });
      return muxer.takeFragment()!;
    };

    expect([...build()]).toEqual([...build()]);
  });

  it('refuses audio samples when the muxer was built without an audio track', () => {
    const muxer = new Mp4Muxer({
      video: { codec: 'avc1.42001f', width: 640, height: 360 },
      durationUs: 1_000_000,
    });

    expect(() => muxer.addAudioSample({ data: new Uint8Array(1), timestampUs: 0, durationUs: 1 })).toThrow(
      /without audio/,
    );
  });

  it('refuses a duration that cannot be written', () => {
    expect(
      () =>
        new Mp4Muxer({
          video: { codec: 'avc1.42001f', width: 640, height: 360 },
          durationUs: Number.NaN,
        }),
    ).toThrow(/durationUs/);
  });
});
