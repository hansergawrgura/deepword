/**
 * 本地兜底出题器 + 内置词库的测试。
 *
 * 重点保证 UI 的判分假设不被破坏：
 * - 选择题 answer 严格等于某个选项原文；
 * - 填空 prompt 含 ____，acceptableAnswers 覆盖答案；
 * - 单次练习优先错词、覆盖不同单词、类型混合；
 * - 词库本身去重、字段完整。
 */

import { describe, expect, it } from 'vitest';
import { SEED_WORDS } from '../data/wordbank';
import { buildLocalExercises } from './fallbackExercises';
import type { Exercise, Mistake, Word, WordInput } from '../types';

const LEVEL_TAGS = ['CET-4', 'CET-6', '考研', '雅思'];

function buildWord(seed: WordInput, index: number): Word {
  return {
    id: `word-${index}`,
    term: seed.term,
    phonetic: seed.phonetic,
    partOfSpeech: seed.partOfSpeech,
    meaning: seed.meaning,
    example: seed.example,
    exampleTranslation: seed.exampleTranslation,
    tags: [...(seed.tags ?? [])],
    createdAt: index,
  };
}

/** 取词库前 n 个词，转成运行时 Word。 */
function makeWords(count: number): Word[] {
  return SEED_WORDS.slice(0, Math.min(Math.max(count, 0), SEED_WORDS.length)).map(buildWord);
}

function makeMistake(wordId: string, wrongCount: number, lastWrongAt: number): Mistake {
  return {
    wordId,
    wrongCount,
    correctStreak: 0,
    firstWrongAt: lastWrongAt - 10_000,
    lastWrongAt,
    lastAttemptAt: lastWrongAt,
  };
}

/** 所有题型都必须满足的「可自动判分」不变量。 */
function expectValidExercise(exercise: Exercise): void {
  expect(typeof exercise.id).toBe('string');
  expect(exercise.id.length).toBeGreaterThan(0);
  expect(typeof exercise.wordId).toBe('string');
  expect(exercise.wordId.length).toBeGreaterThan(0);
  expect(exercise.source).toBe('local');
  expect(exercise.prompt.trim().length).toBeGreaterThan(0);
  expect(exercise.explanation.trim().length).toBeGreaterThan(0);
  expect(Number.isInteger(exercise.difficulty)).toBe(true);
  expect(exercise.difficulty).toBeGreaterThanOrEqual(1);
  expect(exercise.difficulty).toBeLessThanOrEqual(5);

  if (exercise.type === 'choice') {
    const options = exercise.options ?? [];
    expect(options.length).toBeGreaterThanOrEqual(3);
    expect(options.length).toBeLessThanOrEqual(4);
    expect(new Set(options).size).toBe(options.length);
    expect(options).toContain(exercise.answer);
    for (const option of options) expect(option.trim().length).toBeGreaterThan(0);
  }

  if (exercise.type === 'fill') {
    expect(exercise.prompt).toContain('____');
    expect(exercise.answer.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(exercise.acceptableAnswers)).toBe(true);
    expect(exercise.acceptableAnswers).toContain(exercise.answer);
    expect(exercise.acceptableAnswers?.length ?? 0).toBeGreaterThan(0);
  }
}

/* ------------------------------------------------------------------ */
/* 词库质量                                                            */
/* ------------------------------------------------------------------ */

describe('SEED_WORDS 词库', () => {
  it('数量不少于 160 且词条、释义都不重复', () => {
    expect(SEED_WORDS.length).toBeGreaterThanOrEqual(160);

    const terms = SEED_WORDS.map((word) => word.term.trim().toLowerCase());
    expect(terms.every((term) => term.length > 0)).toBe(true);
    expect(new Set(terms).size).toBe(terms.length);

    const meanings = SEED_WORDS.map((word) => word.meaning.trim());
    expect(new Set(meanings).size).toBe(meanings.length);
  });

  it('字段类型合法：小写词条、含斜杠音标、中文释义、非空词性', () => {
    for (const word of SEED_WORDS) {
      expect(word.term).toBe(word.term.trim());
      expect(word.term).toBe(word.term.toLowerCase());
      expect(word.term).toMatch(/^[a-z][a-z' -]*$/);
      expect(typeof word.phonetic).toBe('string');
      expect(word.phonetic).toMatch(/^\/.+\/$/);
      expect(typeof word.partOfSpeech).toBe('string');
      expect((word.partOfSpeech ?? '').trim().length).toBeGreaterThan(0);
      expect(word.meaning).toMatch(/[\u4e00-\u9fff]/);
      expect(Array.isArray(word.tags)).toBe(true);
      expect(word.tags?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('每条词条都有等级标签，四个等级均有覆盖', () => {
    for (const word of SEED_WORDS) {
      const hasLevel = (word.tags ?? []).some((tag) => LEVEL_TAGS.includes(tag));
      expect(hasLevel).toBe(true);
    }
    for (const level of LEVEL_TAGS) {
      const count = SEED_WORDS.filter((word) => (word.tags ?? []).includes(level)).length;
      expect(count).toBeGreaterThanOrEqual(20);
    }
  });

  it('至少 90% 词条有完整例句与翻译，且例句包含目标词', () => {
    const complete = SEED_WORDS.filter(
      (word) =>
        (word.example ?? '').trim().length > 0 &&
        (word.exampleTranslation ?? '').trim().length > 0,
    );
    expect(complete.length / SEED_WORDS.length).toBeGreaterThanOrEqual(0.9);

    for (const word of SEED_WORDS) {
      expect(word.example?.toLowerCase()).toContain(word.term.toLowerCase());
      expect(word.exampleTranslation).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：边界与基本不变量                                            */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 边界情况', () => {
  it('空词库返回空数组', () => {
    expect(buildLocalExercises([], {}, 10)).toEqual([]);
  });

  it('count 为 0、负数或非法值时返回空数组', () => {
    const words = makeWords(12);
    expect(buildLocalExercises(words, {}, 0)).toEqual([]);
    expect(buildLocalExercises(words, {}, -5)).toEqual([]);
    expect(buildLocalExercises(words, {}, Number.NaN)).toEqual([]);
    expect(buildLocalExercises(words, {}, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('返回数量不超过 count，id 唯一', () => {
    const words = makeWords(20);
    const result = buildLocalExercises(words, {}, 5);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(new Set(result.map((exercise) => exercise.id)).size).toBe(result.length);
  });

  it('count 远大于可生成上限时也不会卡死、不会超量', () => {
    const words = makeWords(8);
    const result = buildLocalExercises(words, {}, 500);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(500);
    result.forEach(expectValidExercise);
    // 每个单词最多出 choice / fill 各一道，因此不会无限生成。
    expect(result.length).toBeLessThanOrEqual(words.length * 2);
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：题型不变量                                                  */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 题目可判分性', () => {
  it('全量词库出题：选择题选项 3~4 个且 answer 在选项中', () => {
    const words = SEED_WORDS.map(buildWord);
    const result = buildLocalExercises(words, {}, 60);
    expect(result.length).toBe(60);
    result.forEach(expectValidExercise);

    const choices = result.filter((exercise) => exercise.type === 'choice');
    const fills = result.filter((exercise) => exercise.type === 'fill');
    expect(choices.length).toBeGreaterThan(0);
    expect(fills.length).toBeGreaterThan(0);

    for (const exercise of choices) {
      const options = exercise.options ?? [];
      expect(options).toContain(exercise.answer);
      expect(new Set(options).size).toBe(options.length);
    }
  });

  it('fill 题题干含 ____、答案非空、acceptableAnswers 覆盖答案', () => {
    const words = SEED_WORDS.map(buildWord);
    const result = buildLocalExercises(words, {}, 60);
    const fills = result.filter((exercise) => exercise.type === 'fill');
    expect(fills.length).toBeGreaterThan(0);

    for (const exercise of fills) {
      expect(exercise.prompt).toContain('____');
      expect(exercise.prompt).not.toContain('____  ');
      expect(exercise.answer.trim().length).toBeGreaterThan(0);
      const acceptable = (exercise.acceptableAnswers ?? []).map((answer) => answer.toLowerCase());
      expect(acceptable).toContain(exercise.answer.toLowerCase());
      // 原形必须可判分（例句里可能是屈折形式）。
      const source = words.find((word) => word.id === exercise.wordId);
      expect(source).toBeDefined();
      expect(acceptable).toContain(source?.term.toLowerCase());
    }
  });

  it('选择题的选项全部来自词库中其他单词，不凭空捏造', () => {
    const words = SEED_WORDS.map(buildWord);
    const allTerms = new Set(words.map((word) => word.term));
    const allMeanings = new Set(words.map((word) => word.meaning));
    const byId = new Map(words.map((word) => [word.id, word]));

    const result = buildLocalExercises(words, {}, 40).filter(
      (exercise) => exercise.type === 'choice',
    );
    expect(result.length).toBeGreaterThan(0);

    for (const exercise of result) {
      const options = exercise.options ?? [];
      const target = byId.get(exercise.wordId);
      expect(target).toBeDefined();

      if (exercise.prompt.startsWith('「')) {
        // term → meaning
        for (const option of options) expect(allMeanings.has(option)).toBe(true);
        expect(exercise.answer).toBe(target?.meaning);
      } else {
        // meaning → term
        for (const option of options) expect(allTerms.has(option)).toBe(true);
        expect(exercise.answer).toBe(target?.term);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：错词优先                                                    */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 错词优先', () => {
  it('错词排在最前，错词不足时补充新词', () => {
    const words = makeWords(12);
    const mistakes: Record<string, Mistake> = {
      [words[3].id]: makeMistake(words[3].id, 5, 3000),
      [words[7].id]: makeMistake(words[7].id, 2, 2000),
    };
    const result = buildLocalExercises(words, mistakes, 4);
    expect(result.length).toBe(4);

    // 第 1 道题来自 wrongCount 最高的错词，第 2 道来自次高错词。
    expect(result[0].wordId).toBe(words[3].id);
    expect(result[1].wordId).toBe(words[7].id);

    // 错词不够 4 个，其余题目必须来自词库中的新词。
    const wrongIds = new Set([words[3].id, words[7].id]);
    expect(result.some((exercise) => !wrongIds.has(exercise.wordId))).toBe(true);
  });

  it('错词数量不少于 count 时，所有题目都来自错词', () => {
    const words = makeWords(12);
    const mistakes: Record<string, Mistake> = {};
    for (let index = 0; index < 5; index += 1) {
      mistakes[words[index].id] = makeMistake(words[index].id, index + 1, 1000 + index);
    }

    const result = buildLocalExercises(words, mistakes, 3);
    expect(result.length).toBe(3);
    for (const exercise of result) {
      expect(Object.keys(mistakes)).toContain(exercise.wordId);
    }
    // wrongCount 降序：words[4] 累计错了 5 次，排第一。
    expect(result[0].wordId).toBe(words[4].id);
  });

  it('wrongCount 相同时按 lastWrongAt 降序', () => {
    const words = makeWords(10);
    const mistakes: Record<string, Mistake> = {
      [words[1].id]: makeMistake(words[1].id, 2, 1000),
      [words[5].id]: makeMistake(words[5].id, 2, 9000),
    };
    const result = buildLocalExercises(words, mistakes, 2);
    expect(result.length).toBe(2);
    expect(result[0].wordId).toBe(words[5].id);
    expect(result[1].wordId).toBe(words[1].id);
  });

  it('单次练习尽量覆盖不同单词（不会反复只考同一个词）', () => {
    const words = makeWords(12);
    const mistakes: Record<string, Mistake> = {
      [words[0].id]: makeMistake(words[0].id, 9, 5000),
    };
    const result = buildLocalExercises(words, mistakes, 6);
    expect(result.length).toBe(6);
    const uniqueWords = new Set(result.map((exercise) => exercise.wordId));
    expect(uniqueWords.size).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：词量很少时也不崩                                            */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 极小词库', () => {
  it('只有 1 个词时也能生成合法题目', () => {
    const words = makeWords(1);
    const result = buildLocalExercises(words, {}, 10);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(1);
    result.forEach(expectValidExercise);
  });

  it('只有 2 个词时不会生成少于 3 个选项的选择题', () => {
    const words = makeWords(2);
    const result = buildLocalExercises(words, {}, 10);
    expect(result.length).toBeGreaterThan(0);
    result.forEach(expectValidExercise);
    for (const exercise of result) {
      if (exercise.type === 'choice') expect(exercise.options?.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('只有 3 个词时可以生成 3 个选项的选择题', () => {
    const words = makeWords(3);
    const result = buildLocalExercises(words, {}, 6);
    expect(result.length).toBeGreaterThan(0);
    result.forEach(expectValidExercise);

    const choices = result.filter((exercise) => exercise.type === 'choice');
    expect(choices.length).toBeGreaterThan(0);
    for (const exercise of choices) {
      expect(exercise.options?.length).toBe(3);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：脏数据鲁棒性                                                */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 脏数据鲁棒性', () => {
  it('缺 term / meaning 的单词被跳过，不抛错', () => {
    const valid = buildWord(SEED_WORDS[0], 0);
    const dirty = [
      valid,
      { ...buildWord(SEED_WORDS[1], 1), term: '   ' },
      { ...buildWord(SEED_WORDS[2], 2), meaning: '' },
      null,
      undefined,
    ] as unknown as Word[];

    expect(() => buildLocalExercises(dirty, {}, 5)).not.toThrow();
    const result = buildLocalExercises(dirty, {}, 5);
    result.forEach(expectValidExercise);
    expect(result.every((exercise) => exercise.wordId === valid.id)).toBe(true);
  });

  it('错题记录缺失或字段非法时不抛错', () => {
    const words = makeWords(6);
    const weirdMistakes = {
      [words[0].id]: { wordId: words[0].id, wrongCount: Number.NaN },
      [words[1].id]: null,
    } as unknown as Record<string, Mistake>;

    expect(() => buildLocalExercises(words, weirdMistakes, 4)).not.toThrow();
    expect(() => buildLocalExercises(words, undefined as unknown as Record<string, Mistake>, 4)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：填空的词形与短语细节                                        */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 填空细节', () => {
  it('例句中是屈折形式时，answer 用实际形式、acceptableAnswers 含原形', () => {
    const seed = SEED_WORDS.find((word) => word.term === 'decline');
    expect(seed).toBeDefined();
    const word = buildWord(seed as WordInput, 0);

    const fills = buildLocalExercises([word], {}, 3).filter(
      (exercise) => exercise.type === 'fill',
    );
    expect(fills.length).toBe(1);

    const fill = fills[0];
    expect(fill.prompt).toContain('____');
    expect(fill.prompt).not.toContain('declined');
    expect(fill.answer.toLowerCase()).toBe('declined');

    const acceptable = (fill.acceptableAnswers ?? []).map((answer) => answer.toLowerCase());
    expect(acceptable).toContain('decline');
    expect(acceptable).toContain('declined');
    const rawAcceptable = fill.acceptableAnswers ?? [];
    expect(new Set(rawAcceptable).size).toBe(rawAcceptable.length);
  });

  it('短语题可以整体挖空，acceptableAnswers 含短语原形', () => {
    const seed = SEED_WORDS.find((word) => word.term === 'look forward to');
    expect(seed).toBeDefined();
    const word = buildWord(seed as WordInput, 0);

    const fills = buildLocalExercises([word], {}, 3).filter(
      (exercise) => exercise.type === 'fill',
    );
    expect(fills.length).toBe(1);

    const fill = fills[0];
    expect(fill.prompt).toContain('____');
    expect(fill.prompt).not.toContain('look forward to');
    expect(fill.answer.toLowerCase()).toBe('look forward to');
    const acceptable = (fill.acceptableAnswers ?? []).map((answer) => answer.toLowerCase());
    expect(acceptable).toContain('look forward to');
  });

  it('例句中目标词出现多次时退化为固定语境句，不泄漏答案', () => {
    const word: Word = {
      id: 'repeat-word',
      term: 'focus',
      partOfSpeech: 'v.',
      meaning: '集中（注意力）；聚焦',
      example: 'Focus on one task, and focus on it fully.',
      exampleTranslation: '专注一项任务，并全身心投入。',
      tags: ['自定义'],
      createdAt: 0,
    };

    const fills = buildLocalExercises([word], {}, 3).filter(
      (exercise) => exercise.type === 'fill',
    );
    expect(fills.length).toBe(1);
    expect(fills[0].prompt).toContain('____');
    expect(fills[0].prompt.toLowerCase()).not.toContain('focus');
    expect(fills[0].answer).toBe('focus');
    expect(fills[0].acceptableAnswers).toContain('focus');
  });
});

/* ------------------------------------------------------------------ */
/* 出题器：数据异常时的判分安全                                        */
/* ------------------------------------------------------------------ */

describe('buildLocalExercises 判分安全', () => {
  it('同义释义不会同时出现在选择题选项里', () => {
    const words = makeWords(6).map((word) => ({ ...word }));
    // 人为制造两个词释义完全相同，验证不会产出“双解”选项。
    words[1] = { ...words[1], meaning: words[0].meaning };

    const result = buildLocalExercises(words, {}, 10);
    result.forEach(expectValidExercise);

    const meaningToTerm = result.filter(
      (exercise) => exercise.type === 'choice' && !exercise.prompt.startsWith('「'),
    );
    const termToMeaning = result.filter(
      (exercise) => exercise.type === 'choice' && exercise.prompt.startsWith('「'),
    );

    for (const exercise of meaningToTerm) {
      // 词条选项里不能同时出现两个释义相同的单词。
      const options = exercise.options ?? [];
      const meanings = options.map(
        (option) => words.find((word) => word.term === option)?.meaning,
      );
      expect(new Set(meanings).size).toBe(meanings.length);
    }

    for (const exercise of termToMeaning) {
      // 释义选项不能与正确答案重复。
      const options = exercise.options ?? [];
      expect(options.filter((option) => option === exercise.answer)).toHaveLength(1);
    }
  });
});

