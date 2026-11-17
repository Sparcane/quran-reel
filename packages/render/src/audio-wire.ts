/**
 * The serialisable form of an encode plan.
 *
 * A live `PlanarAudio` is usually an `AudioBuffer`, and a `BackgroundPainter`
 * always holds methods — neither survives `postMessage` or IndexedDB's
 * structured clone. The WebCodecs worker and the device store therefore pass
 * this plain form across the boundary and rebuild the methods on the other side.
 */

import type { BackgroundSelection } from '@quran/core';
import { createGradientPainter } from './background';
import type { EncodePlan, PlanarAudio, VerseClip } from './encoder-plan';

/** Channels as plain typed arrays: cloning a `Float32Array` keeps its bytes. */
export interface WireAudio {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  channels: Float32Array[];
}

export type WireVerseClip = Omit<VerseClip, 'audio'> & { audio: WireAudio | null };

/** The plan without its live painter; `backgroundSelection` describes it. */
export type WireEncodePlan = Omit<EncodePlan, 'verses' | 'background'> & {
  verses: WireVerseClip[];
};

export function serialiseAudio(audio: PlanarAudio | null): WireAudio | null {
  if (!audio) return null;
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    // Copy: the source may be an AudioBuffer whose backing store must not be
    // shared with a worker or a stored record.
    channels.push(new Float32Array(audio.getChannelData(channel)));
  }
  return {
    sampleRate: audio.sampleRate,
    numberOfChannels: audio.numberOfChannels,
    length: audio.length,
    channels,
  };
}

export function deserialiseAudio(audio: PlanarAudio | WireAudio | null): PlanarAudio | null {
  if (!audio) return null;
  // An in-process caller may hand us a live AudioBuffer; leave it untouched.
  if (!('channels' in audio)) return audio;
  const { sampleRate, length, numberOfChannels, channels } = audio;
  return {
    sampleRate,
    length,
    numberOfChannels,
    getChannelData: (channel: number) => {
      const data = channels[channel];
      if (!data) throw new Error(`render: there is no audio channel ${channel}`);
      return data;
    },
  };
}

export function serialiseEncodePlan(plan: EncodePlan): WireEncodePlan {
  const { verses, background: _painter, ...rest } = plan;
  void _painter;
  return {
    ...rest,
    verses: verses.map((verse) => ({ ...verse, audio: serialiseAudio(verse.audio) })),
  };
}

/**
 * Rebuilds what the encoder needs from the wire form. Only a gradient can be
 * reconstructed in a worker without loading a device asset; the app keeps
 * imported backgrounds on the main thread, where the real painter is available.
 */
export function deserialiseEncodePlan(plan: WireEncodePlan): EncodePlan {
  const selection: BackgroundSelection | undefined = plan.backgroundSelection;
  if (!selection || selection.kind !== 'gradient') {
    throw new Error('render: the worker cannot rebuild this background');
  }
  const background = createGradientPainter(selection, {
    width: plan.width,
    height: plan.height,
  });
  return {
    ...plan,
    background,
    verses: plan.verses.map((verse) => ({ ...verse, audio: deserialiseAudio(verse.audio) })),
  };
}
