import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameBudget, MAX_FRAMES } from '../src/background-video';
import { readVideoLoopWindow } from '../src/video-loop-window';

/** The fixture's own length: 120 samples of 33 ms. */
const SOURCE_SECONDS = 3.96;

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));
const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

function box(type: string, payload: number[]): number[] {
  return [...u32(8 + payload.length), ...ascii(type), ...payload];
}

function fullBox(type: string, version: number, payload: number[]): number[] {
  return box(type, [...u32(version << 24), ...payload]);
}

/** A full box whose three flag bytes matter, which is how `trun` marks its fields. */
function flagsBox(type: string, flags: number, payload: number[]): number[] {
  return box(type, [...u32(flags), ...payload]);
}

/** A visual sample entry: the frame size sits 24 bytes into the payload. */
function videoEntry(type: string, width: number, height: number): number[] {
  return box(type, [...[0, 0, 0, 0, 0, 0], ...u16(1), ...new Array(16).fill(0), ...u16(width), ...u16(height), 0, 0, 0, 0]);
}

/** An audio sample entry, which carries no picture size. */
function audioEntry(): number[] {
  return box('mp4a', [...[0, 0, 0, 0, 0, 0], ...u16(1), ...new Array(20).fill(0)]);
}

interface TrackOptions {
  entry: number[];
  /** [sample count, sample delta] runs, in media timescale ticks. */
  runs: [number, number][];
  timescale: number;
}

function track({ entry, runs, timescale }: TrackOptions): number[] {
  const duration = runs.reduce((total, [count, delta]) => total + count * delta, 0);
  const stsd = fullBox('stsd', 0, [...u32(1), ...entry]);
  const stts = fullBox('stts', 0, [
    ...u32(runs.length),
    ...runs.flatMap(([count, delta]) => [...u32(count), ...u32(delta)]),
  ]);
  const stbl = box('stbl', [...stsd, ...stts]);
  const minf = box('minf', stbl);
  const mdhd = fullBox('mdhd', 0, [
    ...u32(0),
    ...u32(0),
    ...u32(timescale),
    ...u32(duration),
    0,
    0,
    0,
    0,
  ]);
  return box('trak', [...box('mdia', [...mdhd, ...minf])]);
}

function movie(tracks: number[][]): Uint8Array {
  const ftyp = box('ftyp', [...ascii('isom'), ...u32(0), ...ascii('mp41')]);
  const moov = box('moov', [...box('mvhd', [...u32(0), ...new Array(20).fill(0)]), ...tracks.flat()]);
  return new Uint8Array([...ftyp, ...moov]);
}

/**
 * A fragmented movie, the shape ffmpeg's `frag_keyframe` produces: an empty
 * sample table and one fragment carrying `count` samples of `delta` ticks.
 */
function fragmented(
  count: number,
  fragmentTrackId: number,
  width = HD.width,
  height = HD.height,
): Uint8Array {
  const tkhd = fullBox('tkhd', 0, [...u32(0), ...u32(0), ...u32(1), ...new Array(8).fill(0)]);
  const stsd = fullBox('stsd', 0, [...u32(1), ...videoEntry('avc1', width, height)]);
  const stts = fullBox('stts', 0, u32(0));
  const stbl = box('stbl', [...stsd, ...stts]);
  const mdhd = fullBox('mdhd', 0, [
    ...u32(0),
    ...u32(0),
    ...u32(1000),
    ...u32(count * 33),
    0,
    0,
    0,
    0,
  ]);
  const trak = box('trak', [...tkhd, ...box('mdia', [...mdhd, ...box('minf', stbl)])]);
  const moov = box('moov', [...box('mvhd', [...u32(0), ...new Array(20).fill(0)]), ...trak]);

  const tfhd = flagsBox('tfhd', 0, u32(fragmentTrackId));
  const trun = flagsBox('trun', 0x100, [...u32(count), ...new Array(count).fill(33).flatMap(u32)]);
  const moof = box('moof', [...box('mfhd', [...u32(0), ...u32(1)]), ...box('traf', [...tfhd, ...trun])]);

  const ftyp = box('ftyp', [...ascii('isom'), ...u32(0), ...ascii('mp41')]);
  return new Uint8Array([...ftyp, ...moov, ...moof]);
}

/** 1080p at 30 fps: the pixel ceiling, not the frame ceiling, decides. */
const HD = { width: 1080, height: 1920 };
const HD_BUDGET = frameBudget(HD.width, HD.height);

describe('readVideoLoopWindow', () => {
  it('reports the frames the painter keeps and the seconds they cover', () => {
    const window = readVideoLoopWindow(
      movie([track({ entry: videoEntry('avc1', HD.width, HD.height), runs: [[300, 1001]], timescale: 30_000 })]),
    );

    expect(HD_BUDGET).toBeLessThan(MAX_FRAMES);
    expect(window).not.toBeNull();
    expect(window!.frames).toBe(HD_BUDGET);
    expect(window!.truncated).toBe(true);
    // 77 frames of 1001/30 000 s each.
    expect(window!.loopSec).toBeCloseTo((HD_BUDGET * 1001) / 30_000, 3);
  });

  it('does not warn about a clip the budget covers whole', () => {
    const window = readVideoLoopWindow(
      movie([track({ entry: videoEntry('avc1', HD.width, HD.height), runs: [[30, 1001]], timescale: 30_000 })]),
    );

    expect(window).toEqual({ frames: HD_BUDGET, truncated: false, loopSec: expect.closeTo(1.001, 3) });
  });

  it('follows the picture size, so a 4K source loops a fraction of a second', () => {
    const window = readVideoLoopWindow(
      movie([track({ entry: videoEntry('avc1', 3840, 2160), runs: [[300, 1001]], timescale: 30_000 })]),
    );

    const budget = frameBudget(3840, 2160);
    expect(budget).toBeLessThan(HD_BUDGET);
    expect(window!.frames).toBe(budget);
  });

  it('adds up several runs of sample durations', () => {
    const window = readVideoLoopWindow(
      movie([
        track({
          entry: videoEntry('avc1', HD.width, HD.height),
          runs: [
            [10, 100],
            [290, 1001],
          ],
          timescale: 30_000,
        }),
      ]),
    );

    const retainedUs = 10 * 100 + (HD_BUDGET - 10) * 1001;
    expect(window!.loopSec).toBeCloseTo(retainedUs / 30_000, 3);
  });

  it('reads the video track, not the audio track beside it', () => {
    const window = readVideoLoopWindow(
      movie([
        track({ entry: audioEntry(), runs: [[300, 1001]], timescale: 30_000 }),
        track({ entry: videoEntry('avc1', 640, 360), runs: [[30, 1001]], timescale: 30_000 }),
      ]),
    );

    expect(window).toEqual({ frames: MAX_FRAMES, truncated: false, loopSec: expect.closeTo(1.001, 3) });
  });

  it('accepts the avc3 sample entry too', () => {
    const window = readVideoLoopWindow(
      movie([track({ entry: videoEntry('avc3', 640, 360), runs: [[30, 1001]], timescale: 30_000 })]),
    );

    expect(window?.frames).toBe(MAX_FRAMES);
  });

  it('says nothing when the index is not in the window it was given', () => {
    // A non-faststart file keeps `moov` at the end: the head holds only `mdat`.
    const head = new Uint8Array(64);
    head.set(u32(56), 0);
    head.set(ascii('mdat'), 4);

    expect(readVideoLoopWindow(head)).toBeNull();
  });

  it('survives a box that claims more bytes than the window holds', () => {
    const bytes = movie([track({ entry: videoEntry('avc1', HD.width, HD.height), runs: [[300, 1001]], timescale: 30_000 })]);
    bytes.set(u32(bytes.length + 10_000), 0);

    expect(readVideoLoopWindow(bytes)).toBeNull();
  });

  it('says nothing about a track with no readable sample table', () => {
    const stbl = box('stbl', fullBox('stsd', 0, [...u32(1), ...videoEntry('avc1', HD.width, HD.height)]));
    const trak = box('trak', box('mdia', box('minf', stbl)));

    expect(readVideoLoopWindow(movie([trak]))).toBeNull();
  });

  it('reads the durations of a fragmented file from its fragments', () => {
    const window = readVideoLoopWindow(fragmented(300, 1));

    expect(window).toEqual({
      frames: HD_BUDGET,
      truncated: true,
      loopSec: expect.closeTo((HD_BUDGET * 33) / 1000, 3),
    });
  });

  it('ignores a fragment that belongs to another track', () => {
    expect(readVideoLoopWindow(fragmented(300, 2))).toBeNull();
  });

  it('stays silent about a fragmented file shorter than the budget', () => {
    // Nothing proves the file ends there: a later fragment may follow.
    expect(readVideoLoopWindow(fragmented(30, 1))).toBeNull();
  });

  it('reads a real H.264 file instead of only the bytes this test builds', () => {
    const path = resolve(process.cwd(), 'packages/render/test/fixtures/background.h264.mp4');
    // The fixture is fragmented: its sample table is empty and every fragment
    // carries one 33 ms sample. A budget of 60 turns 120 real samples into a
    // provable cut, which is what makes this a check of the offsets.
    const window = readVideoLoopWindow(new Uint8Array(readFileSync(path)), { maxFrames: 60 });

    expect(window).toEqual({
      frames: 60,
      truncated: true,
      loopSec: expect.closeTo((60 * 33) / 1000, 3),
    });
    expect(SOURCE_SECONDS).toBeCloseTo((120 * 33) / 1000, 3);
  });

  it('stays silent about a fragmented file that fits the budget', () => {
    // 120 samples, 120 frames kept: whether more fragments follow cannot be
    // told from this file alone, and a wrong number is worse than none.
    const path = resolve(process.cwd(), 'packages/render/test/fixtures/background.h264.mp4');

    expect(readVideoLoopWindow(new Uint8Array(readFileSync(path)))).toBeNull();
  });
});
