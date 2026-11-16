'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { PreviewPlayer, type PreviewState } from '@/lib/preview-audio';
import { useStudioStore } from '@/lib/studio-store';

interface PreviewButtonProps {
  /** Injected by tests; the app builds the real player. */
  createPlayer?: () => PreviewPlayer;
}

/**
 * "Listen before you render": the preview exists so the user hears the reciter
 * before spending minutes on a video. When the browser refuses to start the
 * audio, the button says so and offers the click that fixes it — a preview that
 * silently does nothing is the worst outcome here.
 */
export function PreviewButton({ createPlayer }: PreviewButtonProps = {}) {
  const t = useT();
  const selection = useStudioStore((state) => state.selection);
  const reciterId = useStudioStore((state) => state.settings.reciterId);
  const playerRef = useRef<PreviewPlayer | null>(null);
  const [state, setState] = useState<PreviewState>('idle');
  const [failed, setFailed] = useState(false);

  useEffect(
    () => () => {
      // Release the audio device when the studio goes away.
      playerRef.current?.dispose();
    },
    [],
  );

  function player(): PreviewPlayer {
    playerRef.current ??= createPlayer ? createPlayer() : new PreviewPlayer();
    return playerRef.current;
  }

  async function start(): Promise<void> {
    setFailed(false);
    setState('loading');
    const current = player();
    try {
      await current.load(selection, reciterId);
      await current.play();
      setState(current.state);
    } catch {
      setState(current.state);
      setFailed(true);
    }
  }

  function stop(): void {
    playerRef.current?.stop();
    setState('idle');
  }

  const playing = state === 'playing';
  const loading = state === 'loading';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={playing ? stop : () => void start()}
        disabled={selection.length === 0 || loading}
        className="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        {playing
          ? t('studio.preview.stop')
          : loading
            ? t('studio.preview.loading')
            : t('studio.preview.listen')}
      </button>

      {state === 'blocked' ? (
        <div role="status" className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
          <p className="text-sm text-amber-200">{t('studio.preview.blocked')}</p>
          <button
            type="button"
            onClick={() => void start()}
            className="mt-2 rounded border border-amber-300/40 px-3 py-1.5 text-sm font-medium text-amber-100 transition-colors hover:bg-amber-400/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
          >
            {t('studio.preview.activate')}
          </button>
        </div>
      ) : null}

      {failed ? (
        <p role="alert" className="text-sm text-amber-300">
          {t('studio.preview.error')}
        </p>
      ) : null}
    </div>
  );
}
