export { LOCALES, DEFAULT_LOCALE, isLocale, normalizeLocale } from './types';
export type { Locale, MessageParams, TranslateFn } from './types';
export { createT, getCatalog, interpolate } from './t';
export type { MessageTree } from './t';
export { I18nProvider, useI18n, useT, useLocale } from './react';
