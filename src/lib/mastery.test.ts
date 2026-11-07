/**
 * 掌握判定单测（vitest / node 环境）。
 *
 * 口径来源：docs/phase-b-contract.md 第 3 节。
 * 覆盖四条规则（连续 3 次全对 / 覆盖 ≥2 技能 / 14 天无错 / 分布 ≥2 轮次）各自的命中与不命中，
 * 缺 roundId 的旧作答合并为 legacy 轮次，以及 isMastered 对手动 / 规则两种来源的识别。
 */

import { describe, expect, it } from 'vitest';
import type { AppData, Attempt, MasteryRecord, Skill } from '../types';
import { DATA_VERSION, DEFAULT_PRACTICE_SETTINGS } from '../types';
import { evaluateMastery, isMastered, LEGACY_ROUND_ID, MASTERY_RULES } from './mastery';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function makeData(attempts: Attempt[], overrides: Partial<AppData> = {}): AppData {
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
    attempts,
    mistakes: {},
    theme: 'light',
    stats: { daily: {} },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAttempt(options: {
  wordId?: string;
  correct: boolean;
  createdAt: number;
  skill?: Skill;
  roundId?: string;
  kind?: Attempt['kind'];
}): Attempt {
  return {
    id: `a_${options.createdAt}_${options.correct}_${options.skill ?? 'none'}`,
    wordId: options.wordId ?? 'w1',
    kind: options.kind ?? 'exercise',
    correct: options.correct,
    skill: options.skill,
    roundId: options.roundId,
    createdAt: options.createdAt,
  };
}

/** 满足全部四条规则的作答：3 次全对、2 个技能、2 个轮次、超过 14 天无错。 */
function passingAttempts(): Attempt[] {
  return [
    makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh', roundId: 'r1' }),
    makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en', roundId: 'r2' }),
    makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'spell', roundId: 'r2' }),
  ];
}

describe('evaluateMastery：四条规则', () => {
  it('规则 1~4 全部满足时判定为已掌握', () => {
    const check = evaluateMastery(makeData(passingAttempts()), 'w1', NOW);
    expect(check.eligible).toBe(true);
    expect(check.reasons).toEqual([]);
    expect(check.streak).toBe(3);
    expect(check.skills).toEqual(['en2zh', 'zh2en', 'spell']);
    expect(check.roundIds).toEqual(['r2', 'r1']);
    expect(check.errorFreeDays).toBe(20);
  });

  it('规则 1（连续 3 次全对）不满足：只有 2 次连续答对', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en', roundId: 'r2' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.eligible).toBe(false);
    expect(check.streak).toBe(2);
    expect(check.reasons.join('')).toContain('连续答对');
  });

  it('规则 1 遇错即止：最近一次答错打断连对', () => {
    const attempts = [
      makeAttempt({ correct: false, createdAt: NOW - 1 * DAY, skill: 'en2zh', roundId: 'r2' }),
      makeAttempt({ correct: true, createdAt: NOW - 2 * DAY, skill: 'zh2en', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 3 * DAY, skill: 'spell', roundId: 'r1' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.streak).toBe(0);
    expect(check.eligible).toBe(false);
  });

  it('规则 2（覆盖 ≥2 技能）不满足：3 次全对但只有 1 个技能', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'en2zh', roundId: 'r2' }),
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'en2zh', roundId: 'r2' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.eligible).toBe(false);
    expect(check.skills).toEqual(['en2zh']);
    expect(check.reasons.join('')).toContain('技能');
  });

  it('规则 3（14 天无错）不满足：最近一次答错在 8 天前', () => {
    const attempts = [
      makeAttempt({ correct: false, createdAt: NOW - 8 * DAY, skill: 'en2zh', roundId: 'r0' }),
      makeAttempt({ correct: true, createdAt: NOW - 6 * DAY, skill: 'en2zh', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 4 * DAY, skill: 'zh2en', roundId: 'r2' }),
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'spell', roundId: 'r2' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.streak).toBe(3);
    expect(check.errorFreeDays).toBe(8);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join('')).toContain('14 天');
  });

  it('规则 3 从未答错时按首次练习作答算天数', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 5 * DAY, skill: 'en2zh', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 4 * DAY, skill: 'zh2en', roundId: 'r2' }),
      makeAttempt({ correct: true, createdAt: NOW - 3 * DAY, skill: 'spell', roundId: 'r2' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.errorFreeDays).toBe(5);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join('')).toContain('14 天');
  });

  it('规则 4（分布 ≥2 轮次）不满足：3 次全对都在同一轮', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en', roundId: 'r1' }),
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'spell', roundId: 'r1' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.roundIds).toEqual(['r1']);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join('')).toContain('轮次');
  });

  it('缺 roundId 的旧作答合并为一个 legacy 轮次', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh' }),
      makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en' }),
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'spell' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.roundIds).toEqual([LEGACY_ROUND_ID]);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join('')).toContain('轮次');
  });

  it('legacy 作答与带 roundId 的作答算作两个轮次', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh' }),
      makeAttempt({ correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en', roundId: 'r2' }),
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, skill: 'spell', roundId: 'r2' }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.roundIds).toContain(LEGACY_ROUND_ID);
    expect(check.roundIds).toContain('r2');
    expect(check.eligible).toBe(true);
  });

  it('已有掌握标记（手动 / 规则）时直接判定为已掌握', () => {
    const manual = makeData([], {
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'manual' } as MasteryRecord },
    });
    const rule = makeData([], {
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    expect(evaluateMastery(manual, 'w1', NOW).eligible).toBe(true);
    expect(evaluateMastery(manual, 'w1', NOW).reasons).toEqual([]);
    expect(evaluateMastery(rule, 'w1', NOW).eligible).toBe(true);
  });

  it('没有作答且没有掌握标记时不满足，并给出原因', () => {
    const check = evaluateMastery(makeData([]), 'w1', NOW);
    expect(check.eligible).toBe(false);
    expect(check.streak).toBe(0);
    expect(check.reasons.join('')).toContain('练习作答');
  });

  it('闪卡自评与无 skill 的旧题不参与掌握判定', () => {
    const attempts = [
      makeAttempt({ correct: true, createdAt: NOW - 1 * DAY, kind: 'flashcard' }),
      makeAttempt({ correct: true, createdAt: NOW - 2 * DAY, skill: undefined }),
    ];
    const check = evaluateMastery(makeData(attempts), 'w1', NOW);
    expect(check.streak).toBe(0);
    expect(check.eligible).toBe(false);
  });

  it('脏数据（空数据 / 空作答表 / 空 wordId）不抛错', () => {
    expect(() => evaluateMastery(makeData([]), '', NOW)).not.toThrow();
    expect(evaluateMastery(makeData([]), '', NOW).eligible).toBe(false);
    expect(
      evaluateMastery(makeData(undefined as unknown as Attempt[]), 'w1', NOW).eligible,
    ).toBe(false);
  });

  it('规则阈值与契约一致', () => {
    expect(MASTERY_RULES).toEqual({
      consecutiveCorrect: 3,
      minSkills: 2,
      errorFreeDays: 14,
      minRounds: 2,
    });
  });
});

describe('isMastered', () => {
  it('认识手动标记的掌握词', () => {
    const data = makeData([], {
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'manual' } as MasteryRecord },
    });
    expect(isMastered(data, 'w1')).toBe(true);
  });

  it('认识规则标记的掌握词', () => {
    const data = makeData([], {
      mastery: { w1: { wordId: 'w1', masteredAt: NOW, source: 'rule' } as MasteryRecord },
    });
    expect(isMastered(data, 'w1')).toBe(true);
  });

  it('SRS 卡片状态为 mastered 也算已掌握', () => {
    const data = makeData([], {
      srs: {
        w1: {
          wordId: 'w1',
          status: 'mastered',
          ease: 2.5,
          interval: 10,
          dueAt: NOW,
          reps: 5,
          lapses: 0,
        },
      },
    });
    expect(isMastered(data, 'w1')).toBe(true);
  });

  it('没有掌握记录时不算已掌握；脏数据不抛错', () => {
    expect(isMastered(makeData([]), 'w1')).toBe(false);
    expect(isMastered(makeData([]), '')).toBe(false);
    expect(isMastered(null as unknown as AppData, 'w1')).toBe(false);
  });
});
