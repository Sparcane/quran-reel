import type { Metadata } from 'next';
import { StudioShell } from '@/components/studio/StudioShell';

export const metadata: Metadata = {
  title: 'Studio — Quran Studio',
  description:
    'Choisissez le format, la typographie et les couleurs, puis rendez votre vidéo de récitation directement sur votre appareil.',
};

export default function StudioPage() {
  return <StudioShell />;
}
