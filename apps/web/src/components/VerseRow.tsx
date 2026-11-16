import type { Verse, VerseRef } from '@quran/core';

interface VerseRowProps {
  surah: number;
  verse: Verse;
  selected: boolean;
  onToggle: (ref: VerseRef) => void;
}

export function VerseRow({ surah, verse, selected, onToggle }: VerseRowProps) {
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
          aria-label={`Sélectionner le verset ${verse.number}`}
          className="mt-1 size-5 shrink-0 accent-sky-400"
        />
        <span className="min-w-0 flex-1">
          <span className="mb-1 block text-xs tabular-nums text-white/45">
            Verset {verse.number}
          </span>
          <span
            lang="ar"
            dir="rtl"
            className="block text-right text-2xl leading-loose text-white"
          >
            {verse.arabic}
          </span>
          <span lang="fr" className="mt-2 block text-sm leading-relaxed text-white/65">
            {verse.translations.fr}
          </span>
        </span>
      </label>
    </div>
  );
}
