import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteBackgroundAsset,
  loadBackgroundAsset,
  resetStudioStorage,
  saveBackgroundAsset,
} from '../src/lib/storage';
import { validateBackgroundFile } from '../src/lib/import-background';

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...ascii('IHDR')];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF')];
const WEBP = [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')];

function imageFile(bytes: number[], type: string, name = 'fond') {
  return new File([new Uint8Array(bytes)], name, { type });
}

function mp4File(codec: string | null, type = 'video/mp4', size = 128) {
  const bytes = new Uint8Array(size);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set(ascii('ftyp'), 4);
  bytes.set(ascii('isom'), 8);
  bytes.set(ascii('mp42'), 16);
  if (codec) bytes.set(ascii(codec), 32);
  return new File([bytes], 'fond.mp4', { type });
}

beforeEach(() => {
  resetStudioStorage();
});

describe('validateBackgroundFile', () => {
  it('accepts a PNG, a JPEG and a WebP', async () => {
    await expect(validateBackgroundFile(imageFile(PNG, 'image/png'))).resolves.toEqual({
      ok: true,
      kind: 'image',
    });
    await expect(validateBackgroundFile(imageFile(JPEG, 'image/jpeg'))).resolves.toEqual({
      ok: true,
      kind: 'image',
    });
    await expect(validateBackgroundFile(imageFile(WEBP, 'image/webp'))).resolves.toEqual({
      ok: true,
      kind: 'image',
    });
  });

  it('accepts an MP4 whose sample entry is H.264', async () => {
    await expect(validateBackgroundFile(mp4File('avc1'))).resolves.toEqual({
      ok: true,
      kind: 'video',
      codec: 'h264',
    });
  });

  it('refuses a video in another codec instead of producing a broken render', async () => {
    await expect(validateBackgroundFile(mp4File('hvc1'))).resolves.toEqual({
      ok: false,
      reason: 'codec',
    });
    await expect(validateBackgroundFile(mp4File('hev1'))).resolves.toEqual({
      ok: false,
      reason: 'codec',
    });
    await expect(validateBackgroundFile(mp4File('av01'))).resolves.toEqual({
      ok: false,
      reason: 'codec',
    });
  });

  it('refuses an MP4 it cannot prove to be H.264', async () => {
    await expect(validateBackgroundFile(mp4File(null))).resolves.toEqual({
      ok: false,
      reason: 'codec',
    });
  });

  it('finds the sample entry when the file index sits at the end', async () => {
    const bytes = new Uint8Array(700_000);
    bytes.set([0, 0, 0, 0x18], 0);
    bytes.set(ascii('ftyp'), 4);
    bytes.set(ascii('isom'), 8);
    bytes.set(ascii('avc1'), bytes.length - 40);

    await expect(
      validateBackgroundFile(new File([bytes], 'fond.mp4', { type: 'video/mp4' })),
    ).resolves.toEqual({ ok: true, kind: 'video', codec: 'h264' });
  });

  it('refuses a text file', async () => {
    await expect(
      validateBackgroundFile(new File(['bonjour'], 'notes.txt', { type: 'text/plain' })),
    ).resolves.toEqual({ ok: false, reason: 'type' });
  });

  it('refuses a file whose declared type contradicts its contents', async () => {
    await expect(
      validateBackgroundFile(new File([new Uint8Array(PNG)], 'piege.txt', { type: 'text/plain' })),
    ).resolves.toEqual({ ok: false, reason: 'type' });
  });

  it('judges by content, not by the file name', async () => {
    await expect(
      validateBackgroundFile(imageFile(PNG, 'image/png', 'fond.exe')),
    ).resolves.toEqual({ ok: true, kind: 'image' });
  });

  it('refuses an empty file', async () => {
    await expect(
      validateBackgroundFile(new File([], 'vide.png', { type: 'image/png' })),
    ).resolves.toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses a WebM, which the renderer cannot decode frame by frame', async () => {
    const webm = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'fond.webm', {
      type: 'video/webm',
    });

    await expect(validateBackgroundFile(webm)).resolves.toEqual({ ok: false, reason: 'type' });
  });

  it('refuses an SVG, which could reference the network', async () => {
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'fond.svg', {
      type: 'image/svg+xml',
    });

    await expect(validateBackgroundFile(svg)).resolves.toEqual({ ok: false, reason: 'type' });
  });
});

describe('background assets', () => {
  it('keeps the imported file on the device and gives it back', async () => {
    const file = imageFile(PNG, 'image/png', 'mosquee.png');

    const assetId = await saveBackgroundAsset(file, 'mosquee.png');
    const stored = await loadBackgroundAsset(assetId);

    expect(stored?.name).toBe('mosquee.png');
    expect(stored?.blob.size).toBe(file.size);
  });

  it('forgets an asset the user removed', async () => {
    const assetId = await saveBackgroundAsset(imageFile(PNG, 'image/png'), 'fond.png');

    await deleteBackgroundAsset(assetId);

    expect(await loadBackgroundAsset(assetId)).toBeNull();
  });

  it('returns null for an asset that does not exist', async () => {
    expect(await loadBackgroundAsset('missing')).toBeNull();
  });
});
