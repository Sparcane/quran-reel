import type { Metadata } from 'next';
import { StudioRoute } from '@/components/studio/StudioRoute';

export const metadata: Metadata = {
  title: 'Studio — Quran Studio',
  description:
    'Choisissez le format, la typographie et les couleurs, puis rendez votre vidéo de récitation directement sur votre appareil.',
};

export default function StudioPage() {
  return <StudioRoute />;
}
