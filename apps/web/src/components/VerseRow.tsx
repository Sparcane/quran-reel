'use client';

import type { Verse, VerseRef } from '@quran/core';
import { useLocale, useT } from '@/lib/i18n';

interface VerseRowProps {
  surah: number;
  verse: Verse;
  selected: boolean;
  onToggle: (ref: VerseRef) => void;
}

export function VerseRow({ surah, verse, selected, onToggle }: VerseRowProps) {
  const t = useT();
  const locale = useLocale();
  // The studio settings (Task 10) will let the user choose the translation
  // language explicitly; until then the reader follows the interface, and
  // Arabic falls back to French because there is no Arabic translation.
  const translationLang = locale === 'en' ? 'en' : 'fr';

  return (
    <div
      className={`rounded-xl border transition-colors ${
        selected ? 'border-sky-400/60 bg-sky-400/10' : 'border-white/10 bg-white/5'
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3 p-4">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle({ surah, verse: verse.number })}
          aria-label={t('reader.selectVerse', { number: verse.number })}
          className="mt-1 size-5 shrink-0 accent-sky-400"
        />
        <span className="min-w-0 flex-1">
          <span className="mb-1 block text-xs tabular-nums text-white/45">
            {t('reader.verse', { number: verse.number })}
          </span>
          <span
            lang="ar"
            dir="rtl"
            className="block text-right text-2xl leading-loose text-white"
          >
            {verse.arabic}
          </span>
          <span
            lang={translationLang}
            className="mt-2 block text-sm leading-relaxed text-white/65"
          >
            {verse.translations[translationLang]}
          </span>
        </span>
      </label>
    </div>
  );
}
