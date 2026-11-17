import type { Metadata } from 'next';
import { VerseList } from '@/components/VerseList';
import { buildSurahMetadata, siteUrl } from '@/lib/metadata';
import { readSurah, surahParams } from '@/lib/surah-data';

interface SouratePageProps {
  params: Promise<{ id: string }>;
}

// Every surah is a pre-rendered page: the app ships as a static export, so the
// reader must exist on disk before a user asks for it.
export function generateStaticParams() {
  return surahParams();
}

export async function generateMetadata({ params }: SouratePageProps): Promise<Metadata> {
  const { id } = await params;
  return buildSurahMetadata(readSurah(Number(id)), siteUrl());
}

export default async function SouratePage({ params }: SouratePageProps) {
  const { id } = await params;
  const surah = readSurah(Number(id));

  return <VerseList surah={surah} />;
}
