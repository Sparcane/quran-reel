import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Size } from '@quran/render';
import type { ImageSelection, VideoSelection } from '@quran/core';
import {
  createImportedBackground,
  ensureImportedAsset,
  isMissingBackgroundAsset,
  MISSING_BACKGROUND_ASSET_ERROR,
} from '@/lib/background-painter';

const { loadBackgroundAsset, createVideoPainter } = vi.hoisted(() => ({
  loadBackgroundAsset: vi.fn(),
  createVideoPainter: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({ loadBackgroundAsset }));
vi.mock('@quran/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@quran/render')>();
  return { ...actual, createVideoPainter };
});

const SIZE: Size = { width: 640, height: 360 };
const IMAGE: ImageSelection = { kind: 'image', assetId: 'asset-1', name: 'fond.png' };
const VIDEO: VideoSelection = { kind: 'video', assetId: 'asset-2', name: 'fond.mp4' };
const BLOB = new Blob(['pixels'], { type: 'image/png' });

const closeBitmap = vi.fn();
const bitmap = { width: 1280, height: 720, close: closeBitmap } as unknown as ImageBitmap;

async function setAsset(blob: Blob | null): Promise<void> {
  loadBackgroundAsset.mockResolvedValue(
    blob === null ? null : { id: 'asset', name: 'fond', mime: blob.type, blob, savedAt: 1 },
  );
}

beforeEach(() => {
  loadBackgroundAsset.mockReset();
  createVideoPainter.mockReset();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
  closeBitmap.mockClear();
});

describe('ensureImportedAsset', () => {
  it('accepts an asset that is still on the device', async () => {
    await setAsset(BLOB);

    await expect(ensureImportedAsset(IMAGE)).resolves.toBeUndefined();
    expect(loadBackgroundAsset).toHaveBeenCalledWith('asset-1');
  });

  it('names the one recovery when the asset is gone', async () => {
    await setAsset(null);

    await expect(ensureImportedAsset(VIDEO)).rejects.toThrow(MISSING_BACKGROUND_ASSET_ERROR);
    expect(isMissingBackgroundAsset(MISSING_BACKGROUND_ASSET_ERROR)).toBe(true);
    expect(isMissingBackgroundAsset('une autre erreur')).toBe(false);
  });
});

describe('createImportedBackground', () => {
  it('decodes the stored picture and paints it at the requested size', async () => {
    await setAsset(BLOB);
    const draws: unknown[][] = [];

    const painter = await createImportedBackground(IMAGE, SIZE, 4);
    painter.paint({ drawImage: (...args: unknown[]) => draws.push(args) } as never, 0);
    painter.dispose();

    expect(createImageBitmap).toHaveBeenCalledWith(BLOB);
    // A 1280x720 source is cropped to cover 640x360, not squashed.
    expect(draws[0]).toEqual([bitmap, 0, 0, 640, 360]);
    expect(closeBitmap).toHaveBeenCalledOnce();
  });

  it('passes the whole render length to the video painter', async () => {
    await setAsset(BLOB);
    const painter = { ready: true, paint() {}, dispose() {} };
    createVideoPainter.mockResolvedValue(painter);

    await expect(createImportedBackground(VIDEO, SIZE, 12.5)).resolves.toBe(painter);
    expect(createVideoPainter).toHaveBeenCalledWith(BLOB, SIZE, 12.5);
  });

  it('never reaches a decoder when the asset is gone', async () => {
    await setAsset(null);

    await expect(createImportedBackground(VIDEO, SIZE, 4)).rejects.toThrow(
      MISSING_BACKGROUND_ASSET_ERROR,
    );
    expect(createVideoPainter).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
