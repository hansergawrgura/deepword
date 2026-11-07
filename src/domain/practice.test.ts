/**
 * 本地出题层单测（vitest / node 环境）。
 *
 * 口径来源：docs/phase-b-contract.md 第 2 节。
 * 覆盖：buildQuestions 的技能覆盖与题量边界、tts/ai 能力开关、选项与答案的一致性、
 * checkAnswer 的 choice / spell / fill / sentence 判分与容错、空作答与脏数据安全降级。
 */

import { describe, expect, it } from 'vitest';
import type { PracticeSettings, Question, Word } from './types';
import { DEFAULT_PRACTICE_SETTINGS } from './types';
import {
  buildMixedQuestions,
  buildQuestions,
  checkAnswer,
  isTranslation,
  pickSkills,
  skillLabel,
  SKILLS,
} from './practice';

const SETTINGS: PracticeSettings = DEFAULT_PRACTICE_SETTINGS;

/** 词库：释义差异足够大，避免近义释义被当成干扰项排除后选项不足。 */
const WORDS: Word[] = [
  {
    id: 'w1',
    term: 'abandon',
    phonetic: '/əˈbændən/',
    partOfSpeech: 'v.',
    meaning: '放弃；抛弃',
    example: 'He abandoned the plan last year.',
    exampleTranslation: '他去年放弃了这个计划。',
    tags: ['CET-4'],
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
];

function build(overrides: Partial<Parameters<typeof buildQuestions>[1]> = {}): Question[] {
  return buildQuestions(WORDS[0], {
    words: WORDS,
    settings: SETTINGS,
    ttsAvailable: true,
    aiAvailable: true,
    count: 8,
    isNewWord: true,
    ...overrides,
  });
}

describe('buildQuestions', () => {
  it('新词（isNewWord=true）时一题覆盖多个技能', () => {
    const questions = build({ count: 8, isNewWord: true });
    expect(questions.length).toBe(8);
    const skills = new Set(questions.map((question) => question.skill));
    // 契约要求新词尽量覆盖多种题型；同一技能允许两个题干变体，但不能压成一种。
    expect(skills.size).toBeGreaterThanOrEqual(4);
    expect(skills.has('en2zh')).toBe(true);
    expect(skills.has('spell')).toBe(true);
  });

  it('同一组题内不重复「词 + 技能 + 题干」', () => {
    const questions = build({ count: 8, isNewWord: true });
    const keys = questions.map(
      (question) => `${question.wordId}|${question.skill}|${question.prompt}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ttsAvailable=false 时不产出听音题', () => {
    const questions = build({ count: 8, ttsAvailable: false });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.some((question) => question.skill === 'listen')).toBe(false);
    expect(questions.some((question) => question.audio === true)).toBe(false);
  });

  it('aiAvailable=false 时不产出互译题', () => {
    const questions = build({ count: 8, aiAvailable: false });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.some((question) => question.skill === 'translate')).toBe(false);
  });

  it('题量落在 [4,8] 边界：4 题 / 8 题都刚好生成对应数量', () => {
    expect(build({ count: 4 }).length).toBe(4);
    expect(build({ count: 8 }).length).toBe(8);
  });

  it('题量非法（0 / 负数 / NaN）时返回空题数组，不抛错', () => {
    expect(build({ count: 0 })).toEqual([]);
    expect(build({ count: -3 })).toEqual([]);
    expect(build({ count: Number.NaN })).toEqual([]);
  });

  it('超大题量被上限截断，不会失控', () => {
    const questions = build({ count: 10_000 });
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.length).toBeLessThanOrEqual(200);
  });

  it('选择题选项去重、答案严格等于某个选项原文、选项数 3~4', () => {
    const questions = build({ count: 8 });
    const choices = questions.filter((question) => question.options);
    expect(choices.length).toBeGreaterThan(0);
    for (const question of choices) {
      const options = question.options ?? [];
      expect(new Set(options).size).toBe(options.length);
      expect(options.length).toBeGreaterThanOrEqual(3);
      expect(options.length).toBeLessThanOrEqual(4);
      expect(options).toContain(question.answer);
    }
  });

  it('题目字段满足硬性要求：难度 1~5、题干与解析不过长', () => {
    const questions = build({ count: 8 });
    for (const question of questions) {
      expect(question.difficulty).toBeGreaterThanOrEqual(1);
      expect(question.difficulty).toBeLessThanOrEqual(5);
      expect(question.prompt.length).toBeLessThanOrEqual(500);
      expect(question.explanation.length).toBeLessThanOrEqual(400);
      expect(question.answer.length).toBeGreaterThan(0);
      expect(question.wordId).toBe(WORDS[0].id);
    }
  });

  it('脏数据（缺释义 / 重复词条 / 非对象）不抛错', () => {
    const dirty = [
      { id: 'x1', term: '', meaning: '空词', tags: [], createdAt: 0 },
      { id: 'x2', term: 'ghost', meaning: '', tags: [], createdAt: 0 },
      null,
      WORDS[1],
    ] as unknown as Word[];
    expect(() => build({ words: dirty })).not.toThrow();
    expect(build({ words: dirty }).length).toBeGreaterThan(0);
    // 目标词本身缺释义时直接返回空题。
    expect(
      buildQuestions(
        { id: 'bad', term: 'x', meaning: '', tags: [], createdAt: 0 },
        {
          words: WORDS,
          settings: SETTINGS,
          ttsAvailable: true,
          aiAvailable: true,
          count: 6,
        },
      ),
    ).toEqual([]);
  });
});

describe('buildMixedQuestions', () => {
  it('复习题：每个词至少 1 题，总数不超过 count', () => {
    const questions = buildMixedQuestions(WORDS, {
      words: WORDS,
      settings: SETTINGS,
      ttsAvailable: true,
      aiAvailable: true,
      count: 10,
    });
    expect(questions.length).toBe(10);
    const wordIds = new Set(questions.map((question) => question.wordId));
    for (const word of WORDS) {
      expect(wordIds.has(word.id)).toBe(true);
    }
  });

  it('复习题也不会产出目标词之外的词', () => {
    const questions = buildMixedQuestions(WORDS.slice(0, 2), {
      words: WORDS,
      settings: SETTINGS,
      ttsAvailable: true,
      aiAvailable: true,
      count: 8,
    });
    const ids = new Set(questions.map((question) => question.wordId));
    expect(ids.has('w1')).toBe(true);
    expect(ids.has('w2')).toBe(true);
    expect(ids.size).toBe(2);
  });
});

describe('pickSkills', () => {
  it('按能力开关过滤技能', () => {
    const skills = pickSkills({ count: 6, ttsAvailable: false, aiAvailable: false });
    expect(skills).not.toContain('listen');
    expect(skills).not.toContain('translate');
    expect(skills.length).toBeGreaterThan(0);
  });

  it('互译题量不超过 floor(count/3)，count < 3 时没有互译', () => {
    const six = pickSkills({ count: 6, ttsAvailable: true, aiAvailable: true });
    expect(six.filter((skill) => skill === 'translate').length).toBeLessThanOrEqual(2);
    const two = pickSkills({ count: 2, ttsAvailable: true, aiAvailable: true });
    expect(two).not.toContain('translate');
  });

  it('指定技能优先排在最前', () => {
    const skills = pickSkills({
      count: 4,
      skills: ['spell'],
      ttsAvailable: true,
      aiAvailable: true,
    });
    expect(skills[0]).toBe('spell');
  });
});

describe('checkAnswer', () => {
  const choice: Question = {
    id: 'e1',
    wordId: 'w1',
    prompt: '「abandon」最接近以下哪个意思？',
    options: ['放弃；抛弃', '蜡烛', '港口'],
    answer: '放弃；抛弃',
    explanation: '解析',
    difficulty: 2,
    skill: 'en2zh',
  };

  const spell: Question = {
    id: 'e2',
    wordId: 'w1',
    prompt: '看释义写出英文单词',
    answer: 'abandon',
    acceptableAnswers: ['abandon', 'Abandon'],
    explanation: '解析',
    difficulty: 3,
    skill: 'spell',
  };

  const fill: Question = {
    id: 'e3',
    wordId: 'w1',
    prompt: 'He ____ the plan.',
    answer: 'abandoned',
    acceptableAnswers: ['abandoned', 'abandons'],
    explanation: '解析',
    difficulty: 3,
    skill: 'spell',
  };

  const sentence: Question = {
    id: 'e4',
    wordId: 'w1',
    prompt: 'He ____ the plan last year.',
    options: ['abandoned', 'candle'],
    answer: 'abandoned',
    explanation: '解析',
    difficulty: 3,
    skill: 'sentence',
  };

  it('选择题：选对为 true，选错为 false', () => {
    expect(checkAnswer(choice, '放弃；抛弃')).toBe(true);
    expect(checkAnswer(choice, '蜡烛')).toBe(false);
  });

  it('拼写题：容忍大小写、首尾空格与句末标点', () => {
    expect(checkAnswer(spell, 'abandon')).toBe(true);
    expect(checkAnswer(spell, '  Abandon ')).toBe(true);
    expect(checkAnswer(spell, 'abandon.')).toBe(true);
    expect(checkAnswer(spell, 'abandonn')).toBe(false);
  });

  it('填空题：命中 acceptableAnswers 变体也算对', () => {
    expect(checkAnswer(fill, 'abandoned')).toBe(true);
    expect(checkAnswer(fill, 'Abandons')).toBe(true);
    expect(checkAnswer(fill, 'candle')).toBe(false);
  });

  it('例句选词题：选对为 true，选错为 false', () => {
    expect(checkAnswer(sentence, 'abandoned')).toBe(true);
    expect(checkAnswer(sentence, 'candle')).toBe(false);
  });

  it('空作答一律判错', () => {
    expect(checkAnswer(choice, '')).toBe(false);
    expect(checkAnswer(choice, '   ')).toBe(false);
    expect(checkAnswer(spell, '')).toBe(false);
  });

  it('脏数据（缺答案 / 非字符串作答 / 非法题目）判错且不抛错', () => {
    expect(() => checkAnswer(null as unknown as Question, 'abandon')).not.toThrow();
    expect(checkAnswer(null as unknown as Question, 'abandon')).toBe(false);
    expect(checkAnswer({} as Question, 'abandon')).toBe(false);
    expect(checkAnswer(choice, undefined as unknown as string)).toBe(false);
    expect(checkAnswer(choice, 123 as unknown as string)).toBe(false);
  });
});

describe('isTranslation / skillLabel', () => {
  it('互译题判定：skill 为 translate', () => {
    expect(
      isTranslation({
        id: 'e',
        wordId: 'w1',
        prompt: 'p',
        answer: 'a',
        explanation: 'x',
        difficulty: 4,
        skill: 'translate',
      }),
    ).toBe(true);
    expect(
      isTranslation({
        id: 'e',
        wordId: 'w1',
        prompt: 'p',
        answer: 'a',
        explanation: 'x',
        difficulty: 2,
        skill: 'en2zh',
      }),
    ).toBe(false);
  });

  it('技能中文名：缺省或非法值返回「练习」', () => {
    expect(skillLabel('en2zh')).toBe('英译中');
    expect(skillLabel('translate')).toBe('互译');
    expect(skillLabel(undefined)).toBe('练习');
    expect(skillLabel('nope' as never)).toBe('练习');
  });

  it('SKILLS 顺序固定为 6 个技能', () => {
    expect(SKILLS).toEqual(['en2zh', 'zh2en', 'spell', 'listen', 'sentence', 'translate']);
  });
});
