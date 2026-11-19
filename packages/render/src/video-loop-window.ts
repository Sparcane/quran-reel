/**
 * How much of a video background the renderer will actually keep.
 *
 * `createVideoPainter` holds every decoded frame in memory so `paint` can stay
 * synchronous, which caps the clip it replays (`frameBudget`). Nothing told the
 * user that a normal 1080p clip is looped on its first two or three seconds, so
 * the studio can warn before the render — but only if the answer is read from
 * the file itself rather than guessed.
 *
 * The picture size in the sample entry gives the frame budget, and the sample
 * durations give the seconds those frames cover. A plain file lists them once in
 * `stts`; a fragmented file (the shape ffmpeg's `frag_keyframe` produces) lists
 * them in a `trun` per fragment. Only what the given window of bytes contains is
 * examined, and nothing is reported that the bytes do not prove.
 */

import { frameBudget } from './background-video';

/** The sample entries that carry an H.264 picture. */
const VIDEO_ENTRIES = ['avc1', 'avc3'];

export interface VideoLoopWindow {
  /** Frames the painter keeps. */
  frames: number;
  /** Whether the loop is shorter than the source. */
  truncated: boolean;
  /** Seconds one pass of the loop covers. */
  loopSec: number;
}

/** A test seam: production always uses the memory budget of the painter. */
export interface VideoLoopWindowLimits {
  maxFrames?: number;
}

interface Box {
  type: string;
  /** First byte of the payload. */
  body: number;
  /** First byte after the box. */
  end: number;
}

function readUint16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function typeAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * The boxes that sit between `from` and `to`, siblings at one level.
 *
 * A size that does not fit inside the window ends the walk instead of throwing:
 * the caller passed a slice, not a whole file, and the slice may end anywhere.
 */
function siblings(bytes: Uint8Array, from: number, to: number): Box[] {
  const found: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = readUint32(bytes, at);
    let header = 8;
    if (size === 1) {
      // A 64-bit `largesize`; no window this module reads is that big, so it
      // can only describe a box that does not fit.
      if (at + 16 > to) return found;
      size = readUint32(bytes, at + 8) * 2 ** 32 + readUint32(bytes, at + 12);
      header = 16;
    } else if (size === 0) {
      // "To the end of the container", which here is the end of the window.
      size = to - at;
    }
    if (size < header || at + size > to) return found;
    found.push({ type: typeAt(bytes, at + 4), body: at + header, end: at + size });
    at += size;
  }
  return found;
}

function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return siblings(bytes, parent.body, parent.end).find((box) => box.type === type) ?? null;
}

/** Media timescale: the version decides whether the times are 32 or 64 bits. */
function mediaTimescale(bytes: Uint8Array, mdia: Box): number {
  const mdhd = child(bytes, mdia, 'mdhd');
  if (!mdhd) return 0;
  const at = bytes[mdhd.body] === 1 ? mdhd.body + 20 : mdhd.body + 12;
  return at + 4 <= mdhd.end ? readUint32(bytes, at) : 0;
}

/** `tkhd` carries the track id a fragment's `tfhd` refers to. */
function trackId(bytes: Uint8Array, trak: Box): number {
  const tkhd = child(bytes, trak, 'tkhd');
  if (!tkhd) return 0;
  const at = bytes[tkhd.body] === 1 ? tkhd.body + 20 : tkhd.body + 12;
  return at + 4 <= tkhd.end ? readUint32(bytes, at) : 0;
}

/**
 * Running totals over the samples seen so far, in the order the decoder meets
 * them: everything counts towards the source, the first `budget` samples also
 * count towards the loop.
 */
interface Tally {
  budget: number;
  samples: number;
  ticks: number;
  keptSamples: number;
  keptTicks: number;
}

function addSamples(tally: Tally, count: number, delta: number): void {
  tally.samples += count;
  tally.ticks += count * delta;
  if (tally.keptSamples < tally.budget) {
    const kept = Math.min(count, tally.budget - tally.keptSamples);
    tally.keptSamples += kept;
    tally.keptTicks += kept * delta;
  }
}

/** `stts`: the run-length encoded durations of a plain file's samples. */
function addTimeToSample(bytes: Uint8Array, stbl: Box, tally: Tally): void {
  const stts = child(bytes, stbl, 'stts');
  if (!stts) return;
  const count = readUint32(bytes, stts.body + 4);
  for (let index = 0; index < count; index += 1) {
    const at = stts.body + 8 + index * 8;
    if (at + 8 > stts.end) return;
    addSamples(tally, readUint32(bytes, at), readUint32(bytes, at + 4));
  }
}

/** The optional per-sample fields a `trun` may carry, in order. */
const TRUN_DATA_OFFSET = 0x01;
const TRUN_FIRST_SAMPLE_FLAGS = 0x04;
const TRUN_SAMPLE_DURATION = 0x100;
const TRUN_SAMPLE_SIZE = 0x200;
const TRUN_SAMPLE_FLAGS = 0x400;
const TRUN_SAMPLE_COMPOSITION = 0x800;

function addTrackRun(
  bytes: Uint8Array,
  trun: Box,
  defaultDuration: number,
  tally: Tally,
): void {
  const flags = readUint32(bytes, trun.body) & 0xffffff;
  const count = readUint32(bytes, trun.body + 4);
  let at = trun.body + 8;
  if (flags & TRUN_DATA_OFFSET) at += 4;
  if (flags & TRUN_FIRST_SAMPLE_FLAGS) at += 4;

  const step =
    4 *
    ((flags & TRUN_SAMPLE_DURATION ? 1 : 0) +
      (flags & TRUN_SAMPLE_SIZE ? 1 : 0) +
      (flags & TRUN_SAMPLE_FLAGS ? 1 : 0) +
      (flags & TRUN_SAMPLE_COMPOSITION ? 1 : 0));

  for (let index = 0; index < count; index += 1) {
    if (flags & TRUN_SAMPLE_DURATION) {
      if (at + 4 > trun.end) return;
      addSamples(tally, 1, readUint32(bytes, at));
    } else {
      addSamples(tally, 1, defaultDuration);
    }
    at += step;
  }
}

/**
 * The samples of one fragment that belong to this track. A `tfhd` names its
 * track, so an audio fragment beside the video one is skipped rather than
 * counted.
 */
function addFragment(
  bytes: Uint8Array,
  moof: Box,
  id: number,
  tally: Tally,
): void {
  for (const traf of siblings(bytes, moof.body, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(bytes, traf, 'tfhd');
    if (!tfhd) continue;
    const flags = readUint32(bytes, tfhd.body) & 0xffffff;
    if (readUint32(bytes, tfhd.body + 4) !== id) continue;

    let at = tfhd.body + 8;
    if (flags & 0x01) at += 8; // base data offset
    if (flags & 0x02) at += 4; // sample description index
    let defaultDuration = 0;
    if (flags & 0x08) {
      if (at + 4 > tfhd.end) continue;
      defaultDuration = readUint32(bytes, at);
    }

    for (const trun of siblings(bytes, traf.body, traf.end)) {
      if (trun.type === 'trun') addTrackRun(bytes, trun, defaultDuration, tally);
    }
  }
}

/** The window of one track, or null when it is not a readable H.264 picture. */
function trackWindow(
  bytes: Uint8Array,
  trak: Box,
  fragments: Box[],
  limits: VideoLoopWindowLimits,
): VideoLoopWindow | null {
  const mdia = child(bytes, trak, 'mdia');
  if (!mdia) return null;
  const minf = child(bytes, mdia, 'minf');
  if (!minf) return null;
  const stbl = child(bytes, minf, 'stbl');
  if (!stbl) return null;
  const stsd = child(bytes, stbl, 'stsd');
  if (!stsd) return null;

  // `stsd` holds a version and flags, the entry count, then the entries.
  const [entry] = siblings(bytes, stsd.body + 8, stsd.end);
  if (!entry || !VIDEO_ENTRIES.includes(entry.type)) return null;
  // A visual sample entry places the picture size 24 bytes into its payload:
  // six reserved bytes, the data reference index and sixteen more before it.
  const width = readUint16(bytes, entry.body + 24);
  const height = readUint16(bytes, entry.body + 26);
  if (width <= 0 || height <= 0) return null;

  const timescale = mediaTimescale(bytes, mdia);
  if (timescale <= 0) return null;

  const budget = Math.max(
    1,
    Math.floor(limits.maxFrames ?? frameBudget(width, height)),
  );
  const tally: Tally = { budget, samples: 0, ticks: 0, keptSamples: 0, keptTicks: 0 };
  addTimeToSample(bytes, stbl, tally);

  if (tally.samples === 0) {
    // A fragmented file: the sample table is empty and the durations live in
    // the fragments. A sample past the budget proves the clip is cut; a window
    // that ends at the budget proves nothing, so it stays silent.
    const id = trackId(bytes, trak);
    for (const moof of fragments) addFragment(bytes, moof, id, tally);
    if (tally.samples <= tally.budget) return null;
    return { frames: budget, truncated: true, loopSec: tally.keptTicks / timescale };
  }

  const truncated = tally.keptSamples < tally.samples;
  return {
    frames: budget,
    truncated,
    loopSec: (truncated ? tally.keptTicks : tally.ticks) / timescale,
  };
}

/**
 * Reads the loop window from a window of the file: `moov` must be inside it,
 * which is the case at the head of a faststart file and at the tail of one that
 * keeps its index at the end.
 */
export function readVideoLoopWindow(
  bytes: Uint8Array,
  limits: VideoLoopWindowLimits = {},
): VideoLoopWindow | null {
  const top = siblings(bytes, 0, bytes.length);
  const fragments = top.filter((box) => box.type === 'moof');
  for (const moov of top) {
    if (moov.type !== 'moov') continue;
    for (const trak of siblings(bytes, moov.body, moov.end)) {
      if (trak.type !== 'trak') continue;
      const window = trackWindow(bytes, trak, fragments, limits);
      if (window) return window;
    }
  }
  return null;
}
