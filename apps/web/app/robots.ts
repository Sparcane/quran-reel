import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/metadata';

// A static export cannot leave a metadata route dynamic.
export const dynamic = 'force-static';

/** Everything is public: no account, no paywall, no disallowed path. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
