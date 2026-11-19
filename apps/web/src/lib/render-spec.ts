/**
 * Turns the studio's draft into the render contract.
 *
 * This is the one place where a selection of verse references becomes playable
 * audio and text: the reader only ever stores `{ surah, verse }` pairs, and the
 * renderer only ever sees `VerseClip`s with decoded sound. Keeping the fetch and
 * decode behind an injectable seam makes the whole conversion testable without
 * a network or a codec.
 */

import {
  allocateWordTimings,
  audioUrl,
  buildTimeline,
  dimensionsFor,
  exceedsLimit,
  MAX_VIDEO_SECONDS,
  pad3,
} from '@quran/core';
import type { BackgroundSelection, SurahData, Timeline, VerseRef } from '@quran/core';
import {
  createGradientPainter,
  createImagePainter,
  createVideoPainter,
  type BackgroundPainter,
  type PlanarAudio,
  type RenderSpec,
  type SubtitleStyle,
  type Size,
  type VerseClip,
} from '@quran/render';
import { reciterById } from '@/lib/reciters';
import { loadBackgroundAsset } from '@/lib/storage';
import type { StudioSettings } from '@/lib/studio-settings';
import { videoBackgroundEnvironment } from '@/lib/video-environment';

export interface RenderSpecDeps {
  loadSurah(surah: number): Promise<SurahData>;
  /** Given an EveryAyah URL, return the decoded samples for that verse. */
  loadAudio(url: string): Promise<PlanarAudio>;
  loadBackground(assetId: string): Promise<{ blob: Blob } | null>;
  createBitmap(blob: Blob): Promise<ImageBitmap>;
  /** Decodes an imported MP4/H.264 into a painter for the render thread. */
  createVideo(blob: Blob, size: Size, durationSec: number): Promise<BackgroundPainter>;
}

/** The device-backed implementation: local text, EveryAyah audio, Web Audio. */
export function browserRenderSpecDeps(): RenderSpecDeps {
  const Context = globalThis.AudioContext;
  const context = Context ? new Context() : null;

  return {
    async loadSurah(surah) {
      const response = await fetch(`/data/surahs/${pad3(surah)}.json`);
      if (!response.ok) {
        throw new Error(`render: la sourate ${surah} est introuvable (${response.status})`);
      }
      return (await response.json()) as SurahData;
    },
    async loadAudio(url) {
      if (!context) throw new Error('render: ce navigateur ne peut pas décoder l’audio');
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`render: la récitation est introuvable (${response.status})`);
      }
      return (await context.decodeAudioData(await response.arrayBuffer())) as PlanarAudio;
    },
    async loadBackground(assetId) {
      return loadBackgroundAsset(assetId);
    },
    async createBitmap(blob) {
      return createImageBitmap(blob);
    },
    async createVideo(blob, size, durationSec) {
      return createVideoPainter(blob, size, durationSec, videoBackgroundEnvironment());
    },
  };
}

async function createBackground(
  selection: BackgroundSelection,
  size: Size,
  deps: RenderSpecDeps,
  durationSec: number,
): Promise<BackgroundPainter> {
  if (selection.kind === 'gradient') return createGradientPainter(selection, size);
  if (selection.kind === 'image') {
    const asset = await deps.loadBackground(selection.assetId);
    if (!asset) throw new Error('render: le fond importé n’est plus sur cet appareil');
    return createImagePainter(await deps.createBitmap(asset.blob), size);
  }
  // The worker only rebuilds gradients, so an imported background keeps the
  // render on the main thread where its real painter (and asset bytes) live.
  const asset = await deps.loadBackground(selection.assetId);
  if (!asset) throw new Error('render: le fond vidéo importé n’est plus sur cet appareil');
  return deps.createVideo(asset.blob, size, durationSec);
}

function styleFor(settings: StudioSettings, width: number): SubtitleStyle {
  return {
    arabicFamily: "'Uthmanic Hafs', 'Amiri', serif",
    translationFamily: 'system-ui, sans-serif',
    arabicSize: settings.arabicSize,
    translationSize: settings.translationSize,
    textColor: settings.textColor,
    accentColor: '#facc15',
    mutedColor: '#ffffff99',
    lineHeight: 1.5,
    translationGap: 24,
    marginX: Math.round(width * 0.06),
  };
}

/**
 * Loads the text and the recitation for every selected verse and returns a
 * complete spec. A duration over the hard ceiling throws before a single frame
 * is encoded — the caller can show the refusal while it still has the click.
 */
export async function buildRenderSpec(
  selection: readonly VerseRef[],
  settings: StudioSettings,
  deps: RenderSpecDeps = browserRenderSpecDeps(),
): Promise<RenderSpec & { timeline: Timeline }> {
  if (selection.length === 0) throw new Error('render: no verses selected');

  const reciter = reciterById(settings.reciterId);
  const surahNumbers = [...new Set(selection.map((ref) => ref.surah))];
  const surahs = await Promise.all(surahNumbers.map((number) => deps.loadSurah(number)));
  const byNumber = new Map(surahs.map((surah) => [surah.number, surah]));

  const verses: VerseClip[] = [];
  for (const ref of selection) {
    const verse = byNumber.get(ref.surah)?.verses.find((candidate) => candidate.number === ref.verse);
    if (!verse) throw new Error(`render: verse ${ref.surah}:${ref.verse} is not in the shipped text`);

    let audio: PlanarAudio;
    try {
      audio = await deps.loadAudio(audioUrl(reciter, ref));
    } catch (error) {
      // A multi-verse render must say which recitation failed. Keeping the
      // original message (and cause) preserves the HTTP or decode detail.
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`render: récitation introuvable pour ${ref.surah}:${ref.verse} — ${detail}`, {
        cause: error,
      });
    }
    verses.push({
      arabic: verse.arabic,
      translation: settings.showTranslation ? verse.translations[settings.translationLang] : '',
      words: null,
      audio,
      durationSec: audio.length / audio.sampleRate,
    });
  }

  const durations = verses.map((verse) => verse.durationSec);
  if (exceedsLimit(durations, MAX_VIDEO_SECONDS)) {
    throw new Error(`render: la vidéo dépasserait la limite de ${MAX_VIDEO_SECONDS} s`);
  }
  const timeline = buildTimeline(durations);
  if (settings.subtitleMode === 'word') {
    verses.forEach((verse, index) => {
      const words = verse.arabic.split(/\s+/).filter(Boolean);
      verse.words = allocateWordTimings(words, timeline.entries[index].start, verse.durationSec);
    });
  }

  const { width, height } = dimensionsFor(settings.aspectRatio);
  // The decoded source is looped by the painter; capping the decode at the
  // render's length avoids holding frames the user will never see.
  const background = await createBackground(
    settings.background,
    { width, height },
    deps,
    timeline.totalSec,
  );

  return {
    width,
    height,
    fps: 30,
    verses,
    style: styleFor(settings, width),
    background,
    backgroundSelection: settings.background,
    timeline,
    overlayOpacity: settings.overlayOpacity,
    maxDurationSec: MAX_VIDEO_SECONDS,
  };
}
