/**
 * One source of truth for the public metadata and the site's canonical URL.
 *
 * A surah page is pre-rendered and can be reached from a search result, so its
 * title, description and canonical must be right before any JavaScript runs.
 * The base URL comes from the deployment environment; the default keeps local
 * builds and tests deterministic.
 */

import type { Metadata } from 'next';
import type { SurahMeta } from '@quran/core';

/** Used when the deployment has not set NEXT_PUBLIC_SITE_URL. */
export const DEFAULT_SITE_URL = 'https://quran-studio.vercel.app';

export const SITE_NAME = 'Quran Studio';

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The absolute origin of the public site, with no trailing slash. */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  return withoutTrailingSlash(configured && configured.length > 0 ? configured : DEFAULT_SITE_URL);
}

/** Builds the full metadata for one surah's reader page. */
export function buildSurahMetadata(surah: SurahMeta, baseUrl: string): Metadata {
  const canonical = `${withoutTrailingSlash(baseUrl)}/sourate/${surah.number}`;
  const title = `${surah.nameFr} — ${SITE_NAME}`;
  const description = `Sourate ${surah.number}, ${surah.nameFr} : ${surah.verseCount} versets de récitation coranique en texte uthmani avec traduction française, à lire et à mettre en vidéo.`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: SITE_NAME,
      locale: 'fr_FR',
      type: 'article',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  };
}
