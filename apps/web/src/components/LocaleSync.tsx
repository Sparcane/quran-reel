'use client';

import { useEffect } from 'react';
import { applyDocumentLocale, currentLocale, detectLocale, setLocale } from '@/lib/i18n';

/**
 * Applies the remembered language once the app is mounted. The server cannot
 * know it (the app ships as a static export), so the first paint is French and
 * this component switches right after hydration rather than changing the markup
 * the server produced.
 */
export function LocaleSync() {
  useEffect(() => {
    const stored = detectLocale();
    if (stored === currentLocale()) applyDocumentLocale(stored);
    else setLocale(stored);
  }, []);

  return null;
}
