'use client';

import { useT } from '@/lib/i18n';
import { STUDIO_BOUNDS, useStudioStore } from '@/lib/studio-store';
import { NumberField } from '@/components/studio/NumberField';

export function ColorControls() {
  const t = useT();
  const settings = useStudioStore((state) => state.settings);
  const patchSettings = useStudioStore((state) => state.patchSettings);

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="studio-text-color" className="mb-1 block text-sm font-medium text-white/80">
          {t('studio.textColor')}
        </label>
        <div className="flex items-center gap-3">
          <input
            id="studio-text-color"
            type="color"
            value={settings.textColor}
            onChange={(event) => patchSettings({ textColor: event.target.value })}
            className="h-10 w-14 cursor-pointer rounded-lg border border-white/15 bg-white/5 p-1"
          />
          <span className="text-sm tabular-nums text-white/60">{settings.textColor}</span>
        </div>
      </div>

      <NumberField
        id="studio-overlay-opacity"
        label={t('studio.overlayOpacity')}
        value={settings.overlayOpacity}
        min={STUDIO_BOUNDS.overlayOpacity.min}
        max={STUDIO_BOUNDS.overlayOpacity.max}
        suffix="%"
        onChange={(overlayOpacity) => patchSettings({ overlayOpacity })}
      />
    </div>
  );
}
