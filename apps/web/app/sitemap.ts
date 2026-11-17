import type { MetadataRoute } from 'next';
import { SURAH_META } from '@quran/core';
import { siteUrl } from '@/lib/metadata';

// A static export cannot leave a metadata route dynamic.
export const dynamic = 'force-static';

/** The home page plus one entry per surah: 115 URLs in a stable order. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();

  return [
    {
      url: base,
      lastModified: now,
      changeFrequency: 'weekly',
      priority: 1,
    },
    ...SURAH_META.map((surah) => ({
      url: `${base}/sourate/${surah.number}`,
      lastModified: now,
      changeFrequency: 'monthly' as const,
      priority: 0.8,
    })),
  ];
}
