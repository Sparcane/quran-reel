'use client';

interface SurahSearchProps {
  value: string;
  onChange: (value: string) => void;
  count: number;
}

export function SurahSearch({ value, onChange, count }: SurahSearchProps) {
  return (
    <div className="mb-6">
      <label htmlFor="surah-search" className="mb-2 block text-sm font-medium text-white/80">
        Rechercher une sourate
      </label>
      <input
        id="surah-search"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Nom, numéro, arabe…"
        autoComplete="off"
        className="w-full rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-base text-white placeholder:text-white/50 focus-visible:border-sky-400 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sky-400"
      />
      <p aria-live="polite" className="mt-2 text-sm text-white/60">
        {count} sourate{count === 1 ? '' : 's'}
      </p>
    </div>
  );
}
