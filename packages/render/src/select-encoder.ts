/**
 * Which render path this browser can take.
 *
 * WebCodecs is the good path: fast, frame-accurate, MP4. MediaRecorder is the
 * fallback for browsers that can record a canvas but not encode frame by frame.
 * When neither exists the studio says so instead of failing halfway.
 */

export interface EncoderCapabilities {
  webCodecs: boolean;
  mediaRecorder: boolean;
}

export type EncoderKind = 'webcodecs' | 'mediarecorder' | 'none';

export function selectEncoder(caps: EncoderCapabilities): EncoderKind {
  if (caps.webCodecs) return 'webcodecs';
  if (caps.mediaRecorder) return 'mediarecorder';
  return 'none';
}
