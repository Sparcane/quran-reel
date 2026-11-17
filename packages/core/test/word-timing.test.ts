import { describe, expect, it } from 'vitest';
import { allocateWordTimings } from '../src/word-timing';

const words = ['بِسْمِ', 'اللَّهِ', 'الرَّحْمَٰنِ'];

describe('allocateWordTimings', () => {
  it('spreads one verse over its words, in order, without gaps', () => {
    const timings = allocateWordTimings(words, 10, 3);

    expect(timings).toHaveLength(3);
    expect(timings.map((timing) => timing.word)).toEqual(words);
    expect(timings[0].start).toBe(10);
    expect(timings[2].end).toBeCloseTo(13, 5);
    expect(timings[1].start).toBe(timings[0].end);
    expect(timings[2].start).toBe(timings[1].end);
  });

  it('gives a longer word more time than a shorter one', () => {
    const timings = allocateWordTimings(words, 10, 3);
    const length = (index: number) => timings[index].end - timings[index].start;

    expect(length(1)).toBeGreaterThan(length(0));
    expect(length(2)).toBeGreaterThan(length(1));
  });

  it('returns nothing for an empty verse', () => {
    expect(allocateWordTimings([], 0, 5)).toEqual([]);
  });

  it('keeps every word on screen for at least 120 ms when the verse allows it', () => {
    const timings = allocateWordTimings(['ا', 'ب', 'ج'], 0, 1);

    for (const timing of timings) {
      expect(timing.end - timing.start).toBeGreaterThanOrEqual(0.12);
    }
    expect(timings.at(-1)?.end).toBeCloseTo(1, 5);
  });

  it('splits the verse evenly when it is too short for the 120 ms floor', () => {
    const timings = allocateWordTimings(['ا', 'ب', 'ج'], 0, 0.3);

    expect(timings.at(-1)?.end).toBeCloseTo(0.3, 5);
    for (const timing of timings) {
      expect(timing.end - timing.start).toBeCloseTo(0.1, 5);
    }
  });

  it('ignores the diacritics when weighing a word', () => {
    const bare = allocateWordTimings(['ا', 'بسم'], 0, 2);
    const vocalised = allocateWordTimings(['ا', 'بِسْمِ'], 0, 2);
    const bounds = (timings: ReturnType<typeof allocateWordTimings>) =>
      timings.map(({ start, end }) => ({ start, end }));

    expect(bounds(vocalised)).toEqual(bounds(bare));
  });

  it('still gives the minimum to a word that is only diacritics', () => {
    const timings = allocateWordTimings(['َ', 'ا', 'ا'], 0, 3);

    expect(timings[0].end - timings[0].start).toBeGreaterThanOrEqual(0.12);
    expect(timings.at(-1)?.end).toBeCloseTo(3, 5);
  });

  it('ends every word at the verse start when the verse lasts zero seconds', () => {
    const timings = allocateWordTimings(['ا', 'ب'], 4, 0);

    expect(timings).toEqual([
      { word: 'ا', start: 4, end: 4 },
      { word: 'ب', start: 4, end: 4 },
    ]);
  });

  it('refuses a duration or a start that cannot be laid out', () => {
    expect(() => allocateWordTimings(['ا'], 0, -1)).toThrow(/duration/i);
    expect(() => allocateWordTimings(['ا'], 0, Number.NaN)).toThrow(/duration/i);
    expect(() => allocateWordTimings(['ا'], Number.POSITIVE_INFINITY, 1)).toThrow(/start/i);
  });
});
