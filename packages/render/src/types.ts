/**
 * The look of the subtitles, shared by the text layout and the compositor.
 *
 * Sizes and gaps are in pixels at the rendered frame's scale (1080 × 1920 for a
 * vertical video), so the same numbers produce the same text on a preview at
 * another size only after the caller scales them down.
 */
export interface SubtitleStyle {
  /** Font for the Arabic text. The platform's Uthmanic Hafs on web and native. */
  arabicFamily: string;
  /** Font for the translation. */
  translationFamily: string;
  /** Arabic type size, in pixels of the rendered frame. */
  arabicSize: number;
  translationSize: number;
  textColor: string;
  /** Colour of the word currently being recited, in word-by-word mode. */
  accentColor: string;
  /** Colour of the other words in word-by-word mode. */
  mutedColor: string;
  /** Height of one line box, as a multiple of the font size. */
  lineHeight: number;
  /** Space between the Arabic block and the translation, in pixels. */
  translationGap: number;
  /** Margin on the left and right of the frame, in pixels. */
  marginX: number;
}

/** How far a render has got, in frames and in percent. */
export interface Progress {
  frame: number;
  totalFrames: number;
  /** 0 to 100, monotone. */
  percent: number;
  /** Estimated seconds left, from the speed so far. */
  etaSec: number;
}

/** The file a render produced. */
export interface RenderedVideo {
  blob: Blob;
  durationSec: number;
  width: number;
  height: number;
  container: 'mp4' | 'webm';
  /** Family name of the picture codec, e.g. `avc1` or `vp9`. */
  videoCodec: string;
}
