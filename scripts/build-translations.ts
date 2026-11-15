// Merges the Tanzil translations into the per-surah files produced by
// `build-data.ts`.
//
// Every translation is checked before it is accepted: a missing verse, an
// empty verse, a duplicate line or a verse that does not exist in the Arabic
// text all abort the build with the language and the verse named. A silently
// half-translated Quran is worse than a failed build.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lang, SurahData } from '@quran/core';

export interface TranslationSource {
  id: string;
  translator: string;
  url: string;
  file: string;
}

export const TRANSLATIONS: Record<Lang, TranslationSource> = {
  fr: {
    id: 'fr.hamidullah',
    translator: 'Muhammad Hamidullah',
    url: 'https://tanzil.net/trans/fr.hamidullah',
    file: 'trans-fr-hamidullah.txt',
  },
  en: {
    id: 'en.sahih',
    translator: 'Saheeh International',
    url: 'https://tanzil.net/trans/en.sahih',
    file: 'trans-en-sahih.txt',
  },
};

const VERSE_LINE = /^(\d{1,3})\|(\d{1,3})\|(.*)$/;

/** Reads a Tanzil translation file into a `"surah:verse" → text` map. */
export function parseTranslation(source: string, lang: Lang): Map<string, string> {
  const byVerse = new Map<string, string>();

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = VERSE_LINE.exec(line);
    if (!match) {
      throw new Error(
        `parseTranslation(${lang}): malformed translation line: ${line.slice(0, 60)}`,
      );
    }

    const key = `${Number(match[1])}:${Number(match[2])}`;
    const text = match[3].trim();

    if (byVerse.has(key)) {
      throw new Error(`parseTranslation(${lang}): duplicate ${key}`);
    }
    if (text === '') {
      throw new Error(`parseTranslation(${lang}): ${key} is empty`);
    }
    byVerse.set(key, text);
  }

  return byVerse;
}

/**
 * Returns the surahs with `translations.fr` and `translations.en` filled in.
 * The Arabic text is copied as is — this function never touches it.
 */
export function mergeTranslations(
  surahs: readonly SurahData[],
  translations: Record<Lang, string>,
): Record<number, SurahData> {
  const parsed = {
    fr: parseTranslation(translations.fr, 'fr'),
    en: parseTranslation(translations.en, 'en'),
  };

  const known = new Set(
    surahs.flatMap((surah) => surah.verses.map((verse) => `${surah.number}:${verse.number}`)),
  );
  for (const lang of ['fr', 'en'] as const) {
    for (const key of parsed[lang].keys()) {
      if (!known.has(key)) {
        throw new Error(
          `mergeTranslations: ${lang} has ${key}, which the Quran text does not have`,
        );
      }
    }
  }

  const merged: Record<number, SurahData> = {};
  for (const surah of surahs) {
    merged[surah.number] = {
      ...surah,
      verses: surah.verses.map((verse) => {
        const key = `${surah.number}:${verse.number}`;
        const fr = parsed.fr.get(key);
        const en = parsed.en.get(key);
        if (fr === undefined) throw new Error(`mergeTranslations: fr is missing ${key}`);
        if (en === undefined) throw new Error(`mergeTranslations: en is missing ${key}`);
        return { ...verse, translations: { fr, en } };
      }),
    };
  }
  return merged;
}

export const TRANSLATIONS_ATTRIBUTION = `# Traductions

Les traductions proviennent de la page de téléchargement de Tanzil
(<https://tanzil.net/trans/>). Elles sont copiées telles quelles, verset par
verset, et ne sont jamais modifiées.

| Langue | Traduction | Fichier source | URL |
|---|---|---|---|
| Français | Muhammad Hamidullah | \`${TRANSLATIONS.fr.file}\` | <${TRANSLATIONS.fr.url}> |
| Anglais | Saheeh International | \`${TRANSLATIONS.en.file}\` | <${TRANSLATIONS.en.url}> |

## Licence

Conditions d'utilisation de Tanzil pour les traductions, citées depuis
<https://tanzil.net/trans/> :

> The translations provided at this page are for non-commercial purposes only.
> If used otherwise, you need to obtain necessary permission from the
> translator or the publisher.

Quran Studio est distribué **gratuitement**, sans publicité, sans compte et
sans vente : l'usage est donc non commercial, ce qui couvre la v1. Toute
monétisation ultérieure (achat, abonnement, publicité) exige l'autorisation
écrite du traducteur ou de l'éditeur pour chaque traduction utilisée.

Les traductions sont récupérées une seule fois dans \`data/source/\` par
\`npm run build:data\`, qui ne remplace jamais un fichier existant.
`;

/** Writes `TRANSLATIONS.md` next to the downloaded sources, once. */
export async function writeTranslationsAttribution(sourceDir: string): Promise<void> {
  const path = join(sourceDir, 'TRANSLATIONS.md');
  if (!existsSync(path)) {
    await writeFile(path, TRANSLATIONS_ATTRIBUTION, 'utf8');
  }
}

/** Reads one downloaded translation file. */
export async function readTranslationFile(sourceDir: string, lang: Lang): Promise<string> {
  return readFile(join(sourceDir, TRANSLATIONS[lang].file), 'utf8');
}
