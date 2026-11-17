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

export type ImportedSelection = ImageSelection | VideoSelection;

/**
 * Refuses a selection whose asset is gone, without paying the decode. The
 * store calls this on every read of a queued job, so it must stay cheap.
 */
export async function ensureImportedAsset(selection: ImportedSelection): Promise<void> {
  const asset = await loadBackgroundAsset(selection.assetId);
  if (!asset) {
    throw new Error('render: le fond importé n’est plus sur cet appareil');
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
    throw new Error('render: le fond importé n’est plus sur cet appareil');
  }
  if (selection.kind === 'image') {
    return createImagePainter(await createImageBitmap(asset.blob), size);
  }
  return createVideoPainter(asset.blob, size, durationSec);
}
