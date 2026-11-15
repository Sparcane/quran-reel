import Link from 'next/link';
import type { SurahMeta } from '@quran/core';

export function SurahCard({ surah }: { surah: SurahMeta }) {
  return (
    <li>
      <Link
        href={`/sourate/${surah.number}/`}
        className="flex h-full items-center gap-4 rounded-xl border border-white/10 bg-white/5 p-4 transition-colors hover:border-white/25 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-sm tabular-nums text-white/70"
        >
          {surah.number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-medium text-white">{surah.nameFr}</span>
          <span className="block text-sm text-white/60">
            {surah.revelation === 'meccan' ? 'Mecquoise' : 'Médinoise'} · {surah.verseCount}{' '}
            versets
          </span>
        </span>
        <span lang="ar" dir="rtl" className="shrink-0 text-xl text-white/90">
          {surah.nameAr}
        </span>
      </Link>
    </li>
  );
}
