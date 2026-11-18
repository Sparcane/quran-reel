import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteBackgroundAsset,
  loadBackgroundAsset,
  resetStudioStorage,
  saveBackgroundAsset,
} from '../src/lib/storage';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_SOURCE_SECONDS,
  MAX_VIDEO_BYTES,
  validateBackgroundFile,
} from '../src/lib/import-background';

const ascii = (text: string) => [...text].map((character) => character.charCodeAt(0));

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, ...ascii('IHDR')];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii('JFIF')];
const WEBP = [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')];

/** A PNG header carrying real dimensions, as far as the IHDR chunk goes. */
function pngOf(width: number, height: number): number[] {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 0x0d], 8);
  bytes.set(ascii('IHDR'), 12);
  bytes.set(u32(width), 16);
  bytes.set(u32(height), 20);
  return [...bytes];
}

/** A JPEG with an APP0 segment followed by a baseline SOF0 frame header. */
function jpegOf(width: number, height: number): number[] {
  return [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    0x04,
    0,
    0,
    0xff,
    0xc0,
    ...u16(11),
    0x08,
    ...u16(height),
    ...u16(width),
    0x01,
    0x01,
    0x11,
    0,
  ];
}

/** An extended WebP: the canvas size lives in the VP8X chunk. */
function webpOf(width: number, height: number): number[] {
  const bytes = new Uint8Array(30);
  bytes.set(ascii('RIFF'), 0);
  bytes.set(u32(22), 4);
  bytes.set(ascii('WEBP'), 8);
  bytes.set(ascii('VP8X'), 12);
  bytes.set(u32(10), 16);
  bytes.set(u24le(width - 1), 24);
  bytes.set(u24le(height - 1), 27);
  return [...bytes];
}

/** VP8X stores a 24-bit integer least significant byte first. */
function u24le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/**
 * An MP4 whose `moov` carries an `mvhd` of the given length. The sample entry
 * is placed after it, the way a real `stsd` would be.
 */
function mp4Of(durationSec: number, codec = 'avc1', version: 0 | 1 = 0) {
  const mvhdSize = version === 0 ? 108 : 120;
  const bytes = new Uint8Array(32 + mvhdSize);
  bytes.set(u32(24), 0);
  bytes.set(ascii('ftyp'), 4);
  bytes.set(ascii('isom'), 8);
  bytes.set(ascii('mp42'), 16);
  bytes.set(u32(mvhdSize + 8), 24);
  bytes.set(ascii('moov'), 28);
  bytes.set(u32(mvhdSize), 32);
  bytes.set(ascii('mvhd'), 36);
  bytes[40] = version;
  if (version === 1) {
    // Version 1 widens the timestamps to 64 bits, so the timescale sits later.
    bytes.set(u32(1000), 60);
    bytes.set(u32(0), 64);
    bytes.set(u32(Math.round(durationSec * 1000)), 68);
  } else {
    bytes.set(u32(1000), 52);
    bytes.set(u32(Math.round(durationSec * 1000)), 56);
  }
  bytes.set(ascii(codec), bytes.length - 4);
  return bytes;
}

/**
 * An `ArrayBuffer`-backed copy. `BlobPart` refuses a view over a possibly
 * shared buffer, which is how TypeScript widens a `Uint8Array` parameter.
 */
function blobPart(bytes: number[] | Uint8Array) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

function imageFile(bytes: number[] | Uint8Array, type: string, name = 'fond') {
  return new File([blobPart(bytes)], name, { type });
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

describe('import bounds', () => {
  it('accepts a 4K picture', async () => {
    await expect(
      validateBackgroundFile(imageFile(pngOf(3840, 2160), 'image/png')),
    ).resolves.toEqual({ ok: true, kind: 'image' });
  });

  it('refuses a picture above the byte limit before it is copied to the device', async () => {
    const bytes = new Uint8Array(MAX_IMAGE_BYTES + 1);
    bytes.set(pngOf(3840, 2160), 0);

    await expect(validateBackgroundFile(imageFile(bytes, 'image/png'))).resolves.toEqual({
      ok: false,
      reason: 'size',
    });
  });

  it('refuses a picture whose side is longer than the limit', async () => {
    await expect(
      validateBackgroundFile(imageFile(pngOf(MAX_IMAGE_SIDE + 1, 1080), 'image/png')),
    ).resolves.toEqual({ ok: false, reason: 'dimensions' });
  });

  it('refuses a picture with too many pixels even when each side fits', async () => {
    const side = Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS)) + 100;
    expect(side).toBeLessThan(MAX_IMAGE_SIDE);

    await expect(
      validateBackgroundFile(imageFile(pngOf(side, side), 'image/png')),
    ).resolves.toEqual({ ok: false, reason: 'dimensions' });
  });

  it('reads the size of a JPEG frame header', async () => {
    await expect(
      validateBackgroundFile(imageFile(jpegOf(MAX_IMAGE_SIDE + 1, 1080), 'image/jpeg')),
    ).resolves.toEqual({ ok: false, reason: 'dimensions' });
  });

  it('reads the size of an extended WebP canvas', async () => {
    await expect(
      validateBackgroundFile(imageFile(webpOf(MAX_IMAGE_SIDE + 1, 1080), 'image/webp')),
    ).resolves.toEqual({ ok: false, reason: 'dimensions' });
  });

  it('refuses a video above the byte limit', async () => {
    const bytes = mp4Of(5);
    const padded = new Uint8Array(MAX_VIDEO_BYTES + 1);
    padded.set(bytes, 0);

    await expect(
      validateBackgroundFile(new File([blobPart(padded)], 'fond.mp4', { type: 'video/mp4' })),
    ).resolves.toEqual({ ok: false, reason: 'size' });
  });

  it('accepts a video shorter than the limit', async () => {
    await expect(
      validateBackgroundFile(
        new File([blobPart(mp4Of(MAX_SOURCE_SECONDS - 1))], 'fond.mp4', { type: 'video/mp4' }),
      ),
    ).resolves.toEqual({ ok: true, kind: 'video', codec: 'h264' });
  });

  it('refuses a video that runs longer than the limit', async () => {
    await expect(
      validateBackgroundFile(
        new File([blobPart(mp4Of(MAX_SOURCE_SECONDS + 1))], 'fond.mp4', { type: 'video/mp4' }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'duration' });
  });

  it('reads the duration of a 64-bit movie header', async () => {
    await expect(
      validateBackgroundFile(
        new File([blobPart(mp4Of(MAX_SOURCE_SECONDS + 1, 'avc1', 1))], 'fond.mp4', {
          type: 'video/mp4',
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: 'duration' });
  });

  it('finds the duration when the index sits at the end', async () => {
    const bytes = new Uint8Array(700_000);
    bytes.set(u32(24), 0);
    bytes.set(ascii('ftyp'), 4);
    bytes.set(ascii('isom'), 8);
    bytes.set(ascii('avc1'), 0x1000);
    const at = bytes.length - 112;
    bytes.set(u32(108), at - 4);
    bytes.set(ascii('mvhd'), at);
    bytes.set(u32(1000), at + 16);
    bytes.set(u32((MAX_SOURCE_SECONDS + 1) * 1000), at + 20);

    await expect(
      validateBackgroundFile(new File([blobPart(bytes)], 'fond.mp4', { type: 'video/mp4' })),
    ).resolves.toEqual({ ok: false, reason: 'duration' });
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
