import { describe, expect, it } from 'vitest';
import type { AppData, Attempt, MasteryRecord, Skill, Word } from '@/domain/types';
import { emptyAppData } from '@/domain/fixtures';
import { getSkillStats, getWeaknessReport, scoreWordWeakness } from '@/domain/weakness';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function makeWord(id: string, term: string): Word {
  return { id, term, meaning: `${term} 的中文释义`, tags: [], createdAt: NOW - 30 * DAY };
}

function makeAttempt(options: {
  wordId: string;
  correct: boolean;
  createdAt: number;
  skill?: Skill;
}): Attempt {
  const attempt = {
    id: `a_${options.wordId}_${options.createdAt}_${options.correct}`,
    wordId: options.wordId,
    correct: options.correct,
    createdAt: options.createdAt,
    ...(options.skill !== undefined ? { skill: options.skill } : {}),
  };
  return attempt as Attempt;
}

function makeData(overrides: Partial<AppData> = {}): AppData {
  return emptyAppData({
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('getSkillStats', () => {
  it('固定返回 6 个技能，顺序与 SKILLS 一致', () => {
    const stats = getSkillStats(makeData(), NOW, 'en');
    expect(stats.map((stat) => stat.skill)).toEqual([
      'en2zh',
      'zh2en',
      'spell',
      'listen',
      'sentence',
      'translate',
    ]);
    expect(stats[0].label).toBe('EN→ZH');
  });

  it('正确率是百分整数，无作答的技能为 null', () => {
    const data = makeData({
      attempts: [
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - 2 * DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - 3 * DAY, skill: 'en2zh' }),
      ],
    });
    const stats = getSkillStats(data, NOW, 'en');
    const en2zh = stats.find((stat) => stat.skill === 'en2zh');
    expect(en2zh?.attempts).toBe(3);
    expect(en2zh?.correct).toBe(2);
    expect(en2zh?.accuracy).toBe(67);
    expect(en2zh?.lastAt).toBe(NOW - DAY);
    const spell = stats.find((stat) => stat.skill === 'spell');
    expect(spell?.attempts).toBe(0);
    expect(spell?.accuracy).toBeNull();
  });

  it('只统计带 skill 的练习作答：无 skill 的旧题不计入', () => {
    const data = makeData({
      attempts: [
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - DAY }),
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - 2 * DAY }),
      ],
    });
    const stats = getSkillStats(data, NOW, 'en');
    expect(stats.every((stat) => stat.attempts === 0)).toBe(true);
    expect(stats.every((stat) => stat.accuracy === null)).toBe(true);
  });

  it('脏数据（空作答表 / 未来时间戳）不抛错', () => {
    expect(() => getSkillStats(makeData(), NOW, 'en')).not.toThrow();
    const data = makeData({
      attempts: [
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW + DAY, skill: 'en2zh' }),
      ],
    });
    // 未来时间戳按 now 截断，不会出现「负天数」。
    expect(getSkillStats(data, NOW, 'en')[0].lastAt).toBe(NOW);
  });
});

describe('getWeaknessReport', () => {
  const WORDS = [
    makeWord('w1', 'abandon'),
    makeWord('w2', 'candle'),
    makeWord('w3', 'gentle'),
    makeWord('w4', 'harbor'),
    makeWord('w5', 'island'),
    makeWord('w6', 'jungle'),
  ];

  it('没有任何练习记录时：未练习、最弱技能为空、focus 提示先练一轮', () => {
    const report = getWeaknessReport(makeData({ words: WORDS }), { now: NOW, locale: 'en' });
    expect(report.practiced).toBe(false);
    expect(report.weakestSkill).toBeNull();
    expect(report.weakestWords).toEqual([]);
    expect(report.focus).toContain('Finish a round');
  });

  it('最弱技能是正确率最低的那个', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - 2 * DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: true, createdAt: NOW - 3 * DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w2', correct: false, createdAt: NOW - DAY, skill: 'spell' }),
      ],
    });
    const report = getWeaknessReport(data, { now: NOW, locale: 'en' });
    expect(report.practiced).toBe(true);
    expect(report.weakestSkill).toBe('spell');
    expect(report.focus).toContain('most work');
    expect(report.focus).toContain('Spelling');
  });

  it('最弱词只含有过错的词，按薄弱度降序排列', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w2', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w2', correct: false, createdAt: NOW - 2 * DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w3', correct: true, createdAt: NOW - DAY, skill: 'en2zh' }),
      ],
    });
    const report = getWeaknessReport(data, { now: NOW, locale: 'en' });
    expect(report.weakestWords.map((item) => item.word.id)).toEqual(['w2', 'w1']);
    expect(report.weakestWords[0].wrongCount).toBe(2);
    // 从没错过的词没有复习价值，不进最弱词列表。
    expect(report.weakestWords.map((item) => item.word.id)).not.toContain('w3');
  });

  it('最弱词条数受 limit 限制（默认 ≤5）', () => {
    const attempts = WORDS.map((word, index) =>
      makeAttempt({
        wordId: word.id,
        correct: false,
        createdAt: NOW - (index + 1) * DAY,
        skill: 'en2zh',
      }),
    );
    const data = makeData({ words: WORDS, attempts });
    expect(getWeaknessReport(data, { now: NOW, locale: 'en' }).weakestWords).toHaveLength(5);
    expect(getWeaknessReport(data, { limit: 2, now: NOW, locale: 'en' }).weakestWords).toHaveLength(2);
  });

  it('掌握词不进入最弱词列表', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
      ],
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    const report = getWeaknessReport(data, { now: NOW, locale: 'en' });
    expect(report.weakestWords).toEqual([]);
  });
});

describe('scoreWordWeakness', () => {
  const WORDS = [makeWord('w1', 'abandon'), makeWord('w2', 'candle')];

  it('错得多的词分数更高', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w2', correct: true, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w2', correct: true, createdAt: NOW - DAY, skill: 'en2zh' }),
      ],
    });
    expect(scoreWordWeakness(data, 'w1', NOW)).toBeGreaterThan(
      scoreWordWeakness(data, 'w2', NOW),
    );
  });

  it('错误次数越多分数越高（权重口径固定）', () => {
    const data = makeData({
      words: WORDS,
      attempts: [
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
        makeAttempt({ wordId: 'w1', correct: false, createdAt: NOW - DAY, skill: 'en2zh' }),
      ],
    });
    // 3 次错误 × 12 + 正确率 0% × 0.25 + 1 天未复习 × 0.5
    expect(scoreWordWeakness(data, 'w1', NOW)).toBe(61.5);
  });

  it('掌握词与无记录的词得分为 0', () => {
    const data = makeData({
      words: WORDS,
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    expect(scoreWordWeakness(data, 'w1', NOW)).toBe(0);
    expect(scoreWordWeakness(data, 'w2', NOW)).toBe(0);
  });

  it('脏数据（空数据 / 空 wordId）返回 0，不抛错', () => {
    expect(scoreWordWeakness(makeData(), 'w1', NOW)).toBe(0);
    expect(scoreWordWeakness(makeData(), '', NOW)).toBe(0);
    expect(scoreWordWeakness(null as unknown as AppData, 'w1', NOW)).toBe(0);
  });
});
