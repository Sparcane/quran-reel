import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pad3, SURAH_META } from '@quran/core';
import type { SurahData } from '@quran/core';

/**
 * Locates `public/data`. `next build` runs with `apps/web` as its working
 * directory; the test runner starts at the repository root. Both are checked
 * rather than guessing from `import.meta.url`, which the bundler rewrites.
 */
function dataDir(): string {
  const candidates = [
    join(process.cwd(), 'public', 'data'),
    join(process.cwd(), 'apps', 'web', 'public', 'data'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'surahs-index.json'))) return candidate;
  }
  throw new Error('surah-data: cannot find public/data — run `npm run build:data`');
}

/** Reads one surah from the generated data, by number. */
export function readSurah(id: number): SurahData {
  if (!Number.isInteger(id) || id < 1 || id > 114) {
    throw new Error(`readSurah: surah ${id} does not exist (1 to 114)`);
  }
  const dir = dataDir();
  return JSON.parse(
    readFileSync(join(dir, 'surahs', `${pad3(id)}.json`), 'utf8'),
  ) as SurahData;
}

/** The 114 surah numbers, for `generateStaticParams`. */
export function surahParams(): { id: string }[] {
  return SURAH_META.map((surah) => ({ id: String(surah.number) }));
}
