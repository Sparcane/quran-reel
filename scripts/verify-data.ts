// Checks the generated data before it ships: 114 surahs, 6236 verses, no empty
// text, no missing translation, and EveryAyah still serves the reciters we
// list. Exits non-zero on the first problem — a build that fails here must not
// be published.
//
// Run: `npm run verify:data`
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioUrl, pad3 } from '@quran/core';
import type { Reciter, SurahData, SurahMeta, VerseRef } from '@quran/core';

export const TOTAL_SURAHS = 114;
export const TOTAL_VERSES = 6236;

/** One verse per third of the Quran: first, middle, last. */
export const SAMPLE_REFS: readonly VerseRef[] = [
  { surah: 1, verse: 1 },
  { surah: 36, verse: 1 },
  { surah: 114, verse: 6 },
];

export function verifyIndex(index: readonly SurahMeta[]): void {
  if (index.length !== TOTAL_SURAHS) {
    throw new Error(`verify-data: expected ${TOTAL_SURAHS} surahs, found ${index.length}`);
  }

  let total = 0;
  for (const [i, surah] of index.entries()) {
    if (surah.number !== i + 1) {
      throw new Error(
        `verify-data: surah ${surah.number} is out of order at position ${i + 1}`,
      );
    }
    if (!Number.isInteger(surah.verseCount) || surah.verseCount < 1) {
      throw new Error(`verify-data: surah ${surah.number} has an invalid verse count`);
    }
    if (surah.nameAr.trim() === '' || surah.nameFr.trim() === '' || surah.nameEn.trim() === '') {
      throw new Error(`verify-data: surah ${surah.number} is missing a name`);
    }
    total += surah.verseCount;
  }

  if (total !== TOTAL_VERSES) {
    throw new Error(`verify-data: verse count total is ${total}, expected ${TOTAL_VERSES}`);
  }
}

export function verifySurah(surah: SurahData): void {
  if (surah.verses.length === 0) {
    throw new Error(`verify-data: surah ${surah.number} has an empty verse list`);
  }
  if (surah.verses.length !== surah.verseCount) {
    throw new Error(
      `verify-data: surah ${surah.number} verse count is ${surah.verses.length}, metadata says ${surah.verseCount}`,
    );
  }

  for (const [i, verse] of surah.verses.entries()) {
    if (verse.number !== i + 1) {
      throw new Error(
        `verify-data: expected ${surah.number}:${i + 1} at position ${i + 1}, found verse ${verse.number}`,
      );
    }
    const at = `${surah.number}:${verse.number}`;
    if (verse.arabic.trim() === '') {
      throw new Error(`verify-data: empty Arabic text at ${at}`);
    }
    if (verse.translations.fr.trim() === '') {
      throw new Error(`verify-data: empty fr translation at ${at}`);
    }
    if (verse.translations.en.trim() === '') {
      throw new Error(`verify-data: empty en translation at ${at}`);
    }
  }
}

/** HEADs one verse per sample and refuses anything but a 200 audio/mpeg. */
export async function verifyReciterAudio(
  reciters: readonly Reciter[],
  refs: readonly VerseRef[] = SAMPLE_REFS,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const reciter of reciters) {
    for (const ref of refs) {
      const url = audioUrl(reciter, ref);
      const response = await fetchImpl(url, { method: 'HEAD' });
      const file = `${pad3(ref.surah)}${pad3(ref.verse)}.mp3`;

      if (response.status !== 200) {
        throw new Error(
          `verify-data: ${reciter.id} is missing ${file} (HTTP ${response.status}) — ${url}`,
        );
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('audio/mpeg')) {
        throw new Error(
          `verify-data: ${reciter.id} answered with content-type "${contentType}" for ${file}, expected audio/mpeg`,
        );
      }
    }
  }
}

const root = fileURLToPath(new URL('..', import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const dataDir = join(root, 'apps', 'web', 'public', 'data');
  try {
    const index = await readJson<SurahMeta[]>(join(dataDir, 'surahs-index.json'));
    verifyIndex(index);

    let verses = 0;
    for (const surah of index) {
      const data = await readJson<SurahData>(join(dataDir, 'surahs', `${pad3(surah.number)}.json`));
      verifySurah(data);
      verses += data.verses.length;
    }

    const reciters = await readJson<Reciter[]>(join(dataDir, 'reciters.json'));
    await verifyReciterAudio(reciters);

    console.log(
      `verified ${index.length} surahs, ${verses} verses, ${reciters.length} reciters × ${SAMPLE_REFS.length} audio files`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
