import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SURAH_META } from '@quran/core';
import type { Reciter, SurahData, SurahMeta } from '@quran/core';
import { verifyIndex, verifyReciterAudio, verifySurah } from '../verify-data';

const surah2: SurahData = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../apps/web/public/data/surahs/002.json', import.meta.url),
    ),
    'utf8',
  ),
);

const maher: Reciter = {
  id: 'maher',
  folder: 'MaherAlMuaiqly128kbps',
  bitrate: 128,
  name: { fr: 'Maher', en: 'Maher', ar: 'ماهر' },
};

describe('verifyIndex', () => {
  it('accepts the real index', () => {
    expect(() => verifyIndex(SURAH_META)).not.toThrow();
  });

  it('refuses an index whose verse count disagrees with the Quran', () => {
    const broken = SURAH_META.map((surah) =>
      surah.number === 2 ? { ...surah, verseCount: 285 } : surah,
    );
    expect(() => verifyIndex(broken)).toThrow(/verse count/i);
  });

  it('refuses an index that is missing a surah', () => {
    expect(() => verifyIndex(SURAH_META.slice(0, 113))).toThrow(/114/);
  });

  it('refuses an index whose surahs are out of order', () => {
    const swapped = [...SURAH_META];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    expect(() => verifyIndex(swapped)).toThrow(/order/i);
  });
});

describe('verifySurah', () => {
  it('accepts a real surah', () => {
    expect(() => verifySurah(surah2)).not.toThrow();
  });

  it('refuses a surah with no verses', () => {
    expect(() => verifySurah({ ...surah2, verses: [] })).toThrow(/empty/i);
  });

  it('refuses a verse with an empty Arabic text', () => {
    const verses = surah2.verses.map((verse, i) => (i === 4 ? { ...verse, arabic: '  ' } : verse));
    expect(() => verifySurah({ ...surah2, verses })).toThrow(/empty.*2:5/i);
  });

  it('refuses a verse with an empty translation', () => {
    const verses = surah2.verses.map((verse, i) =>
      i === 4 ? { ...verse, translations: { fr: '', en: verse.translations.en } } : verse,
    );
    expect(() => verifySurah({ ...surah2, verses })).toThrow(/translation.*2:5/i);
  });

  it('refuses a verse count that disagrees with the metadata', () => {
    expect(() => verifySurah({ ...surah2, verses: surah2.verses.slice(0, 10) })).toThrow(
      /verse count/i,
    );
  });

  it('refuses verses that are not numbered from one', () => {
    const verses = surah2.verses.map((verse, i) => (i === 1 ? { ...verse, number: 99 } : verse));
    expect(() => verifySurah({ ...surah2, verses })).toThrow(/2:2/);
  });
});

describe('verifyReciterAudio', () => {
  const ok = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      void input;
      return new Response(null, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  );

  it('accepts a reciter whose sample verses answer 200 with audio/mpeg', async () => {
    await expect(verifyReciterAudio([maher], undefined, ok)).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(3);
    expect(ok.mock.calls[0][0]).toBe(
      'https://everyayah.com/data/MaherAlMuaiqly128kbps/001001.mp3',
    );
  });

  it('names the reciter and the verse when a file is missing', async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(verifyReciterAudio([maher], undefined, missing)).rejects.toThrow(
      /maher.*001001.*404/i,
    );
  });

  it('refuses a response that is not an mp3', async () => {
    const html = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    await expect(verifyReciterAudio([maher], undefined, html)).rejects.toThrow(/content-type/i);
  });
});
