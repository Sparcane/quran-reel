import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { audioUrl } from '../src/audio-url';
import type { Reciter } from '../src/types';

const reciters: Reciter[] = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../apps/web/public/data/reciters.json', import.meta.url)),
    'utf8',
  ),
);

describe('reciters.json', () => {
  it('lists at least eight reciters', () => {
    expect(reciters.length).toBeGreaterThanOrEqual(8);
  });

  it('has unique ids and EveryAyah folder names', () => {
    expect(new Set(reciters.map((reciter) => reciter.id)).size).toBe(reciters.length);
    for (const reciter of reciters) {
      expect(reciter.folder).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(reciter.bitrate).toBeGreaterThan(0);
    }
  });

  it('names every reciter in french, english and arabic', () => {
    for (const reciter of reciters) {
      for (const lang of ['fr', 'en', 'ar'] as const) {
        expect(reciter.name[lang].trim()).not.toBe('');
      }
    }
  });

  it('produces an EveryAyah url for every reciter and every edge verse', () => {
    for (const reciter of reciters) {
      for (const ref of [
        { surah: 1, verse: 1 },
        { surah: 2, verse: 282 },
        { surah: 114, verse: 6 },
      ]) {
        expect(audioUrl(reciter, ref)).toMatch(
          /^https:\/\/everyayah\.com\/data\/[A-Za-z0-9_-]+\/\d{6}\.mp3$/,
        );
      }
    }
  });
});
