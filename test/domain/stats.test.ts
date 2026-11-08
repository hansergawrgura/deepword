import { describe, expect, it } from 'vitest';
import type { AppData, Attempt, DailyStat, Mistake, Word } from '@/domain/types';
import { DEFAULT_PRACTICE_SETTINGS } from '@/domain/types';
import { emptyAppData } from '@/domain/fixtures';
import { dayKey } from '@/domain/utils';
import {
  accuracyForWord,
  computeStreak,
  emptyDaily,
  getAccuracy,
  getHeatmap,
  getMasteryBreakdown,
  getMistakeList,
  getOverview,
  getWeakWords,
  pruneDaily,
  recordDailyEvent,
} from '@/domain/stats';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function word(id: string, term: string): Word {
  return {
    id,
    term,
    meaning: `${term} 的中文释义`,
    tags: [],
    createdAt: NOW - 10 * DAY,
  };
}

function attempt(wordId: string, correct: boolean, createdAt: number): Attempt {
  return {
    id: `a_${wordId}_${createdAt}_${correct}`,
    wordId,
    skill: 'en2zh',
    correct,
    createdAt,
  };
}

function fixture(): AppData {
  const words = [word('w1', 'abandon'), word('w2', 'meticulous'), word('w3', 'resilient')];
  const mistakes: Record<string, Mistake> = {
    w1: {
      wordId: 'w1',
      wrongCount: 3,
      correctStreak: 0,
      firstWrongAt: NOW - 3 * DAY,
      lastWrongAt: NOW - DAY,
      lastAttemptAt: NOW - DAY,
    },
    w2: {
      wordId: 'w2',
      wrongCount: 1,
      correctStreak: 2,
      firstWrongAt: NOW - 2 * DAY,
      lastWrongAt: NOW - 2 * DAY,
      lastAttemptAt: NOW - DAY,
    },
  };
  return emptyAppData({
    words,
    attempts: [
      attempt('w1', false, NOW - DAY),
      attempt('w1', false, NOW - 2 * DAY),
      attempt('w1', true, NOW - 3 * DAY),
      attempt('w2', true, NOW - DAY),
      attempt('w2', false, NOW - 4 * DAY),
    ],
    mistakes,
    practice: { ...DEFAULT_PRACTICE_SETTINGS },
    stats: {
      daily: {
        [dayKey(NOW)]: { reviewed: 5, correct: 4, wrong: 1, learned: 2 },
      },
    },
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW,
  });
}

function dayKeyOffset(offset: number): string {
  const date = new Date(NOW);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

describe('每日统计', () => {
  it('recordDailyEvent 累加次数与对错，不修改原对象', () => {
    const base = { daily: {} };
    const once = recordDailyEvent(base, { now: NOW, correct: true, learned: true });
    const twice = recordDailyEvent(once, { now: NOW, correct: false });
    const day = twice.daily[dayKeyOffset(0)];
    expect(day).toEqual({ reviewed: 2, correct: 1, wrong: 1, learned: 1 });
    expect(base.daily).toEqual({});
  });

  it('computeStreak 统计连续天数并容忍今天尚未学习', () => {
    const daily: Record<string, DailyStat> = {
      [dayKeyOffset(-3)]: { ...emptyDaily(), reviewed: 1 },
      [dayKeyOffset(-2)]: { ...emptyDaily(), reviewed: 2 },
      [dayKeyOffset(-1)]: { ...emptyDaily(), reviewed: 3 },
    };
    expect(computeStreak(daily, NOW)).toBe(3);

    daily[dayKeyOffset(0)] = { ...emptyDaily(), reviewed: 1 };
    expect(computeStreak(daily, NOW)).toBe(4);

    delete daily[dayKeyOffset(-1)];
    expect(computeStreak(daily, NOW)).toBe(1);
  });

  it('pruneDaily 只保留窗口内的日期', () => {
    const trimmed = pruneDaily(
      {
        daily: {
          [dayKeyOffset(-500)]: { ...emptyDaily(), reviewed: 1 },
          [dayKeyOffset(-1)]: { ...emptyDaily(), reviewed: 2 },
        },
      },
      400,
      NOW,
    );
    expect(Object.keys(trimmed.daily)).toEqual([dayKeyOffset(-1)]);
  });

  it('getAccuracy 按时间窗口计算', () => {
    const attempts = [
      attempt('w1', true, NOW),
      attempt('w1', false, NOW - DAY),
      attempt('w1', true, NOW - 10 * DAY),
    ];
    expect(getAccuracy(attempts, { days: 7, now: NOW })).toBe(50);
    expect(getAccuracy(attempts, { now: NOW })).toBe(67);
    expect(getAccuracy([], { now: NOW })).toBeNull();
  });

  it('getHeatmap 返回固定长度的日期序列', () => {
    const cells = getHeatmap({}, 28, NOW);
    expect(cells).toHaveLength(28);
    expect(cells[27].key).toBe(dayKeyOffset(0));
    expect(cells[0].key).toBe(dayKeyOffset(-27));
    expect(cells.every((cell) => cell.level === 0)).toBe(true);
  });
});

describe('单词统计与弱词排序', () => {
  it('accuracyForWord 只统计该词的最近作答', () => {
    expect(accuracyForWord(fixture().attempts, 'w1')).toBe(33);
    expect(accuracyForWord(fixture().attempts, 'w3')).toBeNull();
  });

  it('错词列表按错误次数优先，已连对者排后', () => {
    const list = getMistakeList(fixture(), NOW);
    expect(list.map((item) => item.word.id)).toEqual(['w1', 'w2']);
    expect(list[0].wrongCount).toBe(3);
    expect(list[1].correctStreak).toBe(2);
  });

  it('getWeakWords 优先返回答错更多的词', () => {
    const weak = getWeakWords(fixture(), 5, { now: NOW });
    expect(weak.length).toBeGreaterThan(0);
    expect(weak[0].word.id).toBe('w1');
  });

  it('getMistakeList 不包含从未答错的词', () => {
    const ids = getMistakeList(fixture(), NOW).map((item) => item.word.id);
    expect(ids).not.toContain('w3');
  });

  it('getMasteryBreakdown 汇总四种状态', () => {
    const breakdown = getMasteryBreakdown(fixture());
    expect(breakdown.new).toBe(1);
    expect(breakdown.learning + breakdown.review + breakdown.mastered).toBe(2);
  });
});

describe('getOverview', () => {
  it('汇总词库、今日、连击与错题数据', () => {
    const overview = getOverview(fixture(), NOW);
    expect(overview.totalWords).toBe(3);
    expect(overview.learnedWords).toBe(2);
    expect(overview.newCount).toBe(1);
    expect(overview.dueCount).toBeGreaterThanOrEqual(0);
    expect(overview.todayReviewed).toBe(5);
    expect(overview.todayAccuracy).toBe(80);
    expect(overview.streak).toBe(1);
    expect(overview.mistakeCount).toBe(2);
    expect(overview.unresolvedMistakes).toBe(1);
    expect(overview.todayProgress).toBeGreaterThan(0);
  });
});
