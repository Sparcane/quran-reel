/** How many bytes from each end of the file are inspected. */
const SNIFF_BYTES = 256 * 1024;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const VIDEO_TYPES = ['video/mp4'] as const;

export type BackgroundFileRejection = 'type' | 'codec' | 'empty';

export type BackgroundFileCheck =
  | { ok: true; kind: 'image' }
  | { ok: true; kind: 'video'; codec: 'h264' }
  | { ok: false; reason: BackgroundFileRejection };

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.slice(at, at + length));
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
    return { ok: true, kind: 'image' };
  }

  if (looksLikeMp4(head)) {
    if (declaredImage) return { ok: false, reason: 'type' };
    const codec =
      detectMp4Codec(head) ??
      // A non-faststart MP4 keeps its index (`moov`) at the end of the file.
      (file.size > SNIFF_BYTES
        ? detectMp4Codec(await readWindow(file, Math.max(0, file.size - SNIFF_BYTES), file.size))
        : null);

    if (codec === 'h264') return { ok: true, kind: 'video', codec: 'h264' };
    return { ok: false, reason: 'codec' };
  }

  return { ok: false, reason: 'type' };
}
