import type { AspectRatio, BackgroundSelection, Lang } from '@quran/core';

/** Everything the studio remembers about how a video should look. */
export interface StudioSettings {
  reciterId: string;
  aspectRatio: AspectRatio;
  /** Arabic type size in pixels, at the rendered frame's scale. */
  arabicSize: number;
  translationSize: number;
  showTranslation: boolean;
  translationLang: Lang;
  textColor: string;
  /** Strength of the dark veil laid over the background, 0 to 90. */
  overlayOpacity: number;
  subtitleMode: 'verse' | 'word';
  background: BackgroundSelection;
}

/** Inclusive bounds, applied on every write: the renderer cannot use more. */
export const STUDIO_BOUNDS = {
  arabicSize: { min: 24, max: 120 },
  translationSize: { min: 16, max: 72 },
  overlayOpacity: { min: 0, max: 90 },
} as const;

const ASPECT_RATIOS: readonly AspectRatio[] = ['16:9', '9:16', '1:1', '4:5'];
const TRANSLATION_LANGS: readonly Lang[] = ['fr', 'en'];
const SUBTITLE_MODES: readonly StudioSettings['subtitleMode'][] = ['verse', 'word'];
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * The studio opens on a vertical video with Alafasy's recitation and the French
 * translation: the shape the app is used for (a reel), a reciter whose folder
 * is complete in the shipped catalogue, and a translation whose licence the
 * project checked.
 */
export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  reciterId: 'alafasy',
  aspectRatio: '9:16',
  arabicSize: 64,
  translationSize: 30,
  showTranslation: true,
  translationLang: 'fr',
  textColor: '#ffffff',
  overlayOpacity: 40,
  subtitleMode: 'verse',
  background: {
    kind: 'gradient',
    from: '#0b1026',
    to: '#1e3a5f',
    angle: 135,
    motion: true,
  },
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isGradient(value: unknown): value is BackgroundSelection {
  if (typeof value !== 'object' || value === null) return false;
  const background = value as Record<string, unknown>;
  return (
    background.kind === 'gradient' &&
    typeof background.from === 'string' &&
    COLOR_PATTERN.test(background.from) &&
    typeof background.to === 'string' &&
    COLOR_PATTERN.test(background.to) &&
    typeof background.angle === 'number' &&
    Number.isFinite(background.angle) &&
    typeof background.motion === 'boolean'
  );
}

function isLocalAsset(value: unknown, kind: 'image' | 'video'): value is BackgroundSelection {
  if (typeof value !== 'object' || value === null) return false;
  const background = value as Record<string, unknown>;
  return (
    background.kind === kind &&
    typeof background.assetId === 'string' &&
    background.assetId.length > 0 &&
    typeof background.name === 'string'
  );
}

function sanitiseBackground(value: unknown): BackgroundSelection {
  if (isGradient(value) || isLocalAsset(value, 'image') || isLocalAsset(value, 'video')) {
    return value;
  }
  return DEFAULT_STUDIO_SETTINGS.background;
}

/**
 * Turns anything — a patch from the UI, a draft written by an older build, a
 * hand-edited IndexedDB record — into settings the renderer can use. Every
 * number is bounded here rather than at the render call, so no invalid value
 * can ever be persisted.
 */
export function clampStudioSettings(settings: Partial<StudioSettings>): StudioSettings {
  const base = DEFAULT_STUDIO_SETTINGS;
  const reciterId =
    typeof settings.reciterId === 'string' && settings.reciterId.length > 0
      ? settings.reciterId
      : base.reciterId;
  const aspectRatio = ASPECT_RATIOS.includes(settings.aspectRatio as AspectRatio)
    ? (settings.aspectRatio as AspectRatio)
    : base.aspectRatio;
  const translationLang = TRANSLATION_LANGS.includes(settings.translationLang as Lang)
    ? (settings.translationLang as Lang)
    : base.translationLang;
  const subtitleMode = SUBTITLE_MODES.includes(
    settings.subtitleMode as StudioSettings['subtitleMode'],
  )
    ? (settings.subtitleMode as StudioSettings['subtitleMode'])
    : base.subtitleMode;
  const textColor =
    typeof settings.textColor === 'string' && COLOR_PATTERN.test(settings.textColor)
      ? settings.textColor
      : base.textColor;

  return {
    reciterId,
    aspectRatio,
    arabicSize: clampNumber(
      settings.arabicSize,
      STUDIO_BOUNDS.arabicSize.min,
      STUDIO_BOUNDS.arabicSize.max,
      base.arabicSize,
    ),
    translationSize: clampNumber(
      settings.translationSize,
      STUDIO_BOUNDS.translationSize.min,
      STUDIO_BOUNDS.translationSize.max,
      base.translationSize,
    ),
    showTranslation:
      typeof settings.showTranslation === 'boolean'
        ? settings.showTranslation
        : base.showTranslation,
    translationLang,
    textColor,
    overlayOpacity: clampNumber(
      settings.overlayOpacity,
      STUDIO_BOUNDS.overlayOpacity.min,
      STUDIO_BOUNDS.overlayOpacity.max,
      base.overlayOpacity,
    ),
    subtitleMode,
    background: sanitiseBackground(settings.background),
  };
}
