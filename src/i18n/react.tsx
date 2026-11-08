import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createT } from './t';
import { DEFAULT_LOCALE, type Locale, type TranslateFn } from './types';

interface I18nContextValue {
  locale: Locale;
  t: TranslateFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale = DEFAULT_LOCALE,
  children,
}: {
  locale?: Locale;
  children: ReactNode;
}) {
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: createT(locale),
    }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

export function useT(): TranslateFn {
  return useI18n().t;
}

export function useLocale(): Locale {
  return useI18n().locale;
}
