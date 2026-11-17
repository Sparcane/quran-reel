'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { shareVideo, type ShareResult } from '@/lib/share';

export interface ShareButtonProps {
  file: File;
  title: string;
  /** Notified of every outcome, including a quiet cancellation. */
  onResult?: (result: ShareResult) => void;
  className?: string;
}

/**
 * Shares a finished video with a download fallback. A cancelled share sheet is
 * not an error: the button simply returns to rest. A genuine failure is shown
 * honestly instead of being reported as success.
 */
export function ShareButton({ file, title, onResult, className }: ShareButtonProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<ShareResult | null>(null);

  async function share() {
    setBusy(true);
    setError(false);
    setStatus(null);
    try {
      const result = await shareVideo(file, title);
      if (result !== 'cancelled') setStatus(result);
      onResult?.(result);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => {
          void share();
        }}
        disabled={busy}
        className={
          className ??
          'rounded-lg border border-sky-400/40 px-4 py-2.5 text-sm font-semibold text-sky-200 transition-colors hover:bg-sky-400/10 disabled:cursor-wait disabled:opacity-50'
        }
      >
        {t('share.button')}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-rose-200">
          {t('share.error')}
        </p>
      ) : null}
      {status ? (
        <p aria-live="polite" className="text-sm text-white/60">
          {status === 'shared' ? t('share.shared') : t('share.downloaded')}
        </p>
      ) : null}
    </div>
  );
}
