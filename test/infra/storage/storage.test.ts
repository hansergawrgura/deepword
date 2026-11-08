import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_APP,
  BACKUP_SCHEME,
  DATA_VERSION,
  LEGACY_STORAGE_KEYS,
  LEGACY_V3_STORAGE_KEY,
  STORAGE_KEY,
} from '@/app/identity';
import { SEED_WORDS } from '@/data/wordbanks';
import { MAX_REVIEW_WORDS, MIN_REVIEW_WORDS } from '@/domain/rounds';
import { DEFAULT_PRACTICE_SETTINGS } from '@/domain/types';
import {
  clearStoredData,
  createInitialData,
  exportBackup,
  hydrateData,
  importBackup,
  loadData,
  normalizePracticeSettings,
  saveData,
} from '@/infra/storage/storage';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

interface LocalStorageHandle {
  store: Map<string, string>;
}

const restorers: Array<() => void> = [];

function withLocalStorage(): LocalStorageHandle {
  const store = new Map<string, string>();
  const fake = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  } as unknown as Storage;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { localStorage: fake },
  });
  restorers.push(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { store };
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

describe('createInitialData', () => {
  it('用内置词库生成单词，providers 为空，默认练习设置', () => {
    const data = createInitialData(NOW);
    expect(data.version).toBe(DATA_VERSION);
    expect(data.words.length).toBe(SEED_WORDS.length);
    expect(data.words.length).toBeGreaterThan(0);
    expect(data.providers).toEqual([]);
    expect(data.activeProviderId).toBeNull();
    expect(data.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(data.attempts).toEqual([]);
    expect(data.mistakes).toEqual({});
    expect(data.stats.daily).toEqual({});
    expect(data.theme).toBe('light');
  });
});

describe('saveData / loadData', () => {
  it('读写 v3 键', () => {
    const { store } = withLocalStorage();
    const seed = createInitialData(NOW);
    seed.words = seed.words.slice(0, 2);
    expect(saveData(seed).ok).toBe(true);
    const written = JSON.parse(store.get(STORAGE_KEY) ?? 'null');
    expect(written.version).toBe(3);

    const loaded = loadData(NOW);
    expect(loaded.warning).toBeUndefined();
    expect(loaded.data.words).toHaveLength(2);
    expect(loaded.data.version).toBe(3);
  });

  it('无当前键时清除旧键并写入新数据', () => {
    const { store } = withLocalStorage();
    store.set('deepword:data:v2', JSON.stringify({ version: 2, words: [] }));
    store.set('deepword:data:v1', '{}');

    const result = loadData(NOW);
    expect(result.data.version).toBe(3);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    expect(store.has('deepword:data:v2')).toBe(false);
    expect(store.has('deepword:data:v1')).toBe(false);
    expect(store.has(STORAGE_KEY)).toBe(true);
  });

  it('从 deepword:data:v3 迁移到当前键并清除 legacy', () => {
    const { store } = withLocalStorage();
    const seed = createInitialData(NOW);
    seed.words = seed.words.slice(0, 3);
    store.set(LEGACY_V3_STORAGE_KEY, JSON.stringify(seed));
    store.set('deepword:data:v2', '{}');

    const result = loadData(NOW);
    expect(result.warning).toBeUndefined();
    expect(result.data.words).toHaveLength(3);
    expect(store.has(STORAGE_KEY)).toBe(true);
    expect(store.has(LEGACY_V3_STORAGE_KEY)).toBe(false);
    expect(store.has('deepword:data:v2')).toBe(false);
    const written = JSON.parse(store.get(STORAGE_KEY) ?? 'null');
    expect(written.words).toHaveLength(3);
  });

  it('当前键内版本不对时清除旧键并重建', () => {
    const { store } = withLocalStorage();
    store.set('deepword:data:v2', '{}');
    store.set(STORAGE_KEY, JSON.stringify({ version: 2, words: [{ id: 'w1', term: 'x', meaning: 'y' }] }));

    const result = loadData(NOW);
    expect(result.warning).toMatch(/version mismatch|版本不匹配/i);
    expect(result.data.version).toBe(3);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    expect(store.has('deepword:data:v2')).toBe(false);
  });
});

describe('clearStoredData', () => {
  it('删除 v3 与全部旧键', () => {
    const { store } = withLocalStorage();
    store.set(STORAGE_KEY, '{}');
    for (const key of LEGACY_STORAGE_KEYS) store.set(key, '{}');
    clearStoredData();
    expect(store.has(STORAGE_KEY)).toBe(false);
    for (const key of LEGACY_STORAGE_KEYS) {
      expect(store.has(key)).toBe(false);
    }
  });
});

describe('normalizePracticeSettings', () => {
  it('clamps reviewWordsPerRound to domain 4–6 (not legacy 1–12)', () => {
    expect(normalizePracticeSettings({ reviewWordsPerRound: 1 }).reviewWordsPerRound).toBe(
      MIN_REVIEW_WORDS,
    );
    expect(normalizePracticeSettings({ reviewWordsPerRound: 12 }).reviewWordsPerRound).toBe(
      MAX_REVIEW_WORDS,
    );
    expect(normalizePracticeSettings({ reviewWordsPerRound: 5 }).reviewWordsPerRound).toBe(5);
  });

  it('keeps reviewQuestionsPerRound inside [words, 2×words]', () => {
    const settings = normalizePracticeSettings({
      reviewWordsPerRound: 4,
      reviewQuestionsPerRound: 20,
    });
    expect(settings.reviewWordsPerRound).toBe(4);
    expect(settings.reviewQuestionsPerRound).toBe(8);
  });
});

describe('importBackup', () => {
  it('接受 v3 包装与裸 v3 数据', () => {
    const data = createInitialData(NOW);
    const wrapped = JSON.parse(exportBackup(data));
    expect(wrapped.app).toBe(BACKUP_APP);
    expect(wrapped.scheme).toBe(BACKUP_SCHEME);
    const fromWrapper = importBackup(exportBackup(data));
    expect(fromWrapper.version).toBe(3);
    expect(fromWrapper.words.length).toBe(data.words.length);

    const bare = JSON.stringify({ ...data, version: 3 });
    expect(importBackup(bare).words.length).toBe(data.words.length);
  });

  it('接受旧 deepword 备份标识', () => {
    const data = createInitialData(NOW);
    const legacy = JSON.stringify({
      app: 'deepword',
      scheme: 'deepword-backup',
      version: 3,
      data: { ...data, version: 3 },
    });
    expect(importBackup(legacy).words.length).toBe(data.words.length);
  });

  it('拒绝非 v3 备份', () => {
    const v2 = JSON.stringify({
      app: 'deepword',
      scheme: 'deepword-backup',
      version: 2,
      data: { version: 2, words: [{ id: 'w1', term: 'a', meaning: 'b', createdAt: NOW }] },
    });
    expect(() => importBackup(v2)).toThrow(/v3|版本 3/);

    const bareV2 = JSON.stringify({
      version: 2,
      words: [{ id: 'w1', term: 'a', meaning: 'b', createdAt: NOW }],
    });
    expect(() => importBackup(bareV2)).toThrow(/v3|版本 3/);
  });
});

describe('hydrateData', () => {
  it('非 v3 版本抛错', () => {
    expect(() =>
      hydrateData(
        { version: 2, words: [{ id: 'w1', term: 'a', meaning: 'b', createdAt: NOW }] },
        { now: NOW },
      ),
    ).toThrow(/version 3|数据版本 3/i);
  });
});
