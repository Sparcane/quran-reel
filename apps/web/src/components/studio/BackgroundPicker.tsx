'use client';

import { useRef, useState } from 'react';
import type { GradientSelection } from '@quran/core';
import { useLocale, useT } from '@/lib/i18n';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  MAX_SOURCE_SECONDS,
  MAX_VIDEO_BYTES,
  validateBackgroundFile,
} from '@/lib/import-background';
import { useStudioStore } from '@/lib/studio-store';
import { deleteBackgroundAsset, saveBackgroundAsset } from '@/lib/storage';

/** The gradients that ship with the app: no file, no network, no licence. */
const PRESETS: readonly { key: string; background: GradientSelection }[] = [
  {
    key: 'studio.background.preset.night',
    background: { kind: 'gradient', from: '#0b1026', to: '#1e3a5f', angle: 135, motion: true },
  },
  {
    key: 'studio.background.preset.dusk',
    background: { kind: 'gradient', from: '#2b1055', to: '#c2477b', angle: 115, motion: true },
  },
  {
    key: 'studio.background.preset.sand',
    background: { kind: 'gradient', from: '#2a2117', to: '#a9814f', angle: 160, motion: false },
  },
];

const ERROR_KEYS: Record<string, string> = {
  type: 'studio.background.error.type',
  codec: 'studio.background.error.codec',
  empty: 'studio.background.error.empty',
  size: 'studio.background.error.size',
  dimensions: 'studio.background.error.dimensions',
  duration: 'studio.background.error.duration',
  storage: 'studio.background.error.storage',
};

/**
 * The limits the messages quote, read from the module that enforces them so a
 * change of bound cannot leave a reassuring message behind.
 */
const LIMITS = {
  imageMb: Math.round(MAX_IMAGE_BYTES / (1024 * 1024)),
  videoMb: Math.round(MAX_VIDEO_BYTES / (1024 * 1024)),
  side: MAX_IMAGE_SIDE,
  megapixels: Math.round(MAX_IMAGE_PIXELS / (1024 * 1024)),
  minutes: Math.round(MAX_SOURCE_SECONDS / 60),
};

function sameGradient(a: GradientSelection, b: GradientSelection): boolean {
  return a.from === b.from && a.to === b.to && a.angle === b.angle;
}

export function BackgroundPicker() {
  const t = useT();
  const locale = useLocale();
  const background = useStudioStore((state) => state.settings.background);
  const patchSettings = useStudioStore((state) => state.patchSettings);
  const fileInput = useRef<HTMLInputElement>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [loopSec, setLoopSec] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  async function importFile(file: File): Promise<void> {
    setImporting(true);
    setErrorKey(null);
    setLoopSec(null);
    try {
      const check = await validateBackgroundFile(file);
      if (!check.ok) {
        setErrorKey(ERROR_KEYS[check.reason] ?? ERROR_KEYS.type);
        return;
      }
      const assetId = await saveBackgroundAsset(file, file.name);
      patchSettings({ background: { kind: check.kind, assetId, name: file.name } });
      // A long clip is looped on the frames the renderer can hold; the user
      // learns it while importing, not when the film comes out.
      setLoopSec(check.kind === 'video' ? (check.loopSec ?? null) : null);
    } catch {
      // Storage refused the file (quota, private mode): say so instead of
      // silently keeping the old background.
      setErrorKey(ERROR_KEYS.storage);
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function removeImported(): void {
    if (background.kind === 'gradient') return;
    const { assetId } = background;
    patchSettings({ background: PRESETS[0].background });
    setLoopSec(null);
    // The bytes are only kept while a draft refers to them.
    void deleteBackgroundAsset(assetId);
  }

  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium text-white/80">
        {t('studio.background.legend')}
      </legend>

      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map(({ key, background: preset }) => {
          const checked =
            background.kind === 'gradient' && sameGradient(background, preset);
          return (
            <label
              key={key}
              className={`cursor-pointer rounded-lg border p-2 text-center text-xs transition-colors ${
                checked
                  ? 'border-sky-400/60 bg-sky-400/10 text-white'
                  : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'
              }`}
            >
              <input
                type="radio"
                name="studio-background-preset"
                value={key}
                checked={checked}
                onChange={() => {
                  setErrorKey(null);
                  setLoopSec(null);
                  patchSettings({ background: preset });
                }}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="mb-2 block h-10 w-full rounded"
                style={{
                  backgroundImage: `linear-gradient(${preset.angle}deg, ${preset.from}, ${preset.to})`,
                }}
              />
              {t(key)}
            </label>
          );
        })}
      </div>

      <div>
        <label
          htmlFor="studio-background-file"
          className="mb-1 block text-sm font-medium text-white/80"
        >
          {t('studio.background.import')}
        </label>
        <input
          ref={fileInput}
          id="studio-background-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,video/mp4"
          disabled={importing}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
          }}
          className="block w-full cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/70 file:mr-3 file:rounded file:border-0 file:bg-sky-500 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-slate-950"
        />
        <p className="mt-1 text-xs text-muted">
          {t('studio.background.hint', LIMITS)}
        </p>
        {loopSec !== null ? (
          <p
            role="status"
            className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/70"
          >
            {t('studio.background.loop', {
              // One decimal is enough; the separator follows the language and
              // the digits stay Latin, like the limits quoted above.
              seconds: new Intl.NumberFormat(`${locale}-u-nu-latn`, {
                maximumFractionDigits: 1,
              }).format(loopSec),
            })}
          </p>
        ) : null}
      </div>

      {background.kind !== 'gradient' ? (
        <p className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/70">
          <span className="truncate">
            {t('studio.background.current', { name: background.name })}
          </span>
          <button
            type="button"
            onClick={removeImported}
            className="shrink-0 rounded border border-white/20 px-2 py-1 text-xs text-white/70 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            {t('studio.background.remove')}
          </button>
        </p>
      ) : null}

      {errorKey ? (
        <p role="alert" className="text-sm text-amber-300">
          {t(errorKey, LIMITS)}
        </p>
      ) : null}
    </fieldset>
  );
}
