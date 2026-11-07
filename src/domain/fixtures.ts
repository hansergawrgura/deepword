/** 测试与种子数据用的最小 AppData 工厂。 */

import type { AppData } from './types';
import { DATA_VERSION, DEFAULT_PRACTICE_SETTINGS } from './types';

export function emptyAppData(overrides: Partial<AppData> = {}): AppData {
  const now = Date.now();
  return {
    version: DATA_VERSION,
    words: [],
    providers: [],
    activeProviderId: null,
    practice: DEFAULT_PRACTICE_SETTINGS,
    session: null,
    mastery: {},
    attempts: [],
    mistakes: {},
    theme: 'light',
    stats: { daily: {} },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
