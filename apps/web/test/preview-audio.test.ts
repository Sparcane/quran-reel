import { describe, expect, it } from 'vitest';
import { PreviewPlayer } from '../src/lib/preview-audio';
import { fakeAudio, fakeFetch } from './fake-audio';

describe('PreviewPlayer', () => {
  it('downloads each selected verse from EveryAyah, in reading order', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const fetchBytes = fakeFetch();
    const player = new PreviewPlayer(fetchBytes, audio.factory);

    await player.load(
      [
        { surah: 36, verse: 1 },
        { surah: 36, verse: 2 },
      ],
      'alafasy',
    );

    expect(fetchBytes.mock.calls.map(([url]) => url)).toEqual([
      'https://everyayah.com/data/Alafasy_128kbps/036001.mp3',
      'https://everyayah.com/data/Alafasy_128kbps/036002.mp3',
    ]);
    expect(audio.context.decodeAudioData).toHaveBeenCalledTimes(2);
    expect(player.state).toBe('idle');
    expect(player.loadedCount).toBe(2);
  });

  it('refuses a reciter the catalogue does not know, without downloading', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const fetchBytes = fakeFetch();
    const player = new PreviewPlayer(fetchBytes, audio.factory);

    await expect(player.load([{ surah: 1, verse: 1 }], 'nobody')).rejects.toThrow(/nobody/);
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(player.state).toBe('idle');
  });

  it('reports "blocked" when the browser refuses to resume the audio context', async () => {
    const audio = fakeAudio();
    audio.block();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);

    await player.load([{ surah: 1, verse: 1 }], 'alafasy');
    await player.play();

    expect(player.state).toBe('blocked');
    // Nothing was played silently: no source was even created.
    expect(audio.sources).toHaveLength(0);
  });

  it('recovers on the next click once the gesture is allowed', async () => {
    const audio = fakeAudio();
    audio.block();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);
    await player.load([{ surah: 1, verse: 1 }], 'alafasy');
    await player.play();
    expect(player.state).toBe('blocked');

    audio.unblock();
    await player.play();

    expect(player.state).toBe('playing');
    expect(audio.sources).toHaveLength(1);
    expect(audio.sources[0].connectedTo).toEqual([audio.context.destination]);
    expect(audio.sources[0].started).toBeGreaterThanOrEqual(0);
  });

  it('plays the whole selection in order, then goes back to idle', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);
    await player.load(
      [
        { surah: 1, verse: 1 },
        { surah: 1, verse: 2 },
      ],
      'alafasy',
    );

    await player.play();
    expect(audio.sources).toHaveLength(1);

    audio.sources[0].onended?.();
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[0].buffer).not.toBe(audio.sources[1].buffer);

    audio.sources[1].onended?.();
    expect(player.state).toBe('idle');
  });

  it('stops the current verse and replays without downloading again', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const fetchBytes = fakeFetch();
    const player = new PreviewPlayer(fetchBytes, audio.factory);
    await player.load([{ surah: 1, verse: 1 }], 'alafasy');
    await player.play();

    player.stop();

    expect(player.state).toBe('idle');
    expect(audio.sources[0].stopped).toBe(true);
    // An `onended` fired by the stop must not start the next verse.
    audio.sources[0].onended?.();
    expect(audio.sources).toHaveLength(1);

    await player.play();
    expect(player.state).toBe('playing');
    expect(fetchBytes).toHaveBeenCalledTimes(1);
  });

  it('rejects a failed download and stays idle instead of looking ready', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch('001002.mp3'), audio.factory);

    await expect(
      player.load(
        [
          { surah: 1, verse: 1 },
          { surah: 1, verse: 2 },
        ],
        'alafasy',
      ),
    ).rejects.toThrow(/404/);

    expect(player.state).toBe('idle');
    expect(player.loadedCount).toBe(0);
    await expect(player.play()).rejects.toThrow(/selection/i);
  });

  it('refuses to play before anything was loaded', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);

    await expect(player.play()).rejects.toThrow(/selection/i);
    expect(audio.sources).toHaveLength(0);
  });

  it('closes the audio context when the studio unmounts', async () => {
    const audio = fakeAudio();
    audio.unblock();
    const player = new PreviewPlayer(fakeFetch(), audio.factory);
    await player.load([{ surah: 1, verse: 1 }], 'alafasy');
    await player.play();

    player.dispose();

    expect(audio.context.close).toHaveBeenCalledOnce();
    expect(player.state).toBe('idle');
    expect(audio.sources[0].stopped).toBe(true);
  });
});
