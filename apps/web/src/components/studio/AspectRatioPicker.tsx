'use client';

import type { AspectRatio } from '@quran/core';
import { useT } from '@/lib/i18n';
import { useStudioStore } from '@/lib/studio-store';

const RATIOS: readonly { value: AspectRatio; labelKey: string }[] = [
  { value: '16:9', labelKey: 'studio.ratio.16x9' },
  { value: '9:16', labelKey: 'studio.ratio.9x16' },
  { value: '1:1', labelKey: 'studio.ratio.1x1' },
  { value: '4:5', labelKey: 'studio.ratio.4x5' },
];

export function AspectRatioPicker() {
  const t = useT();
  const aspectRatio = useStudioStore((state) => state.settings.aspectRatio);
  const patchSettings = useStudioStore((state) => state.patchSettings);

  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-white/80">
        {t('studio.aspectRatio.legend')}
      </legend>
      <div className="grid grid-cols-2 gap-2">
        {RATIOS.map(({ value, labelKey }) => (
          <label
            key={value}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
              aspectRatio === value
                ? 'border-sky-400/60 bg-sky-400/10 text-white'
                : 'border-white/15 bg-white/5 text-white/70 hover:bg-white/10'
            }`}
          >
            <input
              type="radio"
              name="studio-aspect-ratio"
              value={value}
              checked={aspectRatio === value}
              onChange={() => patchSettings({ aspectRatio: value })}
              className="size-4 accent-sky-400"
            />
            {t(labelKey)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
