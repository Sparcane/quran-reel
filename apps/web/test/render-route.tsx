// Renders the same React trees the three main routes serve, so the a11y and
// performance budgets measure what a user actually gets rather than a stand-in.
import { render } from '@testing-library/react';
import type { SurahData, SurahMeta } from '@quran/core';
import Bibliotheque from '@/components/Bibliotheque';
import { VerseList } from '@/components/VerseList';
import { StudioShell } from '@/components/studio/StudioShell';
import index from '../public/data/surahs-index.json';
import surah2 from '../public/data/surahs/002.json';

export const ROUTES = ['/bibliotheque', '/sourate/2', '/studio'] as const;
export type Route = (typeof ROUTES)[number];

export function renderRoute(page: Route) {
  switch (page) {
    case '/bibliotheque':
      return render(<Bibliotheque index={index as SurahMeta[]} />);
    case '/sourate/2':
      return render(<VerseList surah={surah2 as SurahData} />);
    case '/studio':
      return render(<StudioShell />);
  }
}
