'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { dimensionsFor } from '@quran/core';
import { AspectRatioPicker } from '@/components/studio/AspectRatioPicker';
import { BackgroundPicker } from '@/components/studio/BackgroundPicker';
import { ColorControls } from '@/components/studio/ColorControls';
import { PreviewButton } from '@/components/studio/PreviewButton';
import { TypographyControls } from '@/components/studio/TypographyControls';
import { useT } from '@/lib/i18n';
import { adoptHandoffSelection, useStudioStore } from '@/lib/studio-store';

export function StudioShell() {
  const t = useT();
  const selection = useStudioStore((state) => state.selection);
  const settings = useStudioStore((state) => state.settings);

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
        <p className="text-sm tabular-nums text-white/45">
          {width} × {height}
        </p>
      </header>

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
          </form>
        </div>
      )}
    </main>
  );
}
