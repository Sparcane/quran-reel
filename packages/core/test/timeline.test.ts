import { describe, expect, it } from 'vitest';
import { buildTimeline, entryAt, exceedsLimit } from '../src/timeline';

describe('buildTimeline', () => {
  it('lays the clips out after the lead-in, with a gap between them', () => {
    const timeline = buildTimeline([2, 3]);

    expect(timeline.entries).toEqual([
      { clipIndex: 0, start: 0.8, end: 2.8 },
      { clipIndex: 1, start: 3.1, end: 6.1 },
    ]);
    expect(timeline.totalSec).toBeCloseTo(6.1, 3);
  });

  it('returns no entries and no time when there is nothing to play', () => {
    expect(buildTimeline([])).toEqual({ entries: [], totalSec: 0 });
  });

  it('takes a custom lead-in and gap', () => {
    expect(buildTimeline([1], { leadInMs: 0, gapMs: 0 })).toEqual({
      entries: [{ clipIndex: 0, start: 0, end: 1 }],
      totalSec: 1,
    });
    expect(buildTimeline([1, 1], { leadInMs: 1000, gapMs: 500 }).entries[1]).toEqual({
      clipIndex: 1,
      start: 2.5,
      end: 3.5,
    });
  });

  it('does not accumulate floating-point error across clips', () => {
    const timeline = buildTimeline(new Array(10).fill(0.1), { leadInMs: 0, gapMs: 0 });

    // Ten times 0.1 s is 1 s, not 0.9999999999999999.
    expect(timeline.totalSec).toBe(1);
    expect(timeline.entries.at(-1)?.end).toBe(1);
  });

  it('refuses a duration that is negative or not a number, and says which clip', () => {
    expect(() => buildTimeline([2, -1])).toThrow(/index 1/);
    expect(() => buildTimeline([Number.NaN])).toThrow(/index 0/);
    expect(() => buildTimeline([Number.POSITIVE_INFINITY])).toThrow(/index 0/);
  });

  it('refuses a negative lead-in or gap', () => {
    expect(() => buildTimeline([1], { leadInMs: -1 })).toThrow(/leadInMs/);
    expect(() => buildTimeline([1], { gapMs: -1 })).toThrow(/gapMs/);
  });
});

describe('entryAt', () => {
  const timeline = buildTimeline([2, 3]);

  it('returns nothing during the opening silence or after the last clip', () => {
    expect(entryAt(timeline, 0.2)).toBeNull();
    expect(entryAt(timeline, 99)).toBeNull();
    expect(entryAt(timeline, Number.NaN)).toBeNull();
  });

  it('finds the clip that covers an instant', () => {
    expect(entryAt(timeline, 0.8)).toEqual({ clipIndex: 0, start: 0.8, end: 2.8 });
    expect(entryAt(timeline, 1)).toEqual({ clipIndex: 0, start: 0.8, end: 2.8 });
    expect(entryAt(timeline, 4)).toEqual({ clipIndex: 1, start: 3.1, end: 6.1 });
  });

  it('treats the end of a clip as a gap, not as the clip still playing', () => {
    expect(entryAt(timeline, 2.8)).toBeNull();
    expect(entryAt(timeline, 3.1)).toEqual({ clipIndex: 1, start: 3.1, end: 6.1 });
  });
});

describe('exceedsLimit', () => {
  it('flags a list whose audio plus silences would pass fifteen minutes', () => {
    // 700 s of audio + 0.8 s lead-in + 699 gaps × 0.3 s = 910.5 s.
    expect(exceedsLimit(new Array(700).fill(1))).toBe(true);
  });

  it('lets a ten-minute recitation through', () => {
    // 600 s of audio + 0.8 s + 599 × 0.3 s = 780.5 s, under the limit. The
    // plan's example expected `true` here, but its own arithmetic says 780.5 s.
    expect(exceedsLimit(new Array(600).fill(1))).toBe(false);
    expect(exceedsLimit([2, 3])).toBe(false);
  });

  it('compares against a custom limit, and only refuses what is past it', () => {
    // One second of audio plus the 0.8 s lead-in is 1.8 s.
    expect(exceedsLimit([1], 1.8)).toBe(false);
    expect(exceedsLimit([1], 1.79)).toBe(true);
  });
});
