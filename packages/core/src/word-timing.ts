/**
 * Word-by-word subtitles need to know when each word is being recited. EveryAyah
 * only ships one MP3 per verse, with no word timings inside it, so the time is
 * estimated by sharing the verse's duration between its words by length. The
 * studio labels this mode "estimated" for exactly that reason.
 */

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

/** Arabic diacritics carry no spoken weight of their own. */
const DIACRITICS = /[\u064B-\u065F\u0670]/g;

/** Below this, a word is on screen too briefly to read, let alone hear. */
const MIN_WORD_MS = 120;

function weigh(word: string): number {
  const letters = word.replace(DIACRITICS, '').length;
  // A word written only with diacritics still needs its slice of time.
  return Math.max(1, letters);
}

/**
 * Splits `durationSec` between the words, in whole milliseconds so consecutive
 * words share the same bound instead of drifting apart by float error.
 */
function shareMs(words: string[], totalMs: number): number[] {
  const count = words.length;

  // A verse shorter than 120 ms per word cannot honour the floor. Splitting the
  // time evenly is the only answer that still ends exactly on the verse's end.
  if (totalMs < MIN_WORD_MS * count) {
    const each = Math.floor(totalMs / count);
    const durations = new Array<number>(count).fill(each);
    durations[count - 1] += totalMs - each * count;
    return durations;
  }

  const weights = words.map(weigh);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const spareMs = totalMs - MIN_WORD_MS * count;
  const durations = weights.map(
    (weight) => MIN_WORD_MS + Math.floor((spareMs * weight) / weightSum),
  );

  // The last word absorbs the rounding error, so the verse ends exactly where
  // its audio does instead of a millisecond short.
  durations[count - 1] += totalMs - durations.reduce((sum, duration) => sum + duration, 0);
  return durations;
}

export function allocateWordTimings(
  words: string[],
  start: number,
  durationSec: number,
): WordTiming[] {
  if (!Number.isFinite(start)) {
    throw new Error('word-timing: start must be a finite number of seconds');
  }
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    throw new Error('word-timing: duration must be a finite, non-negative number of seconds');
  }
  if (words.length === 0) return [];

  const startMs = Math.round(start * 1000);
  const totalMs = Math.round(durationSec * 1000);
  const durations = shareMs(words, totalMs);

  let cursor = startMs;
  return words.map((word, index) => {
    const timing: WordTiming = {
      word,
      start: cursor / 1000,
      end: (cursor + durations[index]) / 1000,
    };
    cursor += durations[index];
    return timing;
  });
}
