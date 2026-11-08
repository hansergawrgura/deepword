/**
 * 一轮选词与题量规划单测（v3）。
 */

import { describe, expect, it } from 'vitest';
import type { AppData, Attempt, MasteryRecord, PracticeSettings, Skill, Word } from '@/domain/types';
import { DEFAULT_PRACTICE_SETTINGS } from '@/domain/types';
import { emptyAppData } from '@/domain/fixtures';

import { countAvailable, pickNewWord, pickReviewWords, planRound, scoreReviewWord } from '@/domain/rounds';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function makeWord(id: string, term: string, meaning: string): Word {
  return { id, term, meaning, tags: [], createdAt: NOW - 30 * DAY };
}

function makeAttempt(
  wordId: string,
  correct: boolean,
  createdAt: number,
  skill: Skill = 'en2zh',
): Attempt {
  return {
    id: `a_${wordId}_${createdAt}_${correct}`,
    wordId,
    correct,
    skill,
    createdAt,
  };
}

function makeData(overrides: Partial<AppData> = {}): AppData {
  return emptyAppData({
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
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
      attempts: [makeAttempt('w2', true, NOW - DAY)],
      mastery: { w3: { wordId: 'w3', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    expect(countAvailable(data, NOW)).toEqual({ newWords: 2, reviewWords: 1, mastered: 1 });
  });

  it('脏数据（空词库）不抛错', () => {
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
  it('只挑无作答且未掌握的词', () => {
    const data = makeData({
      words: WORDS,
      attempts: [makeAttempt('w2', true, NOW - DAY)],
      mastery: { w3: { wordId: 'w3', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    const picked = pickNewWord(data, NOW);
    expect(picked).not.toBeNull();
    expect(['w1', 'w4']).toContain(picked?.id);
  });

  it('没有可用新词时返回 null', () => {
    const data = makeData({
      words: WORDS,
      attempts: WORDS.map((word, index) => makeAttempt(word.id, true, NOW - index * DAY)),
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
  it('排除掌握词与新词，只留有作答未掌握的词', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt('w2', true, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
        makeAttempt('w4', true, NOW - DAY),
      ],
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

  it('受 limit 限制，limit ≤ 0 返回空数组', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt('w2', true, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
        makeAttempt('w4', true, NOW - DAY),
      ],
    });
    expect(pickReviewWords(data, 2, { now: NOW })).toHaveLength(2);
    expect(pickReviewWords(data, 0, { now: NOW })).toEqual([]);
    expect(pickReviewWords(data, -5, { now: NOW })).toEqual([]);
  });

  it('excludeWordIds 里的词被排除', () => {
    const data = makeData({
      words: WORDS,
      attempts: [makeAttempt('w2', true, NOW - DAY), makeAttempt('w3', true, NOW - DAY)],
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
    const data = makeData({ words: WORDS });
    expect(planRound(data, settings(), { now: NOW }).roundNo).toBe(1);

    const withSession = makeData({
      words: WORDS,
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
      attempts: [
        makeAttempt('w2', true, NOW - DAY),
        makeAttempt('w3', true, NOW - DAY),
        makeAttempt('w4', true, NOW - DAY),
      ],
    });
    const plan = planRound(data, settings(), { now: NOW });
    expect(plan.newWord).not.toBeNull();
    expect(plan.reviewWords.map((word) => word.id)).not.toContain(plan.newWord?.id);
  });

  it('复习词数被夹在 4~6，不足时按实际数量', () => {
    const data = makeData({
      words: WORDS,
      attempts: [makeAttempt('w2', true, NOW - DAY), makeAttempt('w3', true, NOW - DAY)],
    });
    expect(planRound(data, settings({ reviewWordsPerRound: 6 }), { now: NOW }).reviewWords).toHaveLength(
      2,
    );
    expect(planRound(data, settings({ reviewWordsPerRound: 2 }), { now: NOW }).reviewWords).toHaveLength(
      2,
    );
  });

  it('excludeWordIds 会同时排除新词与复习词', () => {
    const data = makeData({
      words: WORDS,
      attempts: [makeAttempt('w2', true, NOW - DAY), makeAttempt('w3', true, NOW - DAY)],
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
