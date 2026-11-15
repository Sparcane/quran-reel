export type SurahId = number;
export type Lang = 'fr' | 'en';

export interface SurahMeta {
  number: SurahId;
  nameAr: string;
  nameFr: string;
  nameEn: string;
  verseCount: number;
  revelation: 'meccan' | 'medinan';
}

export interface Verse {
  number: number;
  arabic: string;
  translations: Record<Lang, string>;
}

export interface SurahData extends SurahMeta {
  verses: Verse[];
}

export interface Reciter {
  id: string;
  name: Record<'fr' | 'en' | 'ar', string>;
  folder: string;
  bitrate: number;
}

export interface VerseRef {
  surah: SurahId;
  verse: number;
}

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5';
