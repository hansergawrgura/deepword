import { STORAGE_KEY } from '@/app/identity';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from './types';

/** Read locale from persisted app data (usable outside React, e.g. ErrorBoundary). */
export function readPersistedLocale(): Locale {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_LOCALE;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LOCALE;
    const parsed = JSON.parse(raw) as { locale?: unknown };
    return normalizeLocale(parsed?.locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}
