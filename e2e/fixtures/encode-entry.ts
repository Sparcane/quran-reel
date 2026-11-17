/**
 * What the Playwright test loads in the browser.
 *
 * The renderer needs real `OffscreenCanvas`, `VideoFrame`, `AudioData` and
 * codecs, none of which jsdom has. This entry builds a short plan out of a
 * synthesised recitation, renders it, then hands the produced file to a real
 * `<video>` element so "the file exists" and "the file plays" are both checked.
 */

import { buildTimeline } from '@quran/core';
import {
  createGradientPainter,
  createSink,
  encodeWebCodecs,
  type VerseClip,
} from '@quran/render';

export interface EncodeReport {
  ftyp: string;
  size: number;
  container: string;
  videoCodec: string;
  durationSec: number;
  width: number;
  height: number;
  elapsedMs: number;
  framesPerSecond: number;
  progress: { first: number; last: number; monotonic: boolean };
  playback: {
    duration: number;
    videoWidth: number;
    videoHeight: number;
    readyState: number;
    /** Bytes of AAC the player actually decoded, 0 when the track is missing. */
    audioBytes: number;
  };
}

declare global {
  interface Window {
    runQuranEncode: (options?: { width?: number; height?: number }) => Promise<EncodeReport>;
  }
}

const SAMPLE_RATE = 48_000;

/** A quiet 440 Hz tone: enough for the AAC encoder to produce real packets. */
function tone(seconds: number): AudioBuffer {
  const length = Math.round(seconds * SAMPLE_RATE);
  const buffer = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: SAMPLE_RATE });
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) {
    data[index] = 0.2 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE);
  }
  return buffer;
}

window.runQuranEncode = async ({ width = 1080, height = 1920 } = {}) => {
  const verses: VerseClip[] = [0, 1, 2].map(() => ({
    arabic: 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ',
    translation: 'Au nom de Dieu, le Tout Miséricordieux, le Très Miséricordieux.',
    words: null,
    audio: tone(1),
    durationSec: 1,
  }));

  const plan = {
    width,
    height,
    fps: 30 as const,
    verses,
    timeline: buildTimeline(verses.map((verse) => verse.durationSec)),
    style: {
      arabicFamily: 'serif',
      translationFamily: 'sans-serif',
      arabicSize: 48,
      translationSize: 26,
      textColor: '#ffffff',
      accentColor: '#facc15',
      mutedColor: '#ffffff80',
      lineHeight: 1.5,
      translationGap: 24,
      marginX: 80,
    },
    background: createGradientPainter(
      { kind: 'gradient', from: '#052e16', to: '#0f172a', angle: 25, motion: true },
      { width, height },
    ),
    overlayOpacity: 45,
    watermark: 'Quran Studio',
  };

  const sink = await createSink('memory', 'e2e.mp4');
  const percents: number[] = [];
  const startedAt = performance.now();
  const result = await encodeWebCodecs(plan, sink, (progress) => percents.push(progress.percent));
  const elapsedMs = performance.now() - startedAt;

  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const ftyp = new TextDecoder().decode(bytes.subarray(4, 8));

  const url = URL.createObjectURL(result.blob);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.volume = 0;
  video.src = url;
  document.body.append(video);

  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('the produced file did not load')), {
      once: true,
    });
  });

  // Seeking makes the player decode a picture, not just read the header.
  const seeked = new Promise<void>((resolve) => {
    video.addEventListener('seeked', () => resolve(), { once: true });
  });
  video.currentTime = 1.5;
  await seeked;

  const first = {
    duration: video.duration,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    readyState: video.readyState,
  };

  // Playing half a second proves the AAC track is real: Chrome counts the audio
  // bytes it decoded, and a file without an audio track leaves the count at 0.
  const counted = video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
  video.currentTime = 0;
  await video.play();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('playback did not advance')), 15_000);
    const check = () => {
      if (video.currentTime > 0.5) {
        clearTimeout(timer);
        resolve();
      } else {
        video.addEventListener('timeupdate', check, { once: true });
      }
    };
    check();
  });
  video.pause();

  const playback = {
    ...first,
    audioBytes: counted.webkitAudioDecodedByteCount ?? 0,
  };

  URL.revokeObjectURL(url);

  const totalFrames = Math.round(plan.timeline.totalSec * plan.fps);

  return {
    ftyp,
    size: bytes.length,
    container: result.container,
    videoCodec: result.videoCodec,
    durationSec: result.durationSec,
    width: result.width,
    height: result.height,
    elapsedMs,
    framesPerSecond: totalFrames / (elapsedMs / 1000),
    progress: {
      first: percents[0],
      last: percents.at(-1)!,
      monotonic: percents.every((percent, index) => index === 0 || percent >= percents[index - 1]),
    },
    playback,
  };
};
