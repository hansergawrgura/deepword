/**
 * 一轮选词与题量规划单测（vitest / node 环境）。
 *
 * 口径来源：docs/phase-b-contract.md 第 5 节。
 * 覆盖：countAvailable 区分新词 / 复习词 / 掌握词、pickNewWord 只挑未学未掌握的词、
 * pickReviewWords 排除掌握词与新词并按薄弱度排序、planRound 的轮次递增与新词去重。
 */

import { describe, expect, it } from 'vitest';
import type {
  AppData,
  Attempt,
  MasteryRecord,
  PracticeSettings,
  SrsCard,
  SrsStatus,
  Word,
} from '../types';
import { DATA_VERSION, DEFAULT_PRACTICE_SETTINGS } from '../types';

import {
  countAvailable,
  pickNewWord,
  pickReviewWords,
  planRound,
  scoreReviewWord,
} from './rounds';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function makeWord(id: string, term: string, meaning: string): Word {
  return { id, term, meaning, tags: [], createdAt: NOW - 30 * DAY };
}

function makeCard(wordId: string, status: SrsStatus, overrides: Partial<SrsCard> = {}): SrsCard {
  return {
    wordId,
    status,
    ease: 2.5,
    interval: 1,
    dueAt: NOW + DAY,
    reps: 1,
    lapses: 0,
    lastReviewedAt: NOW - DAY,
    ...overrides,
  };
}

function makeAttempt(
  wordId: string,
  correct: boolean,
  createdAt: number,
  skill: Attempt['skill'] = 'en2zh',
): Attempt {
  return {
    id: `a_${wordId}_${createdAt}_${correct}`,
    wordId,
    kind: 'exercise',
    correct,
    skill,
    createdAt,
  };
}

function makeData(overrides: Partial<AppData> = {}): AppData {
  return {
    version: DATA_VERSION,
    words: [],
    providers: [],
    activeProviderId: null,
    practice: DEFAULT_PRACTICE_SETTINGS,
    session: null,
    mastery: {},
    reviewPriority: {},
    srs: {},
    attempts: [],
    mistakes: {},
    theme: 'light',
    stats: { daily: {} },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const WORDS = [
  makeWord('w1', 'abandon', '放弃；抛弃'),
  makeWord('w2', 'candle', '蜡烛'),
  makeWord('w3', 'gentle', '温和的'),
  makeWord('w4', 'harbor', '港口'),
];

describe('countAvailable', () => {
  it('区分新词、复习词与掌握词', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
        w4: makeCard('w4', 'new', { reps: 0, lastReviewedAt: undefined }),
      },
      mastery: { w3: { wordId: 'w3', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    // w1 / w4 是新词，w2 是复习词，w3 被掌握记录标记。
    expect(countAvailable(data, NOW)).toEqual({ newWords: 2, reviewWords: 1, mastered: 1 });
  });

  it('SRS 卡片状态为 mastered 的词计入掌握词', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'mastered'),
        w3: makeCard('w3', 'new', { reps: 0, lastReviewedAt: undefined }),
        w4: makeCard('w4', 'new', { reps: 0, lastReviewedAt: undefined }),
      },
    });
    expect(countAvailable(data, NOW)).toEqual({ newWords: 3, reviewWords: 0, mastered: 1 });
  });

  it('脏数据（空词库 / 缺卡片）不抛错', () => {
    expect(countAvailable(makeData(), NOW)).toEqual({
      newWords: 0,
      reviewWords: 0,
      mastered: 0,
    });
    expect(countAvailable(makeData({ words: WORDS }), NOW)).toEqual({
      newWords: 4,
      reviewWords: 0,
      mastered: 0,
    });
  });
});

describe('pickNewWord', () => {
  it('只挑未学过且未掌握的词', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'mastered'),
      },
    });
    const picked = pickNewWord(data, NOW);
    expect(picked).not.toBeNull();
    expect(['w1', 'w4']).toContain(picked?.id);
  });

  it('没有可用新词时返回 null', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'review'),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
        w4: makeCard('w4', 'review'),
      },
    });
    expect(pickNewWord(data, NOW)).toBeNull();
  });

  it('掌握标记的词不会被当作新词', () => {
    const data = makeData({
      words: [WORDS[0]],
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'manual' } as MasteryRecord },
    });
    expect(pickNewWord(data, NOW)).toBeNull();
  });
});

describe('pickReviewWords', () => {
  it('排除掌握词与新词，只留已学未掌握的词', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
        w4: makeCard('w4', 'review'),
      },
      mastery: { w4: { wordId: 'w4', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    const picked = pickReviewWords(data, 10, { now: NOW });
    const ids = picked.map((word) => word.id);
    expect(ids).not.toContain('w1');
    expect(ids).not.toContain('w4');
    expect(ids.sort()).toEqual(['w2', 'w3']);
  });

  it('按薄弱度排序：错得多的词排前面', () => {
    const data = makeData({
      words: WORDS,
      srs: { w2: makeCard('w2', 'review'), w3: makeCard('w3', 'review') },
      attempts: [
        makeAttempt('w2', false, NOW - DAY),
        makeAttempt('w2', false, NOW - DAY),
        makeAttempt('w2', false, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
      ],
    });
    const picked = pickReviewWords(data, 10, { now: NOW });
    expect(picked.map((word) => word.id)).toEqual(['w2', 'w3']);
  });

  it('闪卡「不认识」标记的词排在最前', () => {
    const data = makeData({
      words: WORDS,
      srs: { w2: makeCard('w2', 'review'), w3: makeCard('w3', 'review') },
      reviewPriority: { w3: NOW - 2 * DAY },
    });
    const picked = pickReviewWords(data, 10, { now: NOW });
    expect(picked[0]?.id).toBe('w3');
  });

  it('受 limit 限制，limit ≤ 0 返回空数组', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
        w4: makeCard('w4', 'review'),
      },
    });
    expect(pickReviewWords(data, 2, { now: NOW })).toHaveLength(2);
    expect(pickReviewWords(data, 0, { now: NOW })).toEqual([]);
    expect(pickReviewWords(data, -5, { now: NOW })).toEqual([]);
  });

  it('excludeWordIds 里的词被排除', () => {
    const data = makeData({
      words: WORDS,
      srs: { w2: makeCard('w2', 'review'), w3: makeCard('w3', 'review') },
    });
    const picked = pickReviewWords(data, 10, { now: NOW, excludeWordIds: ['w2'] });
    expect(picked.map((word) => word.id)).toEqual(['w3']);
  });
});

describe('planRound', () => {
  const settings = (overrides: Partial<PracticeSettings> = {}): PracticeSettings => ({
    ...DEFAULT_PRACTICE_SETTINGS,
    ...overrides,
  });

  it('轮次号在上一轮基础上 +1，没有会话时为 1', () => {
    const data = makeData({
      words: WORDS,
      srs: { w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }) },
    });
    expect(planRound(data, settings(), { now: NOW }).roundNo).toBe(1);

    const withSession = makeData({
      words: WORDS,
      srs: { w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }) },
      session: {
        id: 'round_x',
        startedAt: NOW,
        stage: 'done',
        newWordIds: [],
        completedNewWordIds: [],
        reviewWordIds: [],
        answered: 0,
        targetQuestions: 0,
        roundNo: 3,
      },
    });
    expect(planRound(withSession, settings(), { now: NOW }).roundNo).toBe(4);
  });

  it('本轮新词不会同时出现在复习列表里', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
        w4: makeCard('w4', 'review'),
      },
    });
    const plan = planRound(data, settings(), { now: NOW });
    expect(plan.newWord).not.toBeNull();
    expect(plan.reviewWords.map((word) => word.id)).not.toContain(plan.newWord?.id);
  });

  it('复习词数被夹在 4~6，不足时按实际数量', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
      },
    });
    // 只有 2 个可复习词 → 按实际数量返回。
    expect(
      planRound(data, settings({ reviewWordsPerRound: 6 }), { now: NOW }).reviewWords,
    ).toHaveLength(2);
    // 设置 2 被夹到下限 4，候选不足时仍按实际数量。
    expect(
      planRound(data, settings({ reviewWordsPerRound: 2 }), { now: NOW }).reviewWords,
    ).toHaveLength(2);
  });

  it('excludeWordIds 会同时排除新词与复习词', () => {
    const data = makeData({
      words: WORDS,
      srs: {
        w1: makeCard('w1', 'new', { reps: 0, lastReviewedAt: undefined }),
        w2: makeCard('w2', 'review'),
        w3: makeCard('w3', 'review'),
      },
    });
    const plan = planRound(data, settings(), { now: NOW, excludeWordIds: ['w1', 'w2'] });
    expect(plan.newWord?.id).not.toBe('w1');
    expect(plan.reviewWords.map((word) => word.id)).not.toContain('w2');
  });

  it('计划 id 互不相同', () => {
    const data = makeData({ words: WORDS });
    expect(planRound(data, settings(), { now: NOW }).id).not.toBe(
      planRound(data, settings(), { now: NOW }).id,
    );
  });
});

describe('scoreReviewWord', () => {
  it('错得多的词分数更高', () => {
    const data = makeData({
      words: WORDS,
      srs: { w2: makeCard('w2', 'review'), w3: makeCard('w3', 'review') },
      attempts: [
        makeAttempt('w2', false, NOW - DAY),
        makeAttempt('w2', false, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
      ],
    });
    expect(scoreReviewWord(data, WORDS[1], NOW)).toBeGreaterThan(
      scoreReviewWord(data, WORDS[2], NOW),
    );
  });

  it('脏数据（空数据 / 空词）返回 0，不抛错', () => {
    expect(scoreReviewWord(makeData(), WORDS[0], NOW)).toBe(0);
    expect(scoreReviewWord(makeData(), null as unknown as Word, NOW)).toBe(0);
  });
});

describe('每轮多个新词（settings.newWordsPerRound）', () => {
  it('按设置取多个新词，且这些词不进复习列表', () => {
    const data = makeData({
      words: [
        makeWord('n1', 'abandon', '放弃'),
        makeWord('n2', 'benefit', '益处'),
        makeWord('n3', 'capable', '有能力'),
        makeWord('n4', 'derive', '得到'),
      ],
    });
    const plan = planRound(data, { ...DEFAULT_PRACTICE_SETTINGS, newWordsPerRound: 3 }, { now: NOW });
    expect(plan.newWords).toHaveLength(3);
    expect(plan.newWord?.id).toBe(plan.newWords[0]?.id);
    const newIds = plan.newWords.map((word) => word.id);
    for (const id of newIds) expect(plan.reviewWords.some((word) => word.id === id)).toBe(false);
  });

  it('新词数被夹在 1~10 之间', () => {
    const data = makeData({
      words: Array.from({ length: 12 }, (_, index) =>
        makeWord(`n${index + 1}`, `term${index + 1}`, `释义${index + 1}`),
      ),
    });
    const high = planRound(data, { ...DEFAULT_PRACTICE_SETTINGS, newWordsPerRound: 99 }, { now: NOW });
    expect(high.newWords.length).toBeLessThanOrEqual(10);
    const low = planRound(data, { ...DEFAULT_PRACTICE_SETTINGS, newWordsPerRound: 0 }, { now: NOW });
    expect(low.newWords.length).toBe(1);
  });
});
