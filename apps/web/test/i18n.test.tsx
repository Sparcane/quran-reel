import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SurahMeta } from '@quran/core';
import Bibliotheque from '../src/components/Bibliotheque';
import { LocaleSync } from '../src/components/LocaleSync';
import ar from '../src/locales/ar.json';
import en from '../src/locales/en.json';
import fr from '../src/locales/fr.json';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  detectLocale,
  setLocale,
} from '../src/lib/i18n';
import index from '../public/data/surahs-index.json';

const surahs = index as SurahMeta[];
type TestLocale = 'fr' | 'en' | 'ar';
const files: Record<TestLocale, Record<string, string>> = { fr, en, ar };

function renderWithLocale(locale: TestLocale) {
  setLocale(locale);
  return render(<Bibliotheque index={surahs} />);
}

function setNavigatorLanguage(language: string) {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
}

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
  window.localStorage.clear();
});

describe('i18n', () => {
  it('shows the library in french by default', () => {
    expect(renderWithLocale('fr').getByText('Bibliothèque')).toBeInTheDocument();
  });

  it('switches the library to english', () => {
    expect(renderWithLocale('en').getByText('Library')).toBeInTheDocument();
  });

  it('switches the library to arabic and flips the document to rtl', () => {
    const view = renderWithLocale('ar');

    expect(view.getByText('المكتبة')).toBeInTheDocument();
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
  });

  it('puts the document back to ltr for a latin language', () => {
    renderWithLocale('ar');
    renderWithLocale('fr');

    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('fr');
  });

  it('gives the three locale files exactly the same keys, none of them empty', () => {
    const [frKeys, enKeys, arKeys] = (['fr', 'en', 'ar'] as const).map((locale) =>
      Object.keys(files[locale]).sort(),
    );

    expect(enKeys).toEqual(frKeys);
    expect(arKeys).toEqual(frKeys);
    for (const locale of ['fr', 'en', 'ar'] as const) {
      for (const [key, value] of Object.entries(files[locale])) {
        expect(`${locale}.${key}: ${value}`).not.toMatch(/:\s*$/);
      }
    }
  });

  it('has no key used by the app missing from a locale file', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(['apps/web/src', 'apps/web/app'])) {
      for (const key of keysUsedIn(readFileSync(file, 'utf8'))) used.add(key);
    }

    // Every key the components ask for, including the two branches of the
    // `t(count === 1 ? '…one' : '…other')` calls, must exist in all three files.
    expect(used.size).toBeGreaterThan(15);
    for (const locale of ['fr', 'en', 'ar'] as const) {
      expect(Object.keys(files[locale])).toEqual(expect.arrayContaining([...used]));
    }
  });

  it('follows the browser when nothing is stored', () => {
    window.localStorage.clear();
    setNavigatorLanguage('ar-EG');
    expect(detectLocale()).toBe('ar');

    setNavigatorLanguage('en-GB');
    expect(detectLocale()).toBe('en');

    setNavigatorLanguage('de-DE');
    expect(detectLocale()).toBe('fr');
  });

  it('prefers the language the user picked over the browser one', () => {
    setNavigatorLanguage('en-US');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    expect(detectLocale()).toBe('ar');
  });

  it('applies the stored language to the document on mount', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');

    render(<LocaleSync />);

    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
  });
});

function sourceFiles(dirs: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

/**
 * Every catalogue key passed to a `t('…')` call in one file. The argument is
 * read up to its closing parenthesis so that both branches of
 * `t(count === 1 ? 'a.one' : 'a.other', { count })` are counted, not just the
 * first one.
 */
function keysUsedIn(source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(/(?<![\w$.])t\(/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      else if (char === "'") {
        const end = source.indexOf("'", index + 1);
        if (end === -1) break;
        const literal = source.slice(index + 1, end);
        if (/^[a-z][\w]*(\.[\w]+)+$/i.test(literal)) keys.push(literal);
        index = end;
      }
      index += 1;
    }
  }
  return keys;
}
