'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import type { SurahMeta } from '@quran/core';
import { SurahCard } from '@/components/SurahCard';
import { SurahSearch } from '@/components/SurahSearch';
import { useT } from '@/lib/i18n';
import { filterSurahs } from '@/lib/surahs';

export default function Bibliotheque({ index }: { index: readonly SurahMeta[] }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => filterSurahs(index, deferredQuery), [index, deferredQuery]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-white">{t('library.title')}</h1>
      <p className="mt-2 mb-8 text-white/65">{t('library.subtitle')}</p>

      <SurahSearch value={query} onChange={setQuery} count={results.length} />

      {results.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-white/5 p-6 text-white/70">
          {t('library.empty')}
        </p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((surah) => (
            <SurahCard key={surah.number} surah={surah} />
          ))}
        </ul>
      )}
    </main>
  );
}
