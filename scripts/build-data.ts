// Builds the static Quran data files the web app ships with.
//
// Source: Tanzil Quran text (Uthmani) and Tanzil metadata, both downloaded once
// into `data/source/` and never overwritten. The text is copied verbatim; this
// script only splits it per surah and fills the translation slots (which
// `build-translations.ts` completes).
//
// Run: `npm run build:data`
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pad3, SURAH_META } from '@quran/core';
import type { SurahData, SurahMeta, Verse } from '@quran/core';

export interface ParsedQuran {
  index: SurahMeta[];
  surahs: SurahData[];
}

export const TANZIL_TEXT_URL =
  'https://tanzil.net/pub/download/index.php?quranType=uthmani&outType=txt-2&agree=true';
export const TANZIL_META_URL = 'https://tanzil.net/res/text/metadata/quran-data.xml';

const VERSE_LINE = /^(\d{1,3})\|(\d{1,3})\|(.*)$/;

/**
 * Splits a Tanzil `surah|verse|text` file into per-surah data.
 *
 * The text itself is kept verbatim (surrounding whitespace only is trimmed).
 * Every structural surprise throws with the verse it concerns: a malformed
 * line, an unknown surah, a gap in the verse numbering, an empty text, or a
 * verse count that disagrees with the Tanzil metadata. Those are the failures
 * that would otherwise ship a Quran missing a verse.
 */
export function parseTanzil(
  source: string,
  meta: readonly SurahMeta[] = SURAH_META,
): ParsedQuran {
  const byNumber = new Map(meta.map((surah) => [surah.number, surah]));
  const collected = new Map<number, Verse[]>();

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = VERSE_LINE.exec(line);
    if (!match) {
      throw new Error(`parseTanzil: malformed verse line: ${line.slice(0, 60)}`);
    }

    const surahNumber = Number(match[1]);
    const verseNumber = Number(match[2]);
    const arabic = match[3].trim();

    if (!byNumber.has(surahNumber)) {
      throw new Error(`parseTanzil: verse ${surahNumber}:${verseNumber} is in an unknown surah`);
    }
    if (arabic === '') {
      throw new Error(`parseTanzil: ${surahNumber}:${verseNumber} has an empty text`);
    }

    const verses = collected.get(surahNumber) ?? [];
    const expected = verses.length + 1;
    if (verseNumber !== expected) {
      throw new Error(
        `parseTanzil: ${surahNumber}:${expected} is missing or out of order (found ${surahNumber}:${verseNumber})`,
      );
    }
    verses.push({ number: verseNumber, arabic, translations: { fr: '', en: '' } });
    collected.set(surahNumber, verses);
  }

  const surahs: SurahData[] = meta.map((surah) => {
    const verses = collected.get(surah.number) ?? [];
    if (verses.length !== surah.verseCount) {
      throw new Error(
        `parseTanzil: surah ${surah.number} should have ${surah.verseCount} verses, found ${verses.length}`,
      );
    }
    return { ...surah, verses };
  });

  return { index: [...meta], surahs };
}

/** Writes `surahs-index.json` and one `surahs/{001..114}.json` per surah. */
export async function writeSurahs(quran: ParsedQuran, outDir: string): Promise<void> {
  await mkdir(join(outDir, 'surahs'), { recursive: true });
  await writeFile(join(outDir, 'surahs-index.json'), JSON.stringify(quran.index), 'utf8');
  for (const surah of quran.surahs) {
    await writeFile(
      join(outDir, 'surahs', `${pad3(surah.number)}.json`),
      JSON.stringify(surah),
      'utf8',
    );
  }
}

const ATTRIBUTION = `# Sources des données

## Texte coranique — Tanzil

Le texte arabe est le **Tanzil Quran Text (Uthmani, version 1.1)**, copié sans
aucune modification de caractère.

- Source : <https://tanzil.net/download/>
- Métadonnées (noms, nombre de versets, lieu de révélation) :
  <https://tanzil.net/res/text/metadata/quran-data.xml>
- Licence : Creative Commons Attribution 3.0 — <https://tanzil.net/docs/tanzil_license>
- Récupéré le 2026-11-15 par \`npm run build:data\`.

Le bloc de copyright présent dans le fichier source est conservé tel quel.
L'attribution est affichée dans l'application (page « À propos ») avec un lien
vers tanzil.net, comme la licence l'exige.

\`data/source/quran-uthmani.txt\` n'est pas versionné (1,4 Mo, retéléchargé au
besoin) ; \`quran-data.xml\` l'est, et \`packages/core/src/surah-meta.ts\` est généré
depuis lui par \`npm run generate:catalog\`.
`;

async function ensureSource(file: string, url: string): Promise<string> {
  const path = join(sourceDir, file);
  if (!existsSync(path)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`download failed: ${url} → HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
    console.log(`downloaded ${file} (${bytes.length} bytes)`);
  }
  return readFile(path, 'utf8');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'data', 'source');

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  await mkdir(sourceDir, { recursive: true });
  const text = await ensureSource('quran-uthmani.txt', TANZIL_TEXT_URL);
  await ensureSource('quran-data.xml', TANZIL_META_URL);

  const attributionPath = join(sourceDir, 'ATTRIBUTION.md');
  if (!existsSync(attributionPath)) {
    await writeFile(attributionPath, ATTRIBUTION, 'utf8');
  }

  const quran = parseTanzil(text);
  const outDir = join(root, 'apps', 'web', 'public', 'data');
  await writeSurahs(quran, outDir);

  const verses = quran.surahs.reduce((total, surah) => total + surah.verses.length, 0);
  console.log(`wrote ${quran.index.length} surahs, ${verses} verses → ${dirname(`${outDir}/x`)}`);
}
