import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quran Studio',
  description: 'Créez de belles vidéos de récitation coranique, directement sur votre appareil.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
