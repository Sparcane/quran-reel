import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHeaders } from '../src/lib/headers';

// The test runner starts at the repository root; the Next build at apps/web.
const vercelPath = [
  join(process.cwd(), 'apps', 'web', 'vercel.json'),
  join(process.cwd(), 'vercel.json'),
].find((candidate) => existsSync(candidate));
if (!vercelPath) throw new Error('headers.test: cannot find vercel.json');

const vercelConfig = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};

describe('buildHeaders', () => {
  const h = buildHeaders();

  it('restricts script origins to the app itself', () => {
    expect(h['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('allows recitation audio from EveryAyah only', () => {
    expect(h['Content-Security-Policy']).toContain('https://everyayah.com');
    expect(h['Content-Security-Policy']).toContain(
      "media-src 'self' blob: https://everyayah.com",
    );
  });

  it('keeps video blobs playable and workers same-origin', () => {
    expect(h['Content-Security-Policy']).toContain("worker-src 'self' blob:");
  });

  it('locks the page into HTTPS and forbids framing and MIME sniffing', () => {
    expect(h['Strict-Transport-Security']).toContain('max-age=31536000');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sets a strict referrer policy and drops unused device features', () => {
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Permissions-Policy']).toContain('microphone=()');
  });

  it('keeps vercel.json in sync with the single source of truth', () => {
    const deployed = vercelConfig.headers[0].headers;
    expect(Object.keys(buildHeaders()).sort()).toEqual(deployed.map((entry) => entry.key).sort());
    for (const entry of deployed) {
      expect(entry.value).toBe(h[entry.key]);
    }
  });
});
