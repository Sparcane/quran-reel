import { afterEach, describe, expect, it, vi } from 'vitest';
import { SURAH_META, type SurahMeta } from '@quran/core';
import robots from '../app/robots';
import sitemap from '../app/sitemap';
import { buildSurahMetadata, DEFAULT_SITE_URL, siteUrl } from '../src/lib/metadata';

const surah36 = SURAH_META.find((surah) => surah.number === 36) as SurahMeta;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildSurahMetadata', () => {
  it('titles the page with the surah name', () => {
    const m = buildSurahMetadata(surah36, 'https://quran.example');
    expect(m.title).toContain('Yâ-Sîn');
  });

  it('describes the recitation in French', () => {
    const m = buildSurahMetadata(surah36, 'https://quran.example');
    expect(m.description).toMatch(/récitation/i);
  });

  it('sets an absolute canonical built from the base URL', () => {
    const m = buildSurahMetadata(surah36, 'https://quran.example');
    expect(m.alternates?.canonical).toBe('https://quran.example/sourate/36');
  });

  it('carries the title into the Open Graph and Twitter cards', () => {
    const m = buildSurahMetadata(surah36, 'https://quran.example');
    expect(m.openGraph?.title).toContain('Yâ-Sîn');
    expect(m.twitter?.title).toContain('Yâ-Sîn');
    expect((m.twitter as { card?: string } | undefined)?.card).toBe('summary');
  });

  it('does not double the slash when the base URL ends with one', () => {
    const m = buildSurahMetadata(surah36, 'https://quran.example/');
    expect(m.alternates?.canonical).toBe('https://quran.example/sourate/36');
  });
});

describe('siteUrl', () => {
  it('uses NEXT_PUBLIC_SITE_URL when configured', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://mon-quran.example/');
    expect(siteUrl()).toBe('https://mon-quran.example');
  });

  it('falls back to a stable default when unset or empty', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(siteUrl()).toBe(DEFAULT_SITE_URL);
  });
});

describe('indexation', () => {
  it('lists the home page and all 114 surahs', () => {
    expect(sitemap()).toHaveLength(115);
  });

  it('starts the sitemap with the home page', () => {
    expect(sitemap()[0].url).toBe(DEFAULT_SITE_URL);
  });

  it('lets every crawler in and points to the sitemap', () => {
    expect(robots().rules).toContainEqual({ userAgent: '*', allow: '/' });
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}/sitemap.xml`);
  });
});
