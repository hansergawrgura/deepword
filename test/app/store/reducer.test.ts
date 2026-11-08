import { describe, expect, it } from 'vitest';
import type { Skill, Word } from '@/domain/types';
import { emptyAppData } from '@/domain/fixtures';
import { appReducer } from '@/app/store/reducer';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

const WORD: Word = {
  id: 'w1',
  term: 'hello',
  meaning: '你好',
  tags: [],
  createdAt: NOW,
};

function record(
  data: ReturnType<typeof emptyAppData>,
  partial: {
    correct: boolean;
    createdAt?: number;
    skill: Skill;
    roundId?: string;
  },
) {
  const now = partial.createdAt ?? NOW;
  return appReducer(data, {
    type: 'RECORD_ATTEMPT',
    wordId: WORD.id,
    skill: partial.skill,
    correct: partial.correct,
    roundId: partial.roundId,
    now,
  });
}

describe('appReducer recordAttempt', () => {
  it('写入作答并更新错题（lastSkill）', () => {
    const base = emptyAppData({ words: [WORD] });
    const next = appReducer(base, {
      type: 'RECORD_ATTEMPT',
      wordId: WORD.id,
      skill: 'en2zh',
      correct: false,
      prompt: 'hello',
      now: NOW,
    });
    expect(next.attempts).toHaveLength(1);
    expect(next.attempts[0].skill).toBe('en2zh');
    expect(next.mistakes[WORD.id]?.wrongCount).toBe(1);
    expect(next.mistakes[WORD.id]?.lastSkill).toBe('en2zh');
  });

  it('满足掌握规则时自动写入 rule 掌握标记', () => {
    let data = emptyAppData({ words: [WORD] });
    data = record(data, { correct: true, createdAt: NOW - 20 * DAY, skill: 'en2zh', roundId: 'r1' });
    data = record(data, { correct: true, createdAt: NOW - 10 * DAY, skill: 'zh2en', roundId: 'r2' });
    data = record(data, { correct: true, createdAt: NOW - 1 * DAY, skill: 'spell', roundId: 'r2' });
    expect(data.mastery?.[WORD.id]).toEqual({
      wordId: WORD.id,
      masteredAt: NOW - 1 * DAY,
      source: 'rule',
    });
  });

  it('MARK_MASTERED 写入手动掌握标记', () => {
    const base = emptyAppData({ words: [WORD] });
    const next = appReducer(base, {
      type: 'MARK_MASTERED',
      wordId: WORD.id,
      source: 'manual',
      now: NOW,
    });
    expect(next.mastery?.[WORD.id]?.source).toBe('manual');
  });
});
