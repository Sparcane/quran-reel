'use client';

import { useCallback } from 'react';
import i18n from 'i18next';
import type { TOptions } from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import ar from '@/locales/ar.json';
import en from '@/locales/en.json';
import fr from '@/locales/fr.json';

/** The three languages the interface speaks. */
export type Locale = 'fr' | 'en' | 'ar';

export const LOCALES: readonly Locale[] = ['fr', 'en', 'ar'];
export const DEFAULT_LOCALE: Locale = 'fr';
export const LOCALE_STORAGE_KEY = 'quran-studio:locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'fr' || value === 'en' || value === 'ar';
}

/** Arabic is the only right-to-left language of the three. */
export function isRtl(locale: Locale): boolean {
  return locale === 'ar';
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      fr: { translation: fr },
      en: { translation: en },
      ar: { translation: ar },
    },
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    // Keys are flat ("library.title"), so the dots are part of the key, not a
    // path into nested objects.
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    // The app renders on the server first: no Suspense boundary to wait for.
    react: { useSuspense: false },
  });
}

/** The language the user picked, else the browser's, else French. */
export function detectLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) return stored;
    } catch {
      // Private mode: fall through to the browser language.
    }
  }

  const tag = typeof navigator === 'undefined' ? '' : navigator.language.slice(0, 2).toLowerCase();
  return isLocale(tag) ? tag : DEFAULT_LOCALE;
}

/** Mirrors the language onto `<html lang dir>`, which is what screen readers read. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtl(locale) ? 'rtl' : 'ltr';
}

/** Switches the whole interface and remembers the choice. */
export function setLocale(locale: Locale): void {
  void i18n.changeLanguage(locale);
  applyDocumentLocale(locale);
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode: the choice only lasts for the session.
  }
}

export function currentLocale(): Locale {
  return isLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
}

export type Translate = (key: string, values?: Record<string, unknown>) => string;

/** The translator every component uses: `const t = useT()`. */
export function useT(): Translate {
  const { t, i18n: instance } = useTranslation();
  return useCallback(
    // i18next types its options as a closed interface; every value the app
    // passes is a count or a number, which the catalogue interpolates.
    (key: string, values?: Record<string, unknown>) =>
      values === undefined ? t(key) : t(key, values as TOptions),
    // `instance.language` is the dependency that matters: it changes on switch.
    [t, instance.language],
  );
}

/** The active language, reactive: components re-render when it changes. */
export function useLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return isLocale(instance.language) ? instance.language : DEFAULT_LOCALE;
}
