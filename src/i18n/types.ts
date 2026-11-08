export const LOCALES = ['en', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-CN';
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export type MessageParams = Record<string, string | number>;

export type MessageTree = {
  readonly [key: string]: string | MessageTree;
};

export type TranslateFn = (key: string, params?: MessageParams) => string;
