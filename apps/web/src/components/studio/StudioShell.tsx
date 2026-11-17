'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { dimensionsFor } from '@quran/core';
import { AspectRatioPicker } from '@/components/studio/AspectRatioPicker';
import { BackgroundPicker } from '@/components/studio/BackgroundPicker';
import { ColorControls } from '@/components/studio/ColorControls';
import { DraftsMenu } from '@/components/studio/DraftsMenu';
import { GenerateButton } from '@/components/studio/GenerateButton';
import { HistoryList } from '@/components/HistoryList';
import { PreviewButton } from '@/components/studio/PreviewButton';
import { TypographyControls } from '@/components/studio/TypographyControls';
import { useT } from '@/lib/i18n';
import { buildRenderSpec } from '@/lib/render-spec';
import { startRender } from '@/lib/render-runtime';
import { adoptHandoffSelection, useStudioStore } from '@/lib/studio-store';

export interface StudioShellProps {
  /** Injected by the router shell; the fallback keeps unit rendering simple. */
  navigate?: (url: string) => void;
}

export function StudioShell({ navigate }: StudioShellProps) {
  const t = useT();
  const selection = useStudioStore((state) => state.selection);
  const settings = useStudioStore((state) => state.settings);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    try {
      const spec = await buildRenderSpec(selection, settings);
      const job = await startRender(spec);
      // A full load is required: a static export cannot route a dynamic id on
      // the client. The job is queued in IndexedDB, and the result page pumps
      // it there, so nothing is lost across the reload.
      (navigate ?? ((url: string) => window.location.assign(url)))(`/rendu/${job.id}/`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setGenerating(false);
    }
  }

  // The reader posts its selection once, then leaves. Taking it here (rather
  // than in an initialiser) keeps the first paint identical on the server.
  useEffect(() => {
    adoptHandoffSelection();
  }, []);

  const { width, height } = dimensionsFor(settings.aspectRatio);
  const count = selection.length;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">{t('studio.title')}</h1>
          <p aria-live="polite" className="mt-1 text-white/60">
            {count > 0
              ? t(count === 1 ? 'studio.verses.one' : 'studio.verses.other', { count })
              : null}
          </p>
        </div>
        <p className="text-sm tabular-nums text-muted">
          {width} × {height}
        </p>
      </header>

      <div className="mb-8">
        <DraftsMenu />
      </div>

      {count === 0 ? (
        <section className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
          <h2 className="text-xl font-semibold text-white">{t('studio.empty.title')}</h2>
          <p className="mx-auto mt-2 max-w-md text-white/65">{t('studio.empty.body')}</p>
          <Link
            href="/bibliotheque/"
            className="mt-6 inline-block rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-sky-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            {t('studio.empty.link')}
          </Link>
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <section aria-labelledby="studio-preview-title" className="rounded-2xl border border-white/10 bg-black/40 p-6">
            <h2 id="studio-preview-title" className="mb-4 text-lg font-semibold text-white">
              {t('studio.preview.title')}
            </h2>
            <div className="mx-auto w-full max-w-xs overflow-hidden rounded-xl shadow-lg">
              <div
                className="relative w-full"
                style={{
                  aspectRatio: `${width} / ${height}`,
                  backgroundImage:
                    settings.background.kind === 'gradient'
                      ? `linear-gradient(${settings.background.angle}deg, ${settings.background.from}, ${settings.background.to})`
                      : undefined,
                  backgroundColor: '#0b1026',
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{ backgroundColor: `rgba(0, 0, 0, ${settings.overlayOpacity / 100})` }}
                />
              </div>
            </div>
            <div className="mt-4">
              <PreviewButton />
            </div>
          </section>

          <form
            aria-labelledby="studio-settings-title"
            className="space-y-6 rounded-2xl border border-white/10 bg-white/5 p-5"
            onSubmit={(event) => event.preventDefault()}
          >
            <h2 id="studio-settings-title" className="text-lg font-semibold text-white">
              {t('studio.settings.title')}
            </h2>
            <AspectRatioPicker />
            <TypographyControls />
            <ColorControls />
            <BackgroundPicker />
            <GenerateButton
              onGenerate={() => void generate()}
              busy={generating}
              error={error}
            />
          </form>
        </div>
      )}

      <div className="mt-8">
        <HistoryList />
      </div>
    </main>
  );
}
