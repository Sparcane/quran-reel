import type { SurahMeta } from '@quran/core';

/** Arabic diacritics, Quranic annotations and tatweel. */
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08E1\u0640]/g;

/**
 * Lowercases, drops diacritics and punctuation, and collapses doubled letters,
 * so "Yâ-Sîn", "yasin" and "yassin" all become "yasin". Users type what they
 * hear; the search should not punish them for a hyphen.
 */
export function normalizeLatin(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/([a-z])\1+/g, '$1');
}

/** True when the collapsed query is long enough to be trusted as a variant. */
function matchesLatin(haystack: string, query: string): boolean {
  const direct = query
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  if (direct === '') return false;
  if (haystack.includes(direct)) return true;

  // "yassin" against "yasin": collapse the doubled letters too, but not for a
  // one-letter residue, or "zzz" would match every name containing a z.
  const collapsed = direct.replace(/([a-z])\1+/g, '$1');
  return collapsed.length >= 3 && haystack.includes(collapsed);
}

/** Drops the marks and unifies the letter shapes Arabic typing rarely respects. */
export function normalizeArabic(value: string): string {
  return value
    .replace(ARABIC_MARKS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, '');
}

/**
 * Filters the library on the french name, the english name, the arabic name or
 * the surah number. An empty query returns everything.
 */
export function filterSurahs(index: readonly SurahMeta[], query: string): SurahMeta[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...index];

  if (/^\d+$/.test(trimmed)) {
    return index.filter((surah) => String(surah.number).startsWith(trimmed));
  }

  const latinNeedle = trimmed;
  const arabicNeedle = normalizeArabic(trimmed);

  return index.filter((surah) => {
    const haystack = `${normalizeLatin(surah.nameFr)} ${normalizeLatin(surah.nameEn)}`;
    if (matchesLatin(haystack, latinNeedle)) return true;
    if (arabicNeedle !== '' && normalizeArabic(surah.nameAr).includes(arabicNeedle)) return true;
    return false;
  });
}
