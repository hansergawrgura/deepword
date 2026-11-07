import { afterEach, describe, expect, it } from 'vitest';
import type { AppData } from '../types';
import {
  DATA_VERSION,
  DEFAULT_PRACTICE_SETTINGS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
} from '../types';
import { SEED_WORDS } from '../data/wordbank';
import {
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  clearStoredData,
  createInitialData,
  exportBackup,
  getStorageUsage,
  hydrateData,
  loadData,
  makeWord,
  migrateV1ToV2,
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

/* ------------------------------------------------------------------ */
/* localStorage 模拟（Node 测试环境）                                   */
/* ------------------------------------------------------------------ */

interface LocalStorageHandle {
  store: Map<string, string>;
  restore: () => void;
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
  const restore = () => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  };
  restorers.push(restore);
  return { store, restore };
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

/** 完整的 v1 数据（单份 settings、无 providers/practice/session）。 */
function v1Fixture() {
  return {
    version: 1,
    words: [
      { id: 'w1', term: '  abandon ', meaning: '放弃', tags: ['CET-4', 'CET-4'], createdAt: NOW },
      { id: 'w2', term: 'meticulous', meaning: '一丝不苟的', createdAt: NOW },
      { id: 'w3', term: 'Abandon', meaning: '重复词条' },
      'not-a-word',
    ],
    srs: { w1: 'invalid', w2: { status: 'unknown', interval: -5 } },
    attempts: [
      { id: 'a1', wordId: 'w1', kind: 'flashcard', correct: true, grade: 'good', createdAt: NOW },
      { id: 'a2', wordId: 'missing', kind: 'flashcard', correct: true, createdAt: NOW },
      {
        id: 'a3',
        wordId: 'w2',
        kind: 'exercise',
        correct: false,
        exerciseType: 'fill',
        createdAt: NOW + 1,
      },
    ],
    mistakes: {
      w1: { wrongCount: 0, correctStreak: 0, lastWrongAt: NOW },
      w2: { wrongCount: 2, correctStreak: 1, lastWrongAt: NOW },
      missing: { wrongCount: 2 },
    },
    settings: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '  sk-legacy  ',
      model: 'claude-4-sonnet',
      temperature: 0.4,
      maxTokens: 4_096,
    },
    theme: 'dark',
    stats: {
      daily: {
        [dayKey(NOW)]: { reviewed: 3, correct: 2, wrong: 1, learned: 1 },
        'not-a-date': { reviewed: 99 },
      },
    },
    createdAt: NOW - 1_000,
    updatedAt: NOW,
  };
}

/** 带各种脏字段的 v2 数据（词库/卡片/作答/错题）。 */
function messyV2() {
  return {
    version: 2,
    words: [
      { id: 'w1', term: '  abandon ', meaning: '放弃', tags: ['CET-4', 'CET-4'], createdAt: NOW },
      { id: 'w2', term: 'meticulous', meaning: '一丝不苟的', createdAt: NOW },
      { id: 'w3', term: 'Abandon', meaning: '重复词条' },
      'not-a-word',
    ],
    srs: { w1: 'invalid', w2: { status: 'unknown', interval: -5 } },
    attempts: [
      { id: 'a1', wordId: 'w1', kind: 'flashcard', correct: true, grade: 'good', createdAt: NOW },
      { id: 'a2', wordId: 'missing', kind: 'flashcard', correct: true, createdAt: NOW },
      {
        id: 'a3',
        wordId: 'w2',
        kind: 'exercise',
        correct: false,
        exerciseType: 'fill',
        createdAt: NOW + 1,
      },
    ],
    mistakes: {
      w1: { wrongCount: 0, correctStreak: 0, lastWrongAt: NOW },
      w2: { wrongCount: 2, correctStreak: 1, lastWrongAt: NOW },
      missing: { wrongCount: 2 },
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

const minimalWords = () => [{ id: 'w1', term: 'alpha', meaning: '甲', createdAt: NOW }];

/* ------------------------------------------------------------------ */
/* 初始数据                                                             */
/* ------------------------------------------------------------------ */

describe('createInitialData', () => {
  it('用内置词库生成单词与卡片，并带 1 份默认 provider 与默认练习设置', () => {
    const data = createInitialData(NOW);
    expect(data.version).toBe(DATA_VERSION);
    expect(data.words.length).toBe(SEED_WORDS.length);
    expect(data.words.length).toBeGreaterThan(0);
    expect(Object.keys(data.srs)).toHaveLength(data.words.length);
    expect(new Set(data.words.map((word) => word.term)).size).toBe(data.words.length);

    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].baseUrl).toBe('https://api.openai.com/v1');
    expect(data.providers[0].defaultModel).toBe('gpt-4o-mini');
    expect(data.providers[0].thinkingMode).toBe('off');
    expect(data.activeProviderId).toBe(data.providers[0].id);
    expect(data.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(data.session).toBeNull();

    expect(data.attempts).toEqual([]);
    expect(data.stats.daily).toEqual({});
  });

  it('seedWordId 稳定且可读', () => {
    expect(seedWordId('abandon')).toBe('w_seed_abandon');
    expect(seedWordId('give up')).toBe('w_seed_give_up');
    expect(seedWordId('  ')).toMatch(/^w_seed_/);
  });
});

/* ------------------------------------------------------------------ */
/* 单词清洗                                                             */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* v1 → v2 迁移                                                         */
/* ------------------------------------------------------------------ */

describe('v1 → v2 迁移', () => {
  it('完整 v1 fixture 迁移后 providers/practice/session 齐全，原数据保留', () => {
    const data = hydrateData(v1Fixture(), { now: NOW });

    expect(data.version).toBe(2);
    expect(data.words.map((word) => word.id)).toEqual(['w1', 'w2']);
    expect(data.attempts.map((attempt) => attempt.id)).toEqual(['a3', 'a1']);
    expect(Object.keys(data.mistakes)).toEqual(['w2']);
    expect(data.mistakes.w2.wrongCount).toBe(2);
    expect(Object.keys(data.stats.daily)).toEqual([dayKey(NOW)]);
    expect(data.theme).toBe('dark');
    expect(data.createdAt).toBe(NOW - 1_000);

    expect(data.providers).toHaveLength(1);
    const provider = data.providers[0];
    expect(provider.protocol).toBe('anthropic');
    expect(provider.vendor).toBe('anthropic');
    expect(provider.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(provider.apiKey).toBe('  sk-legacy  ');
    expect(provider.models).toEqual(['claude-4-sonnet']);
    expect(provider.defaultModel).toBe('claude-4-sonnet');
    expect(provider.temperature).toBe(0.4);
    expect(provider.maxTokens).toBe(4_096);
    expect(provider.name).toBe('默认配置');
    expect(data.activeProviderId).toBe(provider.id);
    expect(data.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(data.session).toBeNull();
  });

  it('migrateV1ToV2 是纯函数：映射 settings、补 practice/session、不改入参', () => {
    const fixture = v1Fixture();
    const migrated = migrateV1ToV2(fixture, NOW);
    expect(migrated.version).toBe(DATA_VERSION);
    expect(migrated.providers).toHaveLength(1);
    expect(migrated.activeProviderId).toBe(migrated.providers[0].id);
    expect(migrated.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(migrated.session).toBeNull();
    expect((migrated as unknown as Record<string, unknown>).settings).toBeUndefined();

    expect(fixture.version).toBe(1);
    expect((fixture as unknown as Record<string, unknown>).settings).toBeDefined();
  });

  it('「无 providers 但有 settings」也自动迁移', () => {
    const data = hydrateData(
      {
        words: minimalWords(),
        settings: {
          provider: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-ds',
          model: 'deepseek-chat',
          temperature: 0.7,
          maxTokens: 2_500,
        },
      },
      { now: NOW },
    );
    expect(data.version).toBe(2);
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0].vendor).toBe('deepseek');
    expect(data.providers[0].defaultModel).toBe('deepseek-chat');
    expect(data.activeProviderId).toBe(data.providers[0].id);
    expect(data.words).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* hydrateData：新格式直读 + 清洗                                       */
/* ------------------------------------------------------------------ */

describe('hydrateData', () => {
  it('新格式（v2）直读：providers/practice/session/卡片 原样保留', () => {
    const raw = {
      version: 2,
      words: minimalWords(),
      srs: {
        w1: { status: 'review', interval: 3, ease: 2.6, dueAt: NOW + 1, reps: 2, lapses: 1, lastReviewedAt: NOW },
      },
      providers: [
        {
          id: 'p1',
          name: '主配置',
          protocol: 'anthropic',
          vendor: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-a',
          models: ['m1', 'm2'],
          defaultModel: 'm2',
          temperature: 0.2,
          maxTokens: 8_000,
          thinkingMode: 'provider-default',
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: 'p2',
          name: '备用',
          protocol: 'openai',
          vendor: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-b',
          models: ['deepseek-chat'],
          defaultModel: 'deepseek-chat',
          temperature: 0.7,
          maxTokens: 2_500,
          thinkingMode: 'off',
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      activeProviderId: 'p2',
      practice: {
        newWordsPerRound: 3,
        questionsPerNewWord: 5,
        reviewWordsPerRound: 8,
        reviewQuestionsPerRound: 12,
        feedbackAutoAdvanceMs: 0,
        autoExplain: false,
        tts: { rate: 1.5, voiceUri: 'voice-1', autoPlay: false },
      },
      session: {
        id: 's1',
        startedAt: NOW,
        stage: 'new',
        newWordIds: ['w1'],
        completedNewWordIds: [],
        reviewWordIds: [],
        answered: 1,
        targetQuestions: 6,
      },
      attempts: [],
      mistakes: {},
      theme: 'light',
      stats: { daily: {} },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const data = hydrateData(raw, { now: NOW });
    expect(data.version).toBe(2);
    expect(data.providers.map((provider) => provider.id)).toEqual(['p1', 'p2']);
    expect(data.activeProviderId).toBe('p2');
    expect(data.providers[1].vendor).toBe('deepseek');
    expect(data.practice).toEqual(raw.practice);
    expect(data.session).toEqual(raw.session);
    expect(data.srs.w1.status).toBe('review');
    expect(data.srs.w1.reps).toBe(2);
  });

  it('清洗词库字段、去重、修复卡片并丢弃孤立记录', () => {
    const data = hydrateData(messyV2(), { now: NOW });
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

    expect(data.providers).toEqual([]);
    expect(data.activeProviderId).toBeNull();
    expect(data.theme).toBe('light');
    expect(Object.keys(data.stats.daily)).toEqual([dayKey(NOW)]);
  });

  it('缺少 words 时按场景决定回退或抛错', () => {
    expect(hydrateData({}, { now: NOW }).words.length).toBe(SEED_WORDS.length);
    expect(hydrateData({}, { now: NOW }).providers).toHaveLength(1);
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

/* ------------------------------------------------------------------ */
/* provider / practice / session / attempt 清洗                         */
/* ------------------------------------------------------------------ */

describe('provider 清洗', () => {
  it('丢弃空 baseUrl / 非对象条目、按 id 去重、非法字段回退', () => {
    const data = hydrateData(
      {
        version: 2,
        words: minimalWords(),
        providers: [
          {
            id: 'p1',
            name: '  主配置  ',
            protocol: 'anthropic',
            vendor: 'nope',
            baseUrl: '  https://api.anthropic.com/v1  ',
            apiKey: 123,
            models: [' m1 ', 'm1', '', 'm2'],
            defaultModel: '  m-custom ',
            temperature: 9,
            maxTokens: 5,
            thinkingMode: 'weird',
            createdAt: 'x',
            updatedAt: 'y',
          },
          { id: 'p1', name: '重复 id', baseUrl: 'https://dupe.example/v1' },
          { id: 'empty', name: '空地址', baseUrl: '   ' },
          'junk',
        ],
        activeProviderId: 'p3',
      },
      { now: NOW },
    );

    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({
      id: 'p1',
      name: '主配置',
      protocol: 'anthropic',
      vendor: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: '',
      models: ['m1', 'm2'],
      defaultModel: 'm-custom',
      temperature: 2,
      maxTokens: 64,
      thinkingMode: 'off',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(data.activeProviderId).toBe('p1');
  });

  it('provider 数量与模型白名单按上限截断', () => {
    const manyProviders = Array.from({ length: MAX_PROVIDERS + 5 }, (_, index) => ({
      id: `p${index}`,
      name: `配置 ${index}`,
      protocol: 'openai',
      vendor: 'custom',
      baseUrl: `https://api.example.com/v${index}`,
      apiKey: '',
      models: Array.from({ length: MAX_MODELS_PER_PROVIDER + 50 }, (_, i) => `m${i}`),
      defaultModel: 'm0',
      temperature: 0.7,
      maxTokens: 2_500,
      thinkingMode: 'off',
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const data = hydrateData(
      { version: 2, words: minimalWords(), providers: manyProviders },
      { now: NOW },
    );
    expect(data.providers).toHaveLength(MAX_PROVIDERS);
    expect(data.providers[0].models).toHaveLength(MAX_MODELS_PER_PROVIDER);
    expect(data.providers[0].models[0]).toBe('m0');
    expect(data.providers[0].models.at(-1)).toBe(`m${MAX_MODELS_PER_PROVIDER - 1}`);
    expect(data.activeProviderId).toBe('p0');
  });

  it('provider 列表为空时 activeProviderId 为 null', () => {
    const data = hydrateData(
      { version: 2, words: minimalWords(), providers: [], activeProviderId: 'ghost' },
      { now: NOW },
    );
    expect(data.providers).toEqual([]);
    expect(data.activeProviderId).toBeNull();
  });
});

describe('practice 清洗', () => {
  it('范围越界时 clamp，含 reviewQuestions ∈ [reviewWords, 2×reviewWords]', () => {
    const practice = hydrateData(
      {
        version: 2,
        words: minimalWords(),
        practice: {
          newWordsPerRound: 0,
          questionsPerNewWord: 99,
          reviewWordsPerRound: 2,
          reviewQuestionsPerRound: 99,
          feedbackAutoAdvanceMs: 500,
          autoExplain: 'yes',
          tts: { rate: 9, voiceUri: 123, autoPlay: false },
        },
      },
      { now: NOW },
    ).practice;
    expect(practice.newWordsPerRound).toBe(1);
    expect(practice.questionsPerNewWord).toBe(8);
    expect(practice.reviewWordsPerRound).toBe(2);
    expect(practice.reviewQuestionsPerRound).toBe(4);
    expect(practice.feedbackAutoAdvanceMs).toBe(1_000);
    expect(practice.autoExplain).toBe(true);
    expect(practice.tts.rate).toBe(2);
    expect(practice.tts.voiceUri).toBe('');
    expect(practice.tts.autoPlay).toBe(false);
  });

  it('上限 clamp 与自动跳转 0/区间边界', () => {
    const practice = hydrateData(
      {
        version: 2,
        words: minimalWords(),
        practice: {
          newWordsPerRound: 99,
          questionsPerNewWord: 1,
          reviewWordsPerRound: 99,
          reviewQuestionsPerRound: 1,
          feedbackAutoAdvanceMs: 0,
        },
      },
      { now: NOW },
    ).practice;
    expect(practice.newWordsPerRound).toBe(10);
    expect(practice.questionsPerNewWord).toBe(4);
    expect(practice.reviewWordsPerRound).toBe(12);
    expect(practice.reviewQuestionsPerRound).toBe(12);
    expect(practice.feedbackAutoAdvanceMs).toBe(0);

    const over = hydrateData(
      { version: 2, words: minimalWords(), practice: { feedbackAutoAdvanceMs: 20_000 } },
      { now: NOW },
    ).practice;
    expect(over.feedbackAutoAdvanceMs).toBe(10_000);

    const negative = hydrateData(
      { version: 2, words: minimalWords(), practice: { feedbackAutoAdvanceMs: -5 } },
      { now: NOW },
    ).practice;
    expect(negative.feedbackAutoAdvanceMs).toBe(0);

    const missing = hydrateData({ version: 2, words: minimalWords() }, { now: NOW }).practice;
    expect(missing).toEqual(DEFAULT_PRACTICE_SETTINGS);
  });
});

describe('session 清洗', () => {
  it('非法字段回退、id 数组去重过滤，非对象视为无会话', () => {
    const data = hydrateData(
      {
        version: 2,
        words: minimalWords(),
        session: {
          id: 123,
          stage: 'weird',
          startedAt: 'x',
          newWordIds: ['a', 5, 'a', 'b'],
          completedNewWordIds: 'nope',
          reviewWordIds: ['r1'],
          answered: -3,
          targetQuestions: '9',
        },
      },
      { now: NOW },
    );
    const session = data.session;
    expect(session).not.toBeNull();
    if (!session) throw new Error('unreachable');
    expect(typeof session.id).toBe('string');
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.stage).toBe('new');
    expect(session.startedAt).toBe(NOW);
    expect(session.newWordIds).toEqual(['a', 'b']);
    expect(session.completedNewWordIds).toEqual([]);
    expect(session.reviewWordIds).toEqual(['r1']);
    expect(session.answered).toBe(0);
    expect(session.targetQuestions).toBe(0);

    expect(
      hydrateData({ version: 2, words: minimalWords(), session: 'oops' }, { now: NOW }).session,
    ).toBeNull();
    expect(hydrateData({ version: 2, words: minimalWords() }, { now: NOW }).session).toBeNull();
  });
});

describe('attempt 新字段清洗', () => {
  it('skill/latencyMs/verdict/aiFeedback/aiImprovement/aiStatus 合法化并截断', () => {
    const data = hydrateData(
      {
        version: 2,
        words: [
          { id: 'w1', term: 'alpha', meaning: '甲' },
          { id: 'w2', term: 'beta', meaning: '乙' },
        ],
        attempts: [
          {
            id: 'a1',
            wordId: 'w1',
            kind: 'exercise',
            correct: true,
            exerciseType: 'translate',
            skill: 'en2zh',
            latencyMs: -5,
            verdict: 'perfect',
            aiFeedback: 'x'.repeat(500),
            aiImprovement: '  更好的表达  ',
            aiStatus: 'ok',
            createdAt: NOW + 2,
          },
          {
            id: 'a2',
            wordId: 'w2',
            kind: 'exercise',
            correct: false,
            exerciseType: 'bogus',
            skill: 'bogus',
            verdict: 'bogus',
            aiStatus: 'bogus',
            latencyMs: 'slow',
            createdAt: NOW + 1,
          },
          {
            id: 'a3',
            wordId: 'w2',
            kind: 'exercise',
            correct: true,
            exerciseType: 'sentence',
            skill: 'sentence',
            latencyMs: 1_200,
            createdAt: NOW,
          },
        ],
      },
      { now: NOW },
    );

    const byId = new Map(data.attempts.map((attempt) => [attempt.id, attempt]));
    const a1 = byId.get('a1');
    expect(a1).toBeDefined();
    expect(a1?.skill).toBe('en2zh');
    expect(a1?.latencyMs).toBe(0);
    expect(a1?.verdict).toBe('perfect');
    expect(a1?.aiFeedback).toHaveLength(400);
    expect(a1?.aiImprovement).toBe('更好的表达');
    expect(a1?.aiStatus).toBe('ok');
    expect(a1?.exerciseType).toBe('translate');

    const a2 = byId.get('a2');
    expect(a2).toBeDefined();
    expect(a2?.skill).toBeUndefined();
    expect(a2?.verdict).toBeUndefined();
    expect(a2?.aiStatus).toBeUndefined();
    expect(a2?.exerciseType).toBeUndefined();
    expect(a2?.latencyMs).toBeUndefined();

    const a3 = byId.get('a3');
    expect(a3?.skill).toBe('sentence');
    expect(a3?.latencyMs).toBe(1_200);
    expect(a3?.exerciseType).toBe('sentence');
  });

  it('7 种 ExerciseType 全部保留', () => {
    const types = [
      'choice',
      'fill',
      'spell',
      'translate',
      'sentence',
      'usage',
      'correction',
    ] as const;
    const data = hydrateData(
      {
        version: 2,
        words: minimalWords(),
        attempts: types.map((type, index) => ({
          id: `a${index}`,
          wordId: 'w1',
          kind: 'exercise',
          correct: true,
          exerciseType: type,
          createdAt: NOW + index,
        })),
      },
      { now: NOW },
    );
    expect(data.attempts.map((attempt) => attempt.exerciseType).sort()).toEqual(
      [...types].sort(),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 备份导入导出                                                         */
/* ------------------------------------------------------------------ */

describe('备份导入导出', () => {
  it('默认导出不含 provider API Key，可选择包含；版本写 2', () => {
    const data = createInitialData(NOW);
    data.providers[0].apiKey = 'sk-secret';
    const safe = exportBackup(data);
    const parsedSafe = JSON.parse(safe);
    expect(parsedSafe.app).toBe('deepword');
    expect(parsedSafe.version).toBe(2);
    expect(parsedSafe.data.version).toBe(2);
    expect(parsedSafe.data.providers[0].apiKey).toBe('');
    expect(safe).not.toContain('sk-secret');

    const unsafe = JSON.parse(exportBackup(data, { includeApiKey: true }));
    expect(unsafe.data.providers[0].apiKey).toBe('sk-secret');
  });

  it('parseBackup 接受 v2 包装与裸 v2 数据', () => {
    const data = createInitialData(NOW);
    const fromWrapper = parseBackup(exportBackup(data));
    expect(fromWrapper.version).toBe(2);
    expect(fromWrapper.words.length).toBe(data.words.length);

    const raw = JSON.stringify(data);
    expect(parseBackup(raw).words.length).toBe(data.words.length);
    expect(parseBackup(raw).providers).toHaveLength(1);
  });

  it('parseBackup 接受 v1 包装与裸 v1 数据并自动迁移', () => {
    const wrapper = JSON.stringify({
      app: 'deepword',
      scheme: 'deepword-backup',
      version: 1,
      data: v1Fixture(),
    });
    const fromWrapper = parseBackup(wrapper);
    expect(fromWrapper.version).toBe(2);
    expect(fromWrapper.words).toHaveLength(2);
    expect(fromWrapper.providers).toHaveLength(1);
    expect(fromWrapper.activeProviderId).toBe(fromWrapper.providers[0].id);
    expect(fromWrapper.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);
    expect(fromWrapper.session).toBeNull();

    const bare = parseBackup(JSON.stringify(v1Fixture()));
    expect(bare.version).toBe(2);
    expect(bare.providers).toHaveLength(1);
    expect(bare.attempts).toHaveLength(2);
  });

  it('parseBackup 对非法输入给出可读错误', () => {
    expect(() => parseBackup('not json')).toThrow('JSON');
    expect(() => parseBackup('{}')).toThrow();
    expect(() => parseBackup('null')).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* loadData / saveData（mock localStorage）                             */
/* ------------------------------------------------------------------ */

describe('loadData', () => {
  it('有 v2 键时直接读取', () => {
    const { store } = withLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 2, words: [{ id: 'w1', term: 'alpha', meaning: '甲' }] }),
    );
    const result = loadData(NOW);
    expect(result.warning).toBeUndefined();
    expect(result.data.version).toBe(2);
    expect(result.data.words.map((word) => word.id)).toEqual(['w1']);
  });

  it('仅 v1 键时迁移并写入 v2，v1 键保留', () => {
    const { store } = withLocalStorage();
    const legacyRaw = JSON.stringify(v1Fixture());
    store.set(LEGACY_STORAGE_KEY, legacyRaw);

    const result = loadData(NOW);
    expect(result.data.version).toBe(2);
    expect(result.data.words).toHaveLength(2);
    expect(result.data.providers).toHaveLength(1);
    expect(result.data.activeProviderId).toBe(result.data.providers[0].id);
    expect(result.data.practice).toEqual(DEFAULT_PRACTICE_SETTINGS);

    const written = JSON.parse(store.get(STORAGE_KEY) ?? 'null');
    expect(written.version).toBe(2);
    expect(written.providers).toHaveLength(1);
    expect(written.practice.reviewQuestionsPerRound).toBe(10);
    expect(store.get(LEGACY_STORAGE_KEY)).toBe(legacyRaw);
  });

  it('v2 与 v1 键同时存在时优先 v2', () => {
    const { store } = withLocalStorage();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ version: 2, words: [{ id: 'v2-word', term: 'alpha', meaning: '甲' }] }),
    );
    store.set(LEGACY_STORAGE_KEY, JSON.stringify(v1Fixture()));
    const result = loadData(NOW);
    expect(result.data.words.map((word) => word.id)).toEqual(['v2-word']);
  });

  it('v2 数据损坏时备份到 v2:corrupt:<ts> 并降级为示例数据', () => {
    const { store } = withLocalStorage();
    const corruptJson = '{not-json';
    store.set(STORAGE_KEY, corruptJson);

    const result = loadData(NOW);
    expect(result.warning).toMatch(/读取失败/);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    expect(result.data.providers).toHaveLength(1);

    const backups = Array.from(store.keys()).filter((key) =>
      key.startsWith(`${STORAGE_KEY}:corrupt:`),
    );
    expect(backups).toHaveLength(1);
    expect(store.get(backups[0])).toBe(corruptJson);
  });

  it('v2 数据 words 类型错误也走损坏备份', () => {
    const { store } = withLocalStorage();
    store.set(STORAGE_KEY, JSON.stringify({ version: 2, words: 'oops' }));
    const result = loadData(NOW);
    expect(result.warning).toMatch(/读取失败/);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    const backups = Array.from(store.keys()).filter((key) =>
      key.startsWith(`${STORAGE_KEY}:corrupt:`),
    );
    expect(backups).toHaveLength(1);
  });
});

describe('saveData / getStorageUsage / clearStoredData', () => {
  it('saveData 写 v2 键，getStorageUsage 读 v2 键', () => {
    const { store } = withLocalStorage();
    const data = hydrateData({ version: 2, words: minimalWords() }, { now: NOW });
    const saved = saveData(data);
    expect(saved.ok).toBe(true);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? 'null').version).toBe(2);

    const usage = getStorageUsage();
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.human).toMatch(/B|KB|MB/);
  });

  it('clearStoredData 同时删除 v1 与 v2 键', () => {
    const { store } = withLocalStorage();
    store.set(STORAGE_KEY, '{}');
    store.set(LEGACY_STORAGE_KEY, '{}');
    clearStoredData();
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(store.has(LEGACY_STORAGE_KEY)).toBe(false);
  });
});

describe('本地环境兜底', () => {
  it('Node 环境下 localStorage 不可用，读取时返回示例数据与警告', () => {
    expect(storageAvailable()).toBe(false);
    const result = loadData(NOW);
    expect(result.warning).toMatch(/localStorage/);
    expect(result.data.words.length).toBe(SEED_WORDS.length);
    expect(result.data.providers).toHaveLength(1);
    expect(saveData(result.data).ok).toBe(false);
    expect(getStorageUsage().human).toBe('不可用');
  });
});

/* ------------------------------------------------------------------ */
/* resetProgress                                                        */
/* ------------------------------------------------------------------ */

describe('resetProgress', () => {
  it('清空进度但保留词库、providers 与 practice，session 置空', () => {
    const data: AppData = createInitialData(NOW);
    data.providers[0].defaultModel = 'custom-model';
    data.practice.newWordsPerRound = 4;
    data.session = {
      id: 's1',
      startedAt: NOW,
      stage: 'new',
      newWordIds: [],
      completedNewWordIds: [],
      reviewWordIds: [],
      answered: 0,
      targetQuestions: 6,
    };
    data.attempts = [
      { id: 'a', wordId: 'x', kind: 'flashcard', correct: true, createdAt: NOW },
    ];
    data.mistakes = {
      x: {
        wordId: 'x',
        wrongCount: 1,
        correctStreak: 0,
        firstWrongAt: NOW,
        lastWrongAt: NOW,
        lastAttemptAt: NOW,
      },
    };
    data.stats.daily = { [dayKey(NOW)]: { reviewed: 4, correct: 3, wrong: 1, learned: 1 } };
    const wordId = data.words[0].id;
    data.srs[wordId] = gradeCard(createCard(wordId, NOW), 'good', NOW);

    const reset = resetProgress(data, NOW + 1);
    expect(reset.words).toEqual(data.words);
    expect(reset.providers).toEqual(data.providers);
    expect(reset.activeProviderId).toBe(data.activeProviderId);
    expect(reset.practice).toEqual(data.practice);
    expect(reset.session).toBeNull();
    expect(reset.attempts).toEqual([]);
    expect(reset.mistakes).toEqual({});
    expect(reset.stats.daily).toEqual({});
    expect(reset.srs[wordId].status).toBe('new');
    expect(reset.updatedAt).toBe(NOW + 1);
  });
});
