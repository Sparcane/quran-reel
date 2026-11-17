/**
 * Where every verse sits in the finished video.
 *
 * The renderer draws one clip per verse; the timeline says at which second each
 * clip starts and ends. It is built once, before rendering, and every consumer
 * (canvas, encoder, progress bar) reads the same numbers, so the picture and the
 * sound cannot drift apart.
 */

export interface TimelineEntry {
  clipIndex: number;
  start: number;
  end: number;
}

export interface Timeline {
  entries: TimelineEntry[];
  totalSec: number;
}

/** A breath of silence before the first verse, so a video does not start mid-word. */
export const DEFAULT_LEAD_IN_MS = 800;
/** A short beat between verses, long enough to hear one verse end before the next begins. */
export const DEFAULT_GAP_MS = 300;
/** Fifteen minutes: the ceiling the product promises to refuse above. */
export const MAX_VIDEO_SECONDS = 900;

export interface TimelineOptions {
  leadInMs?: number;
  gapMs?: number;
}

function requireMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`timeline: ${name} must be a finite, non-negative number`);
  }
  return Math.round(value);
}

/**
 * Durations arrive as floating seconds from the audio decoder. Left as floats,
 * twenty verses would accumulate an error the encoder can notice. Every bound
 * is therefore computed from a whole-millisecond cursor and divided once.
 */
function toMs(seconds: number, index: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `timeline: duration at index ${index} must be a finite, non-negative number`,
    );
  }
  return Math.round(seconds * 1000);
}

function resolveOptions(options?: TimelineOptions): { leadIn: number; gap: number } {
  return {
    leadIn: requireMs(options?.leadInMs ?? DEFAULT_LEAD_IN_MS, 'leadInMs'),
    gap: requireMs(options?.gapMs ?? DEFAULT_GAP_MS, 'gapMs'),
  };
}

export function buildTimeline(durationsSec: number[], options?: TimelineOptions): Timeline {
  const { leadIn, gap } = resolveOptions(options);

  // No clips means no video and no silence either: a lead-in with nothing after
  // it would make an empty project look longer than zero seconds.
  if (durationsSec.length === 0) return { entries: [], totalSec: 0 };

  const entries: TimelineEntry[] = [];
  let cursor = leadIn;

  for (let index = 0; index < durationsSec.length; index += 1) {
    if (index > 0) cursor += gap;
    const duration = toMs(durationsSec[index], index);
    entries.push({
      clipIndex: index,
      start: cursor / 1000,
      end: (cursor + duration) / 1000,
    });
    cursor += duration;
  }

  return { entries, totalSec: cursor / 1000 };
}

/**
 * The clip playing at `t`, or null in the opening silence, between two clips,
 * and after the end. `t` is end-exclusive: at the exact end of a clip the gap
 * has begun.
 */
export function entryAt(timeline: Timeline, t: number): TimelineEntry | null {
  if (!Number.isFinite(t)) return null;

  // Entries are sorted and do not overlap, so a binary search is exact and
  // stays cheap on a 900-second project.
  let low = 0;
  let high = timeline.entries.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = timeline.entries[middle];
    if (t < entry.start) {
      high = middle - 1;
    } else if (t >= entry.end) {
      low = middle + 1;
    } else {
      return entry;
    }
  }

  return null;
}

/**
 * Whether a list of clips, rendered with the default lead-in and gaps, would be
 * longer than the limit. The check happens before the render starts: finding
 * out at minute fifteen wastes the user's battery, not just their time.
 */
export function exceedsLimit(
  durationsSec: number[],
  limitSec: number = MAX_VIDEO_SECONDS,
): boolean {
  if (!Number.isFinite(limitSec) || limitSec < 0) {
    throw new Error('timeline: limitSec must be a finite, non-negative number');
  }
  return buildTimeline(durationsSec).totalSec > limitSec;
}
