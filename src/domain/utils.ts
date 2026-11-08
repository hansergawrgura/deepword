/** 通用工具函数：id、日期、随机、格式化。 */

import type { Locale } from '@/i18n/types';
import { DEFAULT_LOCALE } from '@/i18n/types';
import { createT } from '@/i18n/t';

let idCounter = 0;

export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 9);
  const time = Date.now().toString(36);
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}_${time}${idCounter.toString(36)}${rand}`;
}

export function dayKey(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function relativeTime(ts: number, now = Date.now(), locale: Locale = DEFAULT_LOCALE): string {
  const t = createT(locale);
  const diff = now - ts;
  if (diff < 60_000) return t('domain.relative.justNow');
  if (diff < 3_600_000) {
    return t('domain.relative.minutesAgo', { n: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return t('domain.relative.hoursAgo', { n: Math.floor(diff / 3_600_000) });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return t('domain.relative.yesterday');
  if (days < 30) return t('domain.relative.daysAgo', { n: days });
  const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Date(ts).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' });
}

export function formatDate(ts: number = Date.now(), locale: Locale = DEFAULT_LOCALE): string {
  const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Date(ts).toLocaleDateString(dateLocale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatMonthDay(ts: number, locale: Locale = DEFAULT_LOCALE): string {
  const dateLocale = locale === 'zh-CN' ? 'zh-CN' : 'en-US';
  return new Date(ts).toLocaleDateString(dateLocale, { month: '2-digit', day: '2-digit' });
}

export function weekdayName(ts: number = Date.now(), locale: Locale = DEFAULT_LOCALE): string {
  const t = createT(locale);
  const day = new Date(ts).getDay();
  return t(`domain.weekday.${day}` as 'domain.weekday.0');
}

export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function sample<T>(items: readonly T[], n: number): T[] {
  return shuffle(items).slice(0, Math.max(0, n));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!。！?？,，;；:：'"]+$/g, '')
    .trim();
}

/** @deprecated 使用 partOfSpeechLabel */
export function partOfSpeechZh(pos?: string): string {
  return partOfSpeechLabel(pos, 'zh-CN');
}

export function partOfSpeechLabel(pos?: string, locale: Locale = DEFAULT_LOCALE): string {
  if (!pos) return '';
  const t = createT(locale);
  const key = pos.trim().toLowerCase().replace(/\./g, '');
  const path = `domain.pos.${key}`;
  const label = t(path);
  return label === path ? pos : label;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function isLocalEndpoint(url: string): boolean {
  try {
    const hostname = new URL(url.trim()).hostname.toLowerCase();
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    );
  } catch {
    return false;
  }
}
