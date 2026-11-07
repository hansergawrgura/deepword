import { describe, expect, it } from 'vitest';
import type { AppData } from '../types';
import { DATA_VERSION } from '../types';
import { SEED_WORDS } from '../data/wordbank';
import {
  DEFAULT_LLM_SETTINGS,
  createInitialData,
  exportBackup,
  getStorageUsage,
  hydrateData,
  loadData,
  makeWord,
  normalizeWord,
  parseBackup,
  resetProgress,
  saveData,
  seedWordId,
  storageAvailable,
} from './storage';
import { createCard, gradeCard } from './srs';
import { dayKey } from './utils';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

function validRaw() {
  return {
    version: DATA_VERSION,
    words: [
      {
        id: 'w1',
        term: '  abandon ',
        meaning: '放弃',
        tags: ['CET-4', 'CET-4'],
        createdAt: NOW,
      },
      {
        id: 'w2',
        term: 'meticulous',
        meaning: '一丝不苟的',
        createdAt: NOW,
      },
      {
        id: 'w3',
        term: 'Abandon',
        meaning: '重复词条',
      },
      'not-a-word',
    ],
    srs: { w1: 'invalid', w2: { status: 'unknown', interval: -5 } },
    attempts: [
      { id: 'a1', wordId: 'w1', kind: 'flashcard', correct: true, grade: 'good', createdAt: NOW },
      { id: 'a2', wordId: 'missing', kind: 'flashcard', correct: true, createdAt: NOW },
      { id: 'a3', wordId: 'w2', kind: 'exercise', correct: false, exerciseType: 'fill', createdAt: NOW },
    ],
    mistakes: {
      w1: { wrongCount: 0, correctStreak: 0, lastWrongAt: NOW },
      w2: { wrongCount: 2, correctStreak: 1, lastWrongAt: NOW },
      missing: { wrongCount: 2 },
    },
    settings: {
      provider: 'unknown',
      baseUrl: '',
      apiKey: '  sk-test  ',
      model: '',
      temperature: 9,
      maxTokens: 5,
    },
    theme: 'purple',
    stats: {
      daily: {
        [dayKey(NOW)]: { reviewed: 3, correct: 2, wrong: 1, learned: 1 },
        'not-a-date': { reviewed: 99 },
      },
    },
  };
}

describe('createInitialData', () => {
  it('用内置词库生成单词与卡片', () => {
    const data = createInitialData(NOW);
    expect(data.version).toBe(DATA_VERSION);
    expect(data.words.length).toBe(SEED_WORDS.length);
    expect(data.words.length).toBeGreaterThan(0);
    expect(Object.keys(data.srs)).toHaveLength(data.words.length);
    expect(new Set(data.words.map((word) => word.term)).size).toBe(data.words.length);
    expect(data.settings).toEqual(DEFAULT_LLM_SETTINGS);
    expect(data.attempts).toEqual([]);
    expect(data.stats.daily).toEqual({});
  });

  it('seedWordId 稳定且可读', () => {
    expect(seedWordId('abandon')).toBe('w_seed_abandon');
    expect(seedWordId('give up')).toBe('w_seed_give_up');
    expect(seedWordId('  ')).toMatch(/^w_seed_/);
  });
});

describe('单词清洗', () => {
  it('normalizeWord 去掉空白并校验必填字段', () => {
    expect(normalizeWord({ term: '  abandon ', meaning: ' 放弃 ' })).toMatchObject({
      term: 'abandon',
      meaning: '放弃',
    });
    expect(normalizeWord({ term: '', meaning: '释义' })).toBeNull();
    expect(normalizeWord({ term: 'word', meaning: '   ' })).toBeNull();
  });

  it('makeWord 生成唯一 id 与默认标签', () => {
    const a = makeWord({ term: 'alpha', meaning: '甲' }, { now: NOW });
    const b = makeWord({ term: 'alpha', meaning: '甲' }, { now: NOW });
    expect(a.id).not.toBe(b.id);
    expect(a.tags).toEqual([]);
    expect(a.createdAt).toBe(NOW);
    expect(() => makeWord({ term: '', meaning: 'x' })).toThrow();
  });
});

describe('hydrateData', () => {
  it('清洗字段、去重、修复卡片并丢弃孤立记录', () => {
    const data = hydrateData(validRaw(), { now: NOW });
    expect(data.words.map((word) => word.id)).toEqual(['w1', 'w2']);
    expect(data.words[0].term).toBe('abandon');
    expect(data.words[0].tags).toEqual(['CET-4']);
    expect(data.srs.w1).toBeDefined();
    expect(data.srs.w1.status).toBe('new');
    expect(data.srs.w2.status).toBe('new');
    expect(data.srs.missing).toBeUndefined();

    expect(data.attempts).toHaveLength(2);
    expect(data.attempts.map((attempt) => attempt.id).sort()).toEqual(['a1', 'a3']);

    expect(Object.keys(data.mistakes)).toEqual(['w2']);
    expect(data.mistakes.w2.wrongCount).toBe(2);

    expect(data.settings.provider).toBe('openai');
    expect(data.settings.baseUrl).toBe(DEFAULT_LLM_SETTINGS.baseUrl);
    expect(data.settings.model).toBe(DEFAULT_LLM_SETTINGS.model);
    expect(data.settings.apiKey).toBe('  sk-test  ');
    expect(data.settings.temperature).toBe(2);
    expect(data.settings.maxTokens).toBe(64);

    expect(data.theme).toBe('light');
    expect(Object.keys(data.stats.daily)).toEqual([dayKey(NOW)]);
  });

  it('缺少 words 时按场景决定回退或抛错', () => {
    expect(hydrateData({}, { now: NOW }).words.length).toBe(SEED_WORDS.length);
    expect(() => hydrateData({}, { requireWords: true })).toThrow();
    expect(() => hydrateData(null)).toThrow();
  });

  it('words 存在但类型错误时视为损坏数据而非静默重置', () => {
    expect(() => hydrateData({ words: 'oops' }, { now: NOW })).toThrow('单词列表');
    expect(() => hydrateData({ words: { a: 1 } }, { now: NOW })).toThrow('单词列表');
  });

  it('按 id 去重，避免重复卡片与重复 React key', () => {
    const data = hydrateData(
      {
        words: [
          { id: 'dup', term: 'alpha', meaning: '甲' },
          { id: 'dup', term: 'beta', meaning: '乙' },
          { id: 'uniq', term: 'gamma', meaning: '丙' },
        ],
      },
      { now: NOW },
    );
    expect(data.words.map((word) => word.id)).toEqual(['dup', 'uniq']);
    expect(Object.keys(data.srs).sort()).toEqual(['dup', 'uniq']);
  });

  it('旧数据缺少卡片时会自动补卡', () => {
    const data = hydrateData(
      { words: [{ id: 'x1', term: 'test', meaning: '测试' }] },
      { now: NOW },
    );
    expect(data.srs.x1).toBeDefined();
    expect(data.srs.x1.dueAt).toBe(NOW);
  });
});

describe('备份导入导出', () => {
  const data = createInitialData(NOW);
  data.settings.apiKey = 'sk-secret';

  it('默认导出不包含 API Key，可选择包含', () => {
    const safe = exportBackup(data);
    const parsedSafe = JSON.parse(safe);
    expect(parsedSafe.app).toBe('deepword');
    expect(parsedSafe.data.settings.apiKey).toBe('');
    expect(safe).not.toContain('sk-secret');

    const unsafe = exportBackup(data, { includeApiKey: true });
    expect(JSON.parse(unsafe).data.settings.apiKey).toBe('sk-secret');
  });

  it('parseBackup 接受包装格式与裸 AppData', () => {
    const fromWrapper = parseBackup(exportBackup(data));
    expect(fromWrapper.words.length).toBe(data.words.length);

    const raw = JSON.stringify(data);
    expect(parseBackup(raw).words.length).toBe(data.words.length);
  });

  it('parseBackup 对非法输入给出可读错误', () => {
    expect(() => parseBackup('not json')).toThrow('JSON');
    expect(() => parseBackup('{}')).toThrow();
    expect(() => parseBackup('null')).toThrow();
  });
});

describe('本地环境兜底', () => {
  it('Node 环境下 localStorage 不可用，读取时返回示例数据与警告', () => {
    expect(storageAvailable()).toBe(false);
    const result = loadData(NOW);
    expect(result.warning).toMatch(/localStorage/);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    expect(saveData(result.data).ok).toBe(false);
    expect(getStorageUsage().human).toBe('不可用');
  });
});

describe('resetProgress', () => {
  it('清空进度但保留词库与设置', () => {
    const data: AppData = createInitialData(NOW);
    data.settings.model = 'custom-model';
    data.attempts = [
      { id: 'a', wordId: 'x', kind: 'flashcard', correct: true, createdAt: NOW },
    ];
    data.mistakes = {
      x: { wordId: 'x', wrongCount: 1, correctStreak: 0, firstWrongAt: NOW, lastWrongAt: NOW, lastAttemptAt: NOW },
    };
    data.stats.daily = { [dayKey(NOW)]: { reviewed: 4, correct: 3, wrong: 1, learned: 1 } };
    const wordId = data.words[0].id;
    data.srs[wordId] = gradeCard(createCard(wordId, NOW), 'good', NOW);

    const reset = resetProgress(data, NOW + 1);
    expect(reset.words).toEqual(data.words);
    expect(reset.settings.model).toBe('custom-model');
    expect(reset.attempts).toEqual([]);
    expect(reset.mistakes).toEqual({});
    expect(reset.stats.daily).toEqual({});
    expect(reset.srs[wordId].status).toBe('new');
    expect(reset.updatedAt).toBe(NOW + 1);
  });
});
