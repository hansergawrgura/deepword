/**
 * Single source for technical product IDs.
 * Change APP_ID (and related helpers) here — storage keys, backups, and download names follow.
 */

import { DATA_VERSION } from '@/domain/types';

export const APP_ID = 'dpdp-word';
export const APP_SLUG = 'dpdp-word';

export { DATA_VERSION };

export const STORAGE_KEY = `${APP_ID}:data:v${DATA_VERSION}` as const;

/** Previous product keys; cleared after migrate or reseed. */
export const LEGACY_STORAGE_KEYS = [
  'deepword:data',
  'deepword:data:v1',
  'deepword:data:v2',
  'deepword:data:v3',
] as const;

export const LEGACY_V3_STORAGE_KEY = 'deepword:data:v3' as const;

export const STORAGE_PROBE_KEY = `__${APP_ID}_probe__` as const;

export const BACKUP_APP = APP_ID;
export const BACKUP_SCHEME = `${APP_ID}-backup` as const;

export const LEGACY_BACKUP_APPS = ['deepword'] as const;
export const LEGACY_BACKUP_SCHEMES = ['deepword-backup'] as const;

export const ACTIVE_PROVIDER_FORM_NAME = `${APP_ID}-active-provider` as const;

export function downloadBackupName(date: string): string {
  return `${APP_ID}-backup-${date}.json`;
}

export function downloadWordlistName(date: string): string {
  return `${APP_ID}-wordlist-${date}.json`;
}

export function isAcceptedBackupApp(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return value === BACKUP_APP || (LEGACY_BACKUP_APPS as readonly string[]).includes(value);
}

export function isAcceptedBackupScheme(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return value === BACKUP_SCHEME || (LEGACY_BACKUP_SCHEMES as readonly string[]).includes(value);
}
