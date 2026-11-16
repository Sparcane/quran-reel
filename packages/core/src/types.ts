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

/** An animated two-colour gradient. `angle` is in degrees, clockwise. */
export interface GradientSelection {
  kind: 'gradient';
  from: string;
  to: string;
  angle: number;
  motion: boolean;
}

/** A picture the user imported, kept in the device's own storage. */
export interface ImageSelection {
  kind: 'image';
  assetId: string;
  name: string;
}

/** A local MP4/H.264 the user imported, kept in the device's own storage. */
export interface VideoSelection {
  kind: 'video';
  assetId: string;
  name: string;
}

/**
 * What is painted behind the text. Only gradients ship with the app; images
 * and videos come from the user's device, so the app never needs the network
 * to render.
 */
export type BackgroundSelection = GradientSelection | ImageSelection | VideoSelection;

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5';
