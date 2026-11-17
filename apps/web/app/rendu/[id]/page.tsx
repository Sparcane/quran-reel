import type { Metadata } from 'next';
import { RenduRoute } from '@/components/RenduRoute';

export const metadata: Metadata = {
  title: 'Rendu — Quran Studio',
  description: 'Suivez la progression de votre rendu, puis lisez et téléchargez votre vidéo.',
};

// A render id only exists on the device that created it, so there is nothing
// real to prerender. A static export still needs at least one param for a
// dynamic segment; the placeholder simply resolves to "not found" at runtime,
// and client navigation supplies the real id from the local queue store.
export function generateStaticParams() {
  return [{ id: '_' }];
}

export default function RenduPage() {
  return <RenduRoute />;
}
