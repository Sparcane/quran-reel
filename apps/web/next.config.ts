import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  // Do not advertise the framework. The remaining security headers are served
  // by the CDN from vercel.json, built from src/lib/headers.ts; a static export
  // ignores a `headers()` config in this file.
  poweredByHeader: false,
};

export default nextConfig;
