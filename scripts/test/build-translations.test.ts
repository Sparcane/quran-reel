// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mergeTranslations } from '../build-translations';
import { parseTanzil } from '../build-data';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

const tanzilText = fixture('tanzil-sample.txt');
const frText = fixture('trans-fr-sample.txt');
const enText = fixture('trans-en-sample.txt');
const { surahs } = parseTanzil(tanzilText);

function withoutLine(source: string, prefix: string): string {
  return source
    .split('\n')
    .filter((line) => !line.startsWith(prefix))
    .join('\n');
}

describe('mergeTranslations', () => {
  it('fills both translations for all 114 surahs', () => {
    const merged = mergeTranslations(surahs, { fr: frText, en: enText });

    expect(Object.keys(merged)).toHaveLength(114);
    expect(merged[1].verses[1].translations.fr).toContain('Louange');
    expect(merged[2].verses[0].translations.en).toContain('Alif');
  });

  it('leaves every Arabic verse byte-for-byte untouched', () => {
    const merged = mergeTranslations(surahs, { fr: frText, en: enText });

    for (const surah of surahs) {
      for (const [i, verse] of surah.verses.entries()) {
        expect(merged[surah.number].verses[i].arabic).toBe(verse.arabic);
        expect(merged[surah.number].verses[i].number).toBe(verse.number);
      }
    }
  });

  it('gives every verse a non-empty translation in both languages', () => {
    const merged = mergeTranslations(surahs, { fr: frText, en: enText });

    for (const surah of Object.values(merged)) {
      for (const verse of surah.verses) {
        expect(verse.translations.fr.trim()).not.toBe('');
        expect(verse.translations.en.trim()).not.toBe('');
      }
    }
  });

  it('refuses a missing translation and names the language and the verse', () => {
    expect(() => mergeTranslations(surahs, { fr: withoutLine(frText, '2|5|'), en: enText })).toThrow(
      /fr.*2:5/,
    );
  });

  it('refuses an empty translation and names the verse', () => {
    const broken = frText.replace(/^2\|5\|.*$/m, '2|5|   ');
    expect(() => mergeTranslations(surahs, { fr: broken, en: enText })).toThrow(/fr.*2:5/);
  });

  it('refuses a translation for a verse the Arabic text does not have', () => {
    expect(() =>
      mergeTranslations(surahs, { fr: `${frText}\n115|1|Hallucination`, en: enText }),
    ).toThrow(/fr.*115/);
  });

  it('refuses a duplicated verse line', () => {
    const doubled = `${frText}\n2|5|doublon`;
    expect(() => mergeTranslations(surahs, { fr: doubled, en: enText })).toThrow(/duplicate.*2:5/);
  });
});
