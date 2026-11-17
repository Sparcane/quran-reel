/**
 * The single source of truth for the studio's security headers.
 *
 * Everything runs on the device and no account exists, but the page still
 * loads recitation audio from EveryAyah and creates video blobs, so the CSP has
 * to be precise enough to allow those and nothing else. Next's static export
 * serves the built HTML from a CDN, where `next.config` headers do not apply;
 * `vercel.json` carries the same values, and the test keeps the two in sync.
 * The Electron packaging plan reuses `buildHeaders()` for its own CSP.
 */

/** The only third party the browser may contact: the recitation CDN. */
export const RECITATION_ORIGIN = 'https://everyayah.com';

export function buildHeaders(): Record<string, string> {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // A static Next export ships inline bootstrap scripts and styles; nonces
    // cannot be added after the fact, so inline is allowed from the app itself.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `media-src 'self' blob: ${RECITATION_ORIGIN}`,
    "font-src 'self' data:",
    `connect-src 'self' ${RECITATION_ORIGIN}`,
    "worker-src 'self' blob:",
    "form-action 'self'",
  ].join('; ');

  return {
    'Content-Security-Policy': csp,
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  };
}
