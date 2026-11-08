import { describe, expect, it } from 'vitest';
import type {
  AppData,
  PracticeSessionState,
  PracticeSettings,
  Question,
  Word,
} from './types';
import { DEFAULT_PRACTICE_SETTINGS } from './types';
import {
  advanceQuestion,
  applyAnswer,
  confirmGate,
  createSession,
  answeredInStage,
  hasResumableSession,
  isRoundComplete,
  nextNewWordGate,
  newQuestionCount,
  rejectGate,
  reviewQuestionCount,
  startNewStage,
  startReviewStage,
  summarizeSession,
} from './practiceRound';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

const WORDS: Word[] = [
  {
    id: 'w1',
    term: 'abandon',
    partOfSpeech: 'v.',
    meaning: '放弃；抛弃',
    example: 'He abandoned the plan last year.',
    exampleTranslation: '他去年放弃了这个计划。',
    tags: [],
    createdAt: 1,
  },
  {
    id: 'w2',
    term: 'candle',
    partOfSpeech: 'n.',
    meaning: '蜡烛',
    example: 'She lit a candle on the table.',
    exampleTranslation: '她在桌上点了一支蜡烛。',
    tags: [],
    createdAt: 2,
  },
  {
    id: 'w3',
    term: 'gentle',
    partOfSpeech: 'adj.',
    meaning: '温和的',
    example: 'He has a gentle manner.',
    exampleTranslation: '他举止温和。',
    tags: [],
    createdAt: 3,
  },
  {
    id: 'w4',
    term: 'harbor',
    partOfSpeech: 'n.',
    meaning: '港口',
    example: 'The ship entered the harbor.',
    exampleTranslation: '船驶入了港口。',
    tags: [],
    createdAt: 4,
  },
  {
    id: 'w5',
    term: 'island',
    partOfSpeech: 'n.',
    meaning: '岛屿',
    example: 'They sailed to a small island.',
    exampleTranslation: '他们驶向一座小岛。',
    tags: [],
    createdAt: 5,
  },
  {
    id: 'w6',
    term: 'jungle',
    partOfSpeech: 'n.',
    meaning: '丛林',
    example: 'The jungle is dense here.',
    exampleTranslation: '这里的丛林很茂密。',
    tags: [],
    createdAt: 6,
  },
];

function settings(overrides: Partial<PracticeSettings> = {}): PracticeSettings {
  return { ...DEFAULT_PRACTICE_SETTINGS, ...overrides };
}

function context(overrides: Partial<Parameters<typeof startNewStage>[2]> = {}) {
  return {
    words: WORDS,
    settings: settings(),
    ttsAvailable: true,
    aiAvailable: true,
    ...overrides,
  };
}

const SAMPLE_QUESTION: Question = {
  id: 'ex_1',
  wordId: 'w1',
  prompt: '「abandon」最接近以下哪个意思？',
  options: ['放弃；抛弃', '蜡烛'],
  answer: '放弃；抛弃',
  explanation: '解析',
  difficulty: 2,
  skill: 'en2zh',
};

/** 会话里的题目数组（questions 是可选字段，缺省按空数组处理）。 */
function questionsOf(session: PracticeSessionState): Question[] {
  return session.questions ?? [];
}

describe('createSession', () => {
  it('有新词时进入 gate 阶段并等待「认识 / 掌握」选择', () => {
    const session = createSession(
      { newWord: WORDS[0], reviewWords: [WORDS[1], WORDS[2]] },
      { roundNo: 3, now: NOW },
    );
    expect(session.stage).toBe('gate');
    expect(session.gate).toBe('ask');
    expect(session.currentWordId).toBe(WORDS[0].id);
    expect(session.newWordIds).toEqual([WORDS[0].id]);
    expect(session.reviewWordIds).toEqual([WORDS[1].id, WORDS[2].id]);
    expect(session.answered).toBe(0);
    expect(session.targetQuestions).toBe(0);
    expect(session.roundNo).toBe(3);
    expect(session.questions).toEqual([]);
    expect(session.questionIndex).toBe(0);
    expect(session.results).toEqual([]);
    expect(session.startedAt).toBe(NOW);
  });

  it('没有新词时直接从复习阶段开始', () => {
    const session = createSession({ newWord: null, reviewWords: [WORDS[1]] });
    expect(session.stage).toBe('review');
    expect(session.gate).toBeNull();
    expect(session.newWordIds).toEqual([]);
    expect(session.currentWordId).toBeUndefined();
  });

  it('每轮会话 id 互不相同', () => {
    const a = createSession({ newWord: WORDS[0], reviewWords: [] });
    const b = createSession({ newWord: WORDS[0], reviewWords: [] });
    expect(a.id).not.toBe(b.id);
  });
});

describe('confirmGate / rejectGate', () => {
  it('点「掌握」只翻面追问，不直接出题', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const confirmed = confirmGate(session);
    expect(confirmed.gate).toBe('confirm');
    expect(confirmed.stage).toBe('gate');
    expect(confirmed.questions).toEqual([]);
  });

  it('不在闸门阶段时 confirmGate 不改变会话', () => {
    const session = createSession({ newWord: null, reviewWords: [WORDS[1]] });
    expect(confirmGate(session)).toBe(session);
  });

  it('点「不认识」直接出题并进入 new 阶段', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const next = rejectGate(session, WORDS[0], context());
    expect(next.stage).toBe('new');
    expect(next.gate).toBeNull();
    expect(next.currentWordId).toBe(WORDS[0].id);
    expect(next.questionIndex).toBe(0);
    expect(questionsOf(next).length).toBeGreaterThan(0);
    expect(next.targetQuestions).toBe(questionsOf(next).length);
  });
});

describe('newQuestionCount / startNewStage', () => {
  it('新词题量被夹在 4~8 之间', () => {
    expect(newQuestionCount(settings({ questionsPerNewWord: 2 }))).toBe(4);
    expect(newQuestionCount(settings({ questionsPerNewWord: 6 }))).toBe(6);
    expect(newQuestionCount(settings({ questionsPerNewWord: 99 }))).toBe(8);
    expect(newQuestionCount(settings({ questionsPerNewWord: Number.NaN }))).toBe(6);
  });

  it('startNewStage 生成的题数等于 newQuestionCount(settings)', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const next = startNewStage(session, WORDS[0], context());
    expect(questionsOf(next).length).toBe(newQuestionCount(settings()));
    expect(next.stage).toBe('new');
    expect(next.questionIndex).toBe(0);
    expect(next.targetQuestions).toBe(questionsOf(next).length);
  });

  it('设置成 4 题 / 8 题时题量同步变化', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const four = startNewStage(
      session,
      WORDS[0],
      context({ settings: settings({ questionsPerNewWord: 4 }) }),
    );
    expect(questionsOf(four).length).toBe(4);
    const eight = startNewStage(
      session,
      WORDS[0],
      context({ settings: settings({ questionsPerNewWord: 20 }) }),
    );
    expect(questionsOf(eight).length).toBe(8);
  });
});

describe('reviewQuestionCount / startReviewStage', () => {
  it('复习题量夹在 [词数, 2×词数] 之间', () => {
    expect(reviewQuestionCount(settings({ reviewQuestionsPerRound: 10 }), 4)).toBe(8);
    expect(reviewQuestionCount(settings({ reviewQuestionsPerRound: 10 }), 6)).toBe(10);
    expect(reviewQuestionCount(settings({ reviewQuestionsPerRound: 2 }), 4)).toBe(4);
    expect(reviewQuestionCount(settings({ reviewQuestionsPerRound: 100 }), 4)).toBe(8);
  });

  it('startReviewStage 生成的题量落在 [词数, 2×词数]，且每个复习词都有题', () => {
    const session = createSession({ newWord: null, reviewWords: [] });
    const reviewWords = WORDS.slice(0, 4);
    const next = startReviewStage(session, reviewWords, context());
    expect(next.stage).toBe('review');
    expect(next.gate).toBeNull();
    expect(next.currentWordId).toBeUndefined();
    expect(next.questionIndex).toBe(0);
    expect(questionsOf(next).length).toBeGreaterThanOrEqual(reviewWords.length);
    expect(questionsOf(next).length).toBeLessThanOrEqual(reviewWords.length * 2);
    const ids = new Set(questionsOf(next).map((question) => question.wordId));
    for (const word of reviewWords) {
      expect(ids.has(word.id)).toBe(true);
    }
  });

  it('复习题量受设置影响（默认 10 题、6 个词）', () => {
    const session = createSession({ newWord: null, reviewWords: [] });
    const reviewWords = WORDS.slice(0, 6);
    const next = startReviewStage(session, reviewWords, context());
    expect(questionsOf(next).length).toBe(10);
    expect(questionsOf(next).length).toBeLessThanOrEqual(reviewWords.length * 2);
  });
});

describe('applyAnswer', () => {
  it('作答后 answered 与 results 递增，并记录完整结果字段', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const next = applyAnswer(
      session,
      SAMPLE_QUESTION,
      '蜡烛',
      {
        correct: false,
        verdict: 'poor',
        aiFeedback: '讲解',
        aiImprovement: '改进建议',
        aiStatus: 'ok',
        latencyMs: 1200,
      },
      NOW,
    );
    expect(next.answered).toBe(1);
    expect(next.results).toHaveLength(1);
    expect(next.results?.[0]).toMatchObject({
      questionId: 'ex_1',
      wordId: 'w1',
      skill: 'en2zh',
      prompt: SAMPLE_QUESTION.prompt,
      response: '蜡烛',
      answer: '放弃；抛弃',
      correct: false,
      verdict: 'poor',
      aiFeedback: '讲解',
      aiImprovement: '改进建议',
      aiStatus: 'ok',
      latencyMs: 1200,
      answeredAt: NOW,
    });
  });

  it('作答后题号停在当前题（反馈留在原题），需显式推进才进入下一题', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const answered = applyAnswer(session, SAMPLE_QUESTION, '蜡烛', { correct: false }, NOW);
    expect(answered.questionIndex).toBe(0);
    const advanced = advanceQuestion(answered);
    expect(advanced.questionIndex).toBe(1);
  });

  it('新词阶段作答后把该词记入已完成新词', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const inNew = startNewStage(session, WORDS[0], context());
    const answered = applyAnswer(inNew, SAMPLE_QUESTION, '蜡烛', { correct: false }, NOW);
    expect(answered.completedNewWordIds).toEqual([WORDS[0].id]);
  });

  it('连续作答会不断累加 answered 与 results', () => {
    const session = createSession({ newWord: null, reviewWords: [] });
    let state = session;
    for (let index = 0; index < 3; index += 1) {
      state = applyAnswer(state, SAMPLE_QUESTION, '放弃；抛弃', { correct: true }, NOW + index);
    }
    expect(state.answered).toBe(3);
    expect(state.results).toHaveLength(3);
    expect(state.results?.every((result) => result.correct)).toBe(true);
  });
});

describe('isRoundComplete', () => {
  it('已答题数达到题目总数才算完成', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const inNew = startNewStage(session, WORDS[0], context());
    let state = inNew;
    for (let index = 0; index < questionsOf(inNew).length; index += 1) {
      state = applyAnswer(state, questionsOf(inNew)[index], 'x', { correct: true }, NOW + index);
    }
    expect(isRoundComplete(state)).toBe(true);
  });

  it('还没答完时不算完成；没有题目时也不算完成', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const inNew = startNewStage(session, WORDS[0], context());
    expect(isRoundComplete(inNew)).toBe(false);
    expect(isRoundComplete(createSession({ newWord: null, reviewWords: [] }))).toBe(false);
  });
});

describe('summarizeSession', () => {
  it('汇总总题数、正确数、正确率与各技能分布', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    const inNew = startNewStage(session, WORDS[0], context());
    const spellQuestion: Question = {
      ...SAMPLE_QUESTION,
      id: 'ex_2',
      skill: 'spell',
    };
    let state = applyAnswer(inNew, SAMPLE_QUESTION, '蜡烛', { correct: false }, NOW);
    state = applyAnswer(state, spellQuestion, 'abandon', { correct: true }, NOW + 1);
    const summary = summarizeSession(state);
    expect(summary.total).toBe(2);
    expect(summary.correct).toBe(1);
    expect(summary.accuracy).toBe(50);
    expect(summary.bySkill.en2zh).toEqual({ total: 1, correct: 0 });
    expect(summary.bySkill.spell).toEqual({ total: 1, correct: 1 });
  });

  it('没有作答时正确率为 0 且没有技能分桶', () => {
    const summary = summarizeSession(createSession({ newWord: null, reviewWords: [] }));
    expect(summary.total).toBe(0);
    expect(summary.correct).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(Object.keys(summary.bySkill)).toHaveLength(0);
  });
});

describe('hasResumableSession', () => {
  function dataWith(session: PracticeSessionState | null): AppData {
    return { session } as unknown as AppData;
  }

  it('没有会话时不可恢复', () => {
    expect(hasResumableSession(dataWith(null))).toBe(false);
  });

  it('闸门阶段（有新词待确认）可恢复', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [] });
    expect(hasResumableSession(dataWith(session))).toBe(true);
  });

  it('已出题的新词 / 复习阶段可恢复', () => {
    const session = startNewStage(
      createSession({ newWord: WORDS[0], reviewWords: [] }),
      WORDS[0],
      context(),
    );
    expect(hasResumableSession(dataWith(session))).toBe(true);
  });

  it('已结束（done）或没有题目的空会话不可恢复', () => {
    const done = { ...createSession({ newWord: null, reviewWords: [] }), stage: 'done' as const };
    expect(hasResumableSession(dataWith(done))).toBe(false);
    const empty = createSession({ newWord: null, reviewWords: [WORDS[1]] });
    expect(hasResumableSession(dataWith(empty))).toBe(false);
  });
});

describe('多新词轮次（nextNewWordGate）', () => {
  it('待处理新词按顺序推进，处理完后返回 null', () => {
    const words = [WORDS[0], WORDS[1]];
    const session = createSession({ newWords: words, reviewWords: [] }, { roundNo: 1, now: NOW });
    expect(session.newWordIds).toEqual([WORDS[0].id, WORDS[1].id]);
    expect(session.stage).toBe('gate');

    const gate = nextNewWordGate(session);
    expect(gate?.currentWordId).toBe(WORDS[0].id);
    expect(gate?.stage).toBe('gate');

    const afterFirst = { ...(gate as PracticeSessionState), completedNewWordIds: [WORDS[0].id] };
    expect(nextNewWordGate(afterFirst)?.currentWordId).toBe(WORDS[1].id);
    expect(nextNewWordGate({ ...afterFirst, completedNewWordIds: [WORDS[0].id, WORDS[1].id] })).toBe(null);
  });
});

describe('isRoundComplete 按阶段计（results 跨阶段累加）', () => {
  it('新词阶段答满后进入复习阶段，复习阶段不会因历史结果提前完成', () => {
    const session = createSession({ newWord: WORDS[0], reviewWords: [WORDS[1], WORDS[2]] });
    const newStage = startNewStage(session, WORDS[0], {
      words: WORDS,
      settings: { ...DEFAULT_PRACTICE_SETTINGS },
      ttsAvailable: false,
      aiAvailable: false,
    });
    let state = newStage;
    for (const question of newStage.questions ?? []) {
      state = applyAnswer(state, question, 'x', { correct: true });
    }
    expect(state.results?.length).toBe(newStage.questions?.length);

    const review = startReviewStage(state, [WORDS[1], WORDS[2]], {
      words: WORDS,
      settings: { ...DEFAULT_PRACTICE_SETTINGS },
      ttsAvailable: false,
      aiAvailable: false,
    });
    // 历史 results 仍在，但复习阶段尚未作答 → 不算完成。
    expect(isRoundComplete(review)).toBe(false);
    expect(answeredInStage(review)).toBe(0);
  });
});
