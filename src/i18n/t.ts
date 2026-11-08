import { en } from './catalogs/en';
import { zhCN } from './catalogs/zh-CN';
import {
  DEFAULT_LOCALE,
  type Locale,
  type MessageParams,
  type MessageTree,
  type TranslateFn,
} from './types';

export type { MessageTree };

const CATALOGS: Record<Locale, MessageTree> = {
  en,
  'zh-CN': zhCN,
};

function getPath(tree: unknown, path: string): string | undefined {
  const parts = path.split('.');
  let current: unknown = tree;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? `{${key}}` : String(value);
  });
}

export function createT(locale: Locale = DEFAULT_LOCALE): TranslateFn {
  const primary = CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
  const fallback = CATALOGS[DEFAULT_LOCALE];
  return (key, params) => {
    const raw = getPath(primary, key) ?? getPath(fallback, key) ?? key;
    return interpolate(raw, params);
  };
}

export function getCatalog(locale: Locale = DEFAULT_LOCALE): MessageTree {
  return CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE];
}
