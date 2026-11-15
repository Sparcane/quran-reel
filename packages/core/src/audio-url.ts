import { pad3 } from './format';
import type { Reciter, VerseRef } from './types';

/** EveryAyah serves one MP3 per verse: `{folder}/SSSVRR.mp3`. */
export const AUDIO_BASE_URL = 'https://everyayah.com/data';

export function audioUrl(reciter: Reciter, ref: VerseRef): string {
  if (!Number.isInteger(ref.surah) || ref.surah < 1 || ref.surah > 114) {
    throw new Error(`audioUrl: surah must be an integer between 1 and 114, got ${ref.surah}`);
  }
  if (!Number.isInteger(ref.verse) || ref.verse < 1) {
    throw new Error(`audioUrl: verse must be a positive integer, got ${ref.verse}`);
  }
  return `${AUDIO_BASE_URL}/${reciter.folder}/${pad3(ref.surah)}${pad3(ref.verse)}.mp3`;
}
