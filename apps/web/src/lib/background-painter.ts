/**
 * Rebuilds the painter of an imported background from the device asset.
 *
 * A painter cannot cross IndexedDB, so the queue store keeps only the plain
 * `backgroundSelection`. When the queue reads a queued job to render it — which
 * always happens after the full page load the render flow uses — the store
 * rebuilds the real painter here, so the render paints what the user actually
 * chose instead of silently falling back to the default gradient.
 */

import { createImagePainter, createVideoPainter, type BackgroundPainter, type Size } from '@quran/render';
import type { ImageSelection, VideoSelection } from '@quran/core';
import { loadBackgroundAsset } from '@/lib/storage';
import { videoBackgroundEnvironment } from '@/lib/video-environment';

export type ImportedSelection = ImageSelection | VideoSelection;

/**
 * The honest error for a background asset that is gone from the device. It
 * names the only real recovery: the re-import creates a NEW asset id, which
 * only the studio can put into a fresh spec — retrying this job's spec would
 * fail again, so the result page offers no Relancer for it.
 */
export const MISSING_BACKGROUND_ASSET_ERROR =
  'le fond importé n’est plus sur cet appareil ; réimportez-le dans le studio puis relancez la génération';

export function isMissingBackgroundAsset(error: string | undefined | null): boolean {
  return error !== undefined && error !== null && error.includes(MISSING_BACKGROUND_ASSET_ERROR);
}

const missingAsset = () => new Error(MISSING_BACKGROUND_ASSET_ERROR);

/**
 * Refuses a selection whose asset is gone, without paying the decode. The
 * store calls this on every read of a queued job, so it must stay cheap.
 */
export async function ensureImportedAsset(selection: ImportedSelection): Promise<void> {
  const asset = await loadBackgroundAsset(selection.assetId);
  if (!asset) {
    throw missingAsset();
  }
}

/** How long the video background needs to cover: the whole render. */
export async function createImportedBackground(
  selection: ImportedSelection,
  size: Size,
  durationSec: number,
): Promise<BackgroundPainter> {
  const asset = await loadBackgroundAsset(selection.assetId);
  if (!asset) {
    throw missingAsset();
  }
  if (selection.kind === 'image') {
    return createImagePainter(await createImageBitmap(asset.blob), size);
  }
  return createVideoPainter(asset.blob, size, durationSec, videoBackgroundEnvironment());
}
