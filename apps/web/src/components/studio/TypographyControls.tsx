'use client';

import type { Lang } from '@quran/core';
import { NumberField } from '@/components/studio/NumberField';
import { useT } from '@/lib/i18n';
import { STUDIO_BOUNDS, useStudioStore } from '@/lib/studio-store';

const MODES: readonly { value: 'verse' | 'word'; labelKey: string }[] = [
  { value: 'verse', labelKey: 'studio.subtitleMode.verse' },
  { value: 'word', labelKey: 'studio.subtitleMode.word' },
];

export function TypographyControls() {
  const t = useT();
  const settings = useStudioStore((state) => state.settings);
  const patchSettings = useStudioStore((state) => state.patchSettings);

  return (
    <div className="space-y-4">
      <NumberField
        id="studio-arabic-size"
        label={t('studio.arabicSize')}
        value={settings.arabicSize}
        min={STUDIO_BOUNDS.arabicSize.min}
        max={STUDIO_BOUNDS.arabicSize.max}
        suffix="px"
        onChange={(arabicSize) => patchSettings({ arabicSize })}
      />

      <NumberField
        id="studio-translation-size"
        label={t('studio.translationSize')}
        value={settings.translationSize}
        min={STUDIO_BOUNDS.translationSize.min}
        max={STUDIO_BOUNDS.translationSize.max}
        suffix="px"
        onChange={(translationSize) => patchSettings({ translationSize })}
      />

      <div className="flex items-start gap-3">
        <input
          id="studio-show-translation"
          type="checkbox"
          checked={settings.showTranslation}
          onChange={(event) => patchSettings({ showTranslation: event.target.checked })}
          className="mt-1 size-4 accent-sky-400"
        />
        <label htmlFor="studio-show-translation" className="text-sm font-medium text-white/80">
          {t('studio.showTranslation')}
        </label>
      </div>

      <div>
        <label
          htmlFor="studio-translation-lang"
          className="mb-1 block text-sm font-medium text-white/80"
        >
          {t('studio.translationLang')}
        </label>
        <select
          id="studio-translation-lang"
          value={settings.translationLang}
          onChange={(event) => patchSettings({ translationLang: event.target.value as Lang })}
          className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-base text-white focus-visible:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400"
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
        </select>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-white/80">
          {t('studio.subtitleMode.legend')}
        </legend>
        <div className="space-y-2">
          {MODES.map(({ value, labelKey }) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
              <input
                type="radio"
                name="studio-subtitle-mode"
                value={value}
                checked={settings.subtitleMode === value}
                onChange={() => patchSettings({ subtitleMode: value })}
                className="size-4 accent-sky-400"
              />
              {t(labelKey)}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
