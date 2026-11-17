'use client';

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { RenderJob } from '@quran/render';
import { useT } from '@/lib/i18n';

/** A blob URL, revoked when the job changes or the page leaves. */
function useObjectUrl(blob: Blob | undefined): string {
  const [url, setUrl] = useState('');

  useEffect(() => {
    // jsdom (and a few WebViews) has no object URLs; the player still renders,
    // it simply has nothing to point at until a real browser mounts it.
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setUrl('');
      return;
    }
    const created = URL.createObjectURL(blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [blob]);

  return url;
}

export interface RenduPageProps {
  /** `null` means there is no such job — a 404, never a fake success. */
  job: RenderJob | null;
  /** Offered on failed and cancelled jobs; hidden when the caller has no retry. */
  onRetry?: () => void;
}

/**
 * The three honest states of a render. The original app showed "Vidéo prête"
 * for an unknown id; here an unknown job is a real 404 and a failed job says so.
 */
export function RenduPage({ job, onRetry }: RenduPageProps) {
  const t = useT();
  const videoBlob = job?.status === 'done' ? job.result?.blob : undefined;
  const url = useObjectUrl(videoBlob);

  if (job === null) notFound();

  const retry =
    onRetry && job && (job.status === 'failed' || job.status === 'cancelled') ? (
      <button
        type="button"
        onClick={onRetry}
        className="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400"
      >
        {t('rendu.retry')}
      </button>
    ) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-white">{t('rendu.title')}</h1>

      {job?.status === 'queued' ? (
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-8">
          <p className="text-white/80" aria-live="polite">
            {t('rendu.queued')}
          </p>
        </section>
      ) : null}

      {job?.status === 'running' ? (
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-8">
          <p className="text-white/80" aria-live="polite">
            {job.progress} % — {t('rendu.rendering')}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={job.progress}
            className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/10"
          >
            <div
              className="h-full rounded-full bg-sky-400 transition-[width]"
              style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }}
            />
          </div>
        </section>
      ) : null}

      {job?.status === 'failed' ? (
        <section className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-8">
          <h2 className="text-lg font-semibold text-white">{t('rendu.failed')}</h2>
          <p className="mt-2 break-words text-rose-100/90">{job.error ?? t('rendu.failed.unknown')}</p>
          {retry ? <div className="mt-6">{retry}</div> : null}
        </section>
      ) : null}

      {job?.status === 'cancelled' ? (
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-8">
          <h2 className="text-lg font-semibold text-white">{t('rendu.cancelled')}</h2>
          {retry ? <div className="mt-6">{retry}</div> : null}
        </section>
      ) : null}

      {job?.status === 'done' && job.result ? (
        <section className="mt-8 rounded-2xl border border-white/10 bg-white/5 p-6">
          <video
            role="video"
            controls
            playsInline
            src={url || undefined}
            aria-label={t('rendu.player')}
            className="mx-auto w-full max-h-[70vh] rounded-xl bg-black"
          />
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Link
              href={url || '#'}
              download={`quran-${job.id}.${job.result.container}`}
              className="inline-block rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400"
            >
              {t('rendu.download')}
            </Link>
            <p className="text-sm text-white/55">
              {job.result.width} × {job.result.height} · {job.result.durationSec.toFixed(1)} s ·{' '}
              {job.result.container.toUpperCase()}
            </p>
          </div>
        </section>
      ) : null}

      <p className="mt-8 text-sm text-white/50">
        <Link href="/studio/" className="underline underline-offset-2 hover:text-white">
          {t('rendu.back')}
        </Link>
      </p>
    </main>
  );
}
