/** How many bytes from each end of the file are inspected. */
const SNIFF_BYTES = 256 * 1024;

/**
 * What a file may weigh and measure and still be painted behind the text.
 *
 * A picture is decoded at its own resolution and every decoded video frame
 * stays in memory, so these are checked on the metadata before a single byte is
 * copied onto the device: a 20 000 px image or a two-gigabyte video would take
 * the tab down long before a render could start.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Two 4K sides with room to spare; the output is at most 1080 px wide. */
export const MAX_IMAGE_SIDE = 8192;
/** 16 MP is twice a 4K picture, and about 64 MB once decoded. */
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
/** A background is looped, so a longer source only costs memory. */
export const MAX_SOURCE_SECONDS = 300;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const VIDEO_TYPES = ['video/mp4'] as const;

export type BackgroundFileRejection = 'type' | 'codec' | 'empty' | 'size' | 'dimensions' | 'duration';

export type BackgroundFileCheck =
  | { ok: true; kind: 'image' }
  | { ok: true; kind: 'video'; codec: 'h264' }
  | { ok: false; reason: BackgroundFileRejection };

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.slice(at, at + length));
}

/** Whether the bytes spell `text` at `at`, without allocating a string. */
function hasAscii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let offset = 0; offset < text.length; offset += 1) {
    if (bytes[at + offset] !== text.charCodeAt(offset)) return false;
  }
  return true;
}

function contains(bytes: Uint8Array, needle: string): boolean {
  const wanted = [...needle].map((character) => character.charCodeAt(0));
  const last = bytes.length - wanted.length;
  for (let start = 0; start <= last; start += 1) {
    let found = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (bytes[start + offset] !== wanted[offset]) {
        found = false;
        break;
      }
    }
    if (found) return true;
  }
  return false;
}

function looksLikePng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function looksLikeJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function looksLikeWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP';
}

/** An ISO base media file (MP4, MOV) starts with an `ftyp` box. */
function looksLikeMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp';
}

const H264_SAMPLE_ENTRIES = ['avc1', 'avc3'];
const OTHER_VIDEO_SAMPLE_ENTRIES = ['hvc1', 'hev1', 'av01', 'vp09', 'mp4v'];

function detectMp4Codec(bytes: Uint8Array): 'h264' | 'other' | null {
  if (H264_SAMPLE_ENTRIES.some((entry) => contains(bytes, entry))) return 'h264';
  if (OTHER_VIDEO_SAMPLE_ENTRIES.some((entry) => contains(bytes, entry))) return 'other';
  return null;
}

async function readWindow(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

interface PixelSize {
  width: number;
  height: number;
}

function readUint16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readUint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function readUint64(bytes: Uint8Array, at: number): number {
  return readUint32(bytes, at) * 2 ** 32 + readUint32(bytes, at + 4);
}

function readUint24Le(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

/** The canvas size from the IHDR chunk, which is always the first chunk. */
function pngSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  return { width: readUint32(bytes, 16), height: readUint32(bytes, 20) };
}

/**
 * Walk the JPEG segments up to the frame header. Entropy-coded data can hold
 * the bytes of a frame header by accident, so the walk stops at the scan.
 */
function jpegSize(bytes: Uint8Array): PixelSize | null {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    // Padding and standalone markers carry no length field.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda) return null;
    const length = readUint16(bytes, at + 2);
    if (length < 2) return null;
    // SOF0..SOF15 carry the frame size, except DHT (c4), JPG (c8) and DAC (cc).
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      return { height: readUint16(bytes, at + 5), width: readUint16(bytes, at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

/** The canvas size, from whichever of the three WebP variants this file is. */
function webpSize(bytes: Uint8Array): PixelSize | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    // Extended format: canvas size minus one, as two 24-bit little-endian words.
    return { width: 1 + readUint24Le(bytes, 24), height: 1 + readUint24Le(bytes, 27) };
  }
  if (chunk === 'VP8 ') {
    // Lossy bitstream: frame tag, start code, then 14-bit dimensions.
    return { width: readUint16(bytes, 26) & 0x3fff, height: readUint16(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Lossless bitstream: 14-bit dimensions packed after the signature byte.
    const packed = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: 1 + (packed & 0x3fff), height: 1 + ((packed >> 14) & 0x3fff) };
  }
  return null;
}

function imageSize(head: Uint8Array): PixelSize | null {
  const size = looksLikePng(head)
    ? pngSize(head)
    : looksLikeJpeg(head)
      ? jpegSize(head)
      : looksLikeWebp(head)
        ? webpSize(head)
        : null;
  if (!size || size.width <= 0 || size.height <= 0) return null;
  return size;
}

function tooLargeForImport(size: PixelSize): boolean {
  return (
    size.width > MAX_IMAGE_SIDE ||
    size.height > MAX_IMAGE_SIDE ||
    size.width * size.height > MAX_IMAGE_PIXELS
  );
}

/**
 * The movie duration from `mvhd`, in seconds, or null when the header is not
 * in the window. Version 1 stores 64-bit times; version 0, the common one,
 * 32-bit ones.
 */
function movieDurationSec(bytes: Uint8Array): number | null {
  for (let at = 4; at + 36 <= bytes.length; at += 1) {
    if (!hasAscii(bytes, at, 'mvhd')) continue;
    const size = readUint32(bytes, at - 4);
    // `mvhd` is 108 bytes in version 0 and 120 in version 1. Any other size is
    // a byte sequence that happens to spell the box name.
    if (size !== 108 && size !== 120) continue;
    const version = bytes[at + 4];
    const timescale = version === 1 ? readUint32(bytes, at + 24) : readUint32(bytes, at + 16);
    const duration = version === 1 ? readUint64(bytes, at + 28) : readUint32(bytes, at + 20);
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

/**
 * Decides whether a file the user picked can be painted behind the text.
 *
 * Both the declared MIME type and the bytes are checked: an extension proves
 * nothing, and a file that says `image/png` while holding text would otherwise
 * reach the renderer and fail after the user waited for a render. Only formats
 * the renderer can decode frame by frame are accepted, so an HEVC video is
 * refused here (with a reason) rather than producing a broken MP4 later.
 */
export async function validateBackgroundFile(file: File): Promise<BackgroundFileCheck> {
  if (file.size === 0) return { ok: false, reason: 'empty' };

  const declared = file.type.toLowerCase();
  const declaredImage = (IMAGE_TYPES as readonly string[]).includes(declared);
  const declaredVideo = (VIDEO_TYPES as readonly string[]).includes(declared);
  // An empty MIME type means the platform did not recognise the file; the
  // bytes still can. Any other unknown MIME type is a refusal.
  if (declared !== '' && !declaredImage && !declaredVideo) {
    return { ok: false, reason: 'type' };
  }

  const head = await readWindow(file, 0, Math.min(file.size, SNIFF_BYTES));

  if (looksLikePng(head) || looksLikeJpeg(head) || looksLikeWebp(head)) {
    // A picture declared as a video is as suspect as a text file called .png.
    if (declaredVideo) return { ok: false, reason: 'type' };
    // The bytes are copied to the device and decoded at their own resolution,
    // so the size is judged before either happens.
    if (file.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'size' };
    const size = imageSize(head);
    // Unknown dimensions are not a refusal: a truncated or exotic header must
    // not reject a file the decoder may well accept.
    if (size && tooLargeForImport(size)) return { ok: false, reason: 'dimensions' };
    return { ok: true, kind: 'image' };
  }

  if (looksLikeMp4(head)) {
    if (declaredImage) return { ok: false, reason: 'type' };
    if (file.size > MAX_VIDEO_BYTES) return { ok: false, reason: 'size' };

    // A non-faststart MP4 keeps its index (`moov`) at the end of the file, so
    // the tail is read once and used for both the codec and the duration.
    const tail =
      file.size > SNIFF_BYTES
        ? await readWindow(file, Math.max(0, file.size - SNIFF_BYTES), file.size)
        : null;

    const codec = detectMp4Codec(head) ?? (tail ? detectMp4Codec(tail) : null);
    if (codec !== 'h264') return { ok: false, reason: 'codec' };

    // Every decoded frame of the source stays in memory, so a long clip is
    // refused before the decode rather than after it.
    const seconds = movieDurationSec(head) ?? (tail ? movieDurationSec(tail) : null);
    if (seconds !== null && seconds > MAX_SOURCE_SECONDS) {
      return { ok: false, reason: 'duration' };
    }
    return { ok: true, kind: 'video', codec: 'h264' };
  }

  return { ok: false, reason: 'type' };
}
