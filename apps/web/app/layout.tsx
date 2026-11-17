import type { Metadata } from 'next';
import { LocaleSync } from '@/components/LocaleSync';
import { siteUrl } from '@/lib/metadata';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: 'Quran Studio',
  description: 'Créez de belles vidéos de récitation coranique, directement sur votre appareil.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" dir="ltr">
      <body>
        <LocaleSync />
        {children}
      </body>
    </html>
  );
}
