import { describe, expect, it } from 'vitest';
import { audioUrl } from '../src/audio-url';
import type { Reciter } from '../src/types';

const maher: Reciter = {
  id: 'maher',
  folder: 'MaherAlMuaiqly128kbps',
  bitrate: 128,
  name: { fr: 'Maher Al Muaiqly', en: 'Maher Al Muaiqly', ar: 'ماهر المعيقلي' },
};

describe('audioUrl', () => {
  it('builds the EveryAyah url for a verse', () => {
    expect(audioUrl(maher, { surah: 36, verse: 1 })).toBe(
      'https://everyayah.com/data/MaherAlMuaiqly128kbps/036001.mp3',
    );
  });

  it('pads the longest surah and the longest verse', () => {
    expect(audioUrl(maher, { surah: 2, verse: 282 })).toBe(
      'https://everyayah.com/data/MaherAlMuaiqly128kbps/002282.mp3',
    );
    expect(audioUrl(maher, { surah: 114, verse: 6 })).toBe(
      'https://everyayah.com/data/MaherAlMuaiqly128kbps/114006.mp3',
    );
  });

  it('refuses a surah number outside 1..114', () => {
    expect(() => audioUrl(maher, { surah: 0, verse: 1 })).toThrow(/surah/i);
    expect(() => audioUrl(maher, { surah: 115, verse: 1 })).toThrow(/surah/i);
  });

  it('refuses a verse number below one', () => {
    expect(() => audioUrl(maher, { surah: 1, verse: 0 })).toThrow(/verse/i);
  });
});
