import type { Metadata } from 'next';
import type { SurahMeta } from '@quran/core';
import Bibliotheque from '@/components/Bibliotheque';
import index from '../../public/data/surahs-index.json';

export const metadata: Metadata = {
  title: 'Bibliothèque — Quran Studio',
  description:
    'Les 114 sourates du Coran : texte uthmani, traductions française et anglaise, récitations.',
};

export default function BibliothequePage() {
  return <Bibliotheque index={index as SurahMeta[]} />;
}
