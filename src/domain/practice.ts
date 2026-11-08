import type { Locale } from '@/i18n/types';
import { DEFAULT_LOCALE } from '@/i18n/types';
import { createT } from '@/i18n/t';
import type { TranslateFn } from '@/i18n/types';
import type { PracticeSettings, Question, Skill, Word } from './types';
import { normalizeAnswer, partOfSpeechLabel, uid } from './utils';

/** 六个记忆技能，顺序固定（薄弱分析的仪表盘也按此顺序展示）。 */
export const SKILLS: Skill[] = ['en2zh', 'zh2en', 'spell', 'listen', 'sentence', 'translate'];

export interface SkillMeta {
  label: string;
  short: string;
  description: string;
  needsTts: boolean;
  needsAI: boolean;
}

type SkillCapability = Pick<SkillMeta, 'needsTts' | 'needsAI'>;

export const SKILL_META: Record<Skill, SkillCapability> = {
  en2zh: { needsTts: false, needsAI: false },
  zh2en: { needsTts: false, needsAI: false },
  spell: { needsTts: false, needsAI: false },
  listen: { needsTts: true, needsAI: false },
  sentence: { needsTts: false, needsAI: false },
  translate: { needsTts: false, needsAI: true },
};

export interface GenerateOptions {
  /** 全库词条（含目标词），用于生成干扰项。 */
  words: Word[];
  settings: PracticeSettings;
  /** 浏览器是否有可用英文语音（无 → 不生成 listen）。 */
  ttsAvailable: boolean;
  /** 是否配置了可用 LLM（无 → 不生成 translate）。 */
  aiAvailable: boolean;
  /** 随机源，默认 Math.random。 */
  rng?: () => number;
  /** 期望题量（尽量满足）。 */
  count: number;
  /** 指定技能顺序（薄弱优先）；缺省按均衡策略。 */
  skills?: Skill[];
  /** 是否为新词（第 1 题反馈附词条信息由 UI 处理，这里仅影响题量分配）。 */
  isNewWord?: boolean;
  /** 题干与标签文案语言，默认英语。 */
  locale?: Locale;
}

/** 按语言返回技能展示元数据（needsTts / needsAI 仍来自 SKILL_META）。 */
export function getSkillMeta(skill: Skill, locale: Locale = DEFAULT_LOCALE): SkillMeta {
  const t = createT(locale);
  const base = SKILL_META[skill];
  return {
    label: t(`domain.skill.${skill}.label`),
    short: t(`domain.skill.${skill}.short`),
    description: t(`domain.skill.${skill}.description`),
    needsTts: base.needsTts,
    needsAI: base.needsAI,
  };
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const MAX_PROMPT = 500;
const MAX_EXPLANATION = 400;
const MIN_OPTIONS = 3;
const MAX_OPTIONS = 4;
/** 释义字符重叠比例高于该值说明两个义项太接近，用作干扰项会造成「双解」。 */
const MAX_MEANING_OVERLAP = 0.5;
/** 单组题量的绝对上限，避免脏数据传入超大 count 时失控。 */
const MAX_COUNT = 200;
/**
 * 每个技能最多准备几套题干变体。变体只改题干措辞，不改答案与考点，
 * 目的是满足「同一题内不得重复 wordId+skill+prompt」并尽量补齐题量。
 */
const VARIANT_LIMIT: Record<Skill, number> = {
  en2zh: 2,
  zh2en: 2,
  spell: 2,
  listen: 1,
  sentence: 2,
  translate: 2,
};
/** 技能不可用时的回退顺序：基础三技能优先，其余按需。 */
const FALLBACK_SKILLS: Skill[] = ['en2zh', 'zh2en', 'spell', 'sentence', 'listen', 'translate'];
const DIFFICULTY: Record<Skill, number> = {
  en2zh: 2,
  zh2en: 3,
  spell: 3,
  listen: 2,
  sentence: 3,
  translate: 4,
};

/* ------------------------------------------------------------------ */
/* 数据清洗                                                            */
/* ------------------------------------------------------------------ */

/** 已清洗过的可用单词视图，避免在生成过程中反复处理脏数据。 */
interface UsableWord {
  /** 去重键：优先 word.id，缺失时退回词条本身。 */
  key: string;
  word: Word;
  id: string;
  term: string;
  meaning: string;
  phonetic?: string;
  partOfSpeech?: string;
  example?: string;
  exampleTranslation?: string;
}

interface ScoredCandidate {
  text: string;
  similarity: number;
  samePartOfSpeech: boolean;
}

interface BuildContext {
  pool: UsableWord[];
  ttsAvailable: boolean;
  aiAvailable: boolean;
  rng: () => number;
  locale: Locale;
  t: TranslateFn;
  /** 已出过的 `wordId + skill + prompt`，用于去重。 */
  usedKeys: Set<string>;
  translateCount: number;
  maxTranslate: number;
}

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 过滤脏数据（缺 term/meaning、重复词条），得到可安全出题的单词列表。
 * 入参在类型上是 Word[]，但运行时可能来自损坏的 localStorage，因此全部防御性处理。
 */
function toUsableWords(words: readonly Word[] | null | undefined): UsableWord[] {
  if (!Array.isArray(words)) return [];
  const result: UsableWord[] = [];
  const seenKeys = new Set<string>();
  const seenTerms = new Set<string>();

  for (const raw of words as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue;
    const word = raw as Partial<Word>;
    const term = trimOrEmpty(word.term);
    const meaning = trimOrEmpty(word.meaning);
    if (!term || !meaning) continue;

    const id = trimOrEmpty(word.id);
    const termKey = term.toLowerCase().replace(/\s+/g, ' ');
    const key = id || `term:${termKey}`;
    if (seenKeys.has(key) || seenTerms.has(termKey)) continue;
    seenKeys.add(key);
    seenTerms.add(termKey);

    result.push({
      key,
      word: raw as Word,
      id,
      term,
      meaning,
      phonetic: trimOrEmpty(word.phonetic) || undefined,
      partOfSpeech: trimOrEmpty(word.partOfSpeech) || undefined,
      example: trimOrEmpty(word.example) || undefined,
      exampleTranslation: trimOrEmpty(word.exampleTranslation) || undefined,
    });
  }

  return result;
}

function isSkillValue(value: unknown): value is Skill {
  return typeof value === 'string' && (SKILLS as readonly string[]).includes(value);
}

function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const floored = Math.floor(value);
  if (floored <= 0) return 0;
  return Math.min(floored, MAX_COUNT);
}

/** 截断文本，保证不超长（prompt ≤500、explanation ≤400）。 */
function clip(text: string, max: number): string {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 随机源兜底：非函数 / 抛错 / 越界值都安全降级。 */
function normalizeRng(rng?: () => number): () => number {
  if (typeof rng !== 'function') return Math.random;
  return () => {
    let value = 0;
    try {
      value = rng();
    } catch {
      value = 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    return value >= 1 ? 0.999_999 : value;
  };
}

/** Fisher–Yates（可注入 rng），返回新数组。 */
function shuffleWithRng<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ------------------------------------------------------------------ */
/* 相似度：用于挑选「相近但不至于双解」的干扰项                          */
/* ------------------------------------------------------------------ */

/** 去掉标点与空白后，统计两个释义共用了多少汉字（按较短一方归一化）。 */
function meaningOverlap(a: string, b: string): number {
  const charsA = new Set(
    [...a.replace(/[\s，。；、,.;:!?！？（）()「」【】"'‘’“”/·-]/g, '')].filter(Boolean),
  );
  const charsB = new Set(
    [...b.replace(/[\s，。；、,.;:!?！？（）()「」【】"'‘’“”/·-]/g, '')].filter(Boolean),
  );
  if (charsA.size === 0 || charsB.size === 0) return 0;
  let shared = 0;
  for (const char of charsA) {
    if (charsB.has(char)) shared += 1;
  }
  return shared / Math.min(charsA.size, charsB.size);
}

/** 两个词条共同前缀占较长者的比例：用于优先挑选 principal / principle 这类易混拼写。 */
function prefixSimilarity(a: string, b: string): number {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 0;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) {
    common += 1;
  }
  return common / maxLength;
}

/** 词性归一化后比较（"v." 与 "v" 视为相同）。 */
function isSamePartOfSpeech(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.toLowerCase().replace(/\./g, '') === b.toLowerCase().replace(/\./g, '');
}

function rankCandidates(candidates: ScoredCandidate[], rng: () => number): ScoredCandidate[] {
  // 先打乱再稳定排序：同分时保留随机顺序，避免每次练习总是挑到同一批干扰项。
  const shuffled = shuffleWithRng(candidates, rng);
  return shuffled.sort((a, b) => {
    if (a.samePartOfSpeech !== b.samePartOfSpeech) return a.samePartOfSpeech ? -1 : 1;
    return b.similarity - a.similarity;
  });
}

/** 释义干扰项：同词性优先、释义相近优先，但重叠过高（近义/同义）的直接排除。 */
function pickMeaningDistractors(
  target: UsableWord,
  pool: UsableWord[],
  rng: () => number,
): string[] {
  const answerKey = normalizeAnswer(target.meaning);
  const seen = new Set<string>([answerKey]);
  const candidates: ScoredCandidate[] = [];

  for (const other of pool) {
    if (other.key === target.key) continue;
    const textKey = normalizeAnswer(other.meaning);
    if (!textKey || seen.has(textKey)) continue;
    seen.add(textKey);
    const similarity = meaningOverlap(target.meaning, other.meaning);
    if (similarity > MAX_MEANING_OVERLAP) continue;
    candidates.push({
      text: other.meaning,
      similarity,
      samePartOfSpeech: isSamePartOfSpeech(target.partOfSpeech, other.partOfSpeech),
    });
  }

  return rankCandidates(candidates, rng).map((item) => item.text);
}

/** 词条干扰项：同词性优先、拼写相近优先；释义几乎相同的词条排除，避免答案不唯一。 */
function pickTermDistractors(target: UsableWord, pool: UsableWord[], rng: () => number): string[] {
  const answerKey = normalizeAnswer(target.term);
  const seen = new Set<string>([answerKey]);
  const candidates: ScoredCandidate[] = [];

  for (const other of pool) {
    if (other.key === target.key) continue;
    const termKey = normalizeAnswer(other.term);
    if (!termKey || seen.has(termKey)) continue;
    seen.add(termKey);
    if (meaningOverlap(target.meaning, other.meaning) > MAX_MEANING_OVERLAP) continue;
    candidates.push({
      text: other.term,
      similarity: prefixSimilarity(target.term.toLowerCase(), other.term.toLowerCase()),
      samePartOfSpeech: isSamePartOfSpeech(target.partOfSpeech, other.partOfSpeech),
    });
  }

  return rankCandidates(candidates, rng).map((item) => item.text);
}

/* ------------------------------------------------------------------ */
/* 题量与选项规划                                                      */
/* ------------------------------------------------------------------ */

function countOthers(pool: UsableWord[], target: UsableWord): number {
  let count = 0;
  for (const item of pool) {
    if (item.key !== target.key) count += 1;
  }
  return count;
}

/**
 * 选择题选项数量规划：
 * - 词库 ≥3 个词：至少 3 个选项（2 个干扰项），最多 4 个；
 * - 词库只有 2 个词：允许 2 个选项；
 * - 词库只有 1 个词：无法出选择题（返回 null，由调用方回退到其他技能）。
 */
function optionPlan(othersCount: number): { need: number; max: number } | null {
  if (!Number.isFinite(othersCount) || othersCount <= 0) return null;
  const max = Math.min(MAX_OPTIONS - 1, othersCount);
  const need = othersCount >= 2 ? MIN_OPTIONS - 1 : 1;
  return { need, max };
}

/* ------------------------------------------------------------------ */
/* 例句挖空（与 fallbackQuestions 同口径，独立实现避免相互依赖）          */
/* ------------------------------------------------------------------ */

/** 生成常见屈折形式，用于在例句中定位目标词（含 -s / -ed / -ing / 双写辅音 / y→ies 等）。 */
function buildInflectedForms(term: string): string[] {
  const base = term.toLowerCase();
  const forms = new Set<string>([
    base,
    `${base}s`,
    `${base}es`,
    `${base}ed`,
    `${base}d`,
    `${base}ing`,
    `${base}er`,
    `${base}est`,
  ]);
  const last = base.charAt(base.length - 1);
  const beforeLast = base.charAt(base.length - 2);

  if (last === 'e' && base.length > 2) {
    const stem = base.slice(0, -1);
    forms.add(`${stem}ing`);
    forms.add(`${stem}ed`);
    forms.add(`${stem}er`);
    forms.add(`${stem}est`);
  }

  if (last === 'y' && base.length > 2 && !'aeiou'.includes(beforeLast)) {
    const stem = base.slice(0, -1);
    forms.add(`${stem}ies`);
    forms.add(`${stem}ied`);
    forms.add(`${stem}ier`);
    forms.add(`${stem}iest`);
  }

  if (base.length >= 3 && /[^aeiou][aeiou][^aeiouwy]$/.test(base)) {
    forms.add(`${base}${last}ed`);
    forms.add(`${base}${last}ing`);
    forms.add(`${base}${last}er`);
    forms.add(`${base}${last}est`);
  }

  return [...forms];
}

interface BlankResult {
  prompt: string;
  /** 例句中实际出现的形式（可能是屈折形式，也可能是短语原文）。 */
  form: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在例句中挖掉目标词；找不到或出现多次（挖空会泄漏答案）时返回 null。 */
function blankOutTerm(sentence: string, term: string): BlankResult | null {
  if (!sentence || !term) return null;

  if (term.includes(' ')) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
    let first: RegExpExecArray | null = null;
    let match = pattern.exec(sentence);
    while (match !== null) {
      if (first) return null;
      first = match;
      match = pattern.exec(sentence);
    }
    if (!first) return null;
    const prompt = `${sentence.slice(0, first.index)}____${sentence.slice(
      first.index + first[0].length,
    )}`;
    return { prompt, form: first[0] };
  }

  const forms = new Set(buildInflectedForms(term));
  const tokenPattern = /[A-Za-z][A-Za-z'-]*/g;
  let first: { index: number; form: string } | null = null;
  let token = tokenPattern.exec(sentence);
  while (token !== null) {
    if (forms.has(token[0].toLowerCase())) {
      if (first) return null;
      first = { index: token.index, form: token[0] };
    }
    token = tokenPattern.exec(sentence);
  }
  if (!first) return null;

  const prompt = `${sentence.slice(0, first.index)}____${sentence.slice(
    first.index + first.form.length,
  )}`;
  return { prompt, form: first.form };
}

/** 拼写等价答案：原形、全小写、首字母大写，覆盖常见输入习惯。 */
function collectAcceptableAnswers(term: string): string[] {
  const values = new Set<string>();
  const trimmed = term.trim();
  if (!trimmed) return [];
  values.add(trimmed);
  values.add(trimmed.toLowerCase());
  values.add(`${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`);
  return [...values];
}

/* ------------------------------------------------------------------ */
/* 解析文案                                                            */
/* ------------------------------------------------------------------ */

function describeMeaning(target: UsableWord, ctx: BuildContext): string {
  const phonetic = target.phonetic ? ` ${target.phonetic}` : '';
  const pos = target.partOfSpeech
    ? ` ${partOfSpeechLabel(target.partOfSpeech, ctx.locale)}`
    : '';
  return ctx.t('domain.practice.meaningDesc', {
    term: target.term,
    phonetic,
    pos,
    meaning: target.meaning,
  });
}

function describeExample(target: UsableWord, ctx: BuildContext): string {
  if (!target.example) return '';
  const translation = target.exampleTranslation
    ? ctx.t('domain.practice.exampleTranslationWrap', { text: target.exampleTranslation })
    : '';
  return ctx.t('domain.practice.exampleLine', { example: target.example, translation });
}

function posSuffix(target: UsableWord, t: TranslateFn): string {
  return target.partOfSpeech ? t('domain.practice.posWrap', { pos: target.partOfSpeech }) : '';
}

/* ------------------------------------------------------------------ */
/* 各技能出题                                                          */
/* ------------------------------------------------------------------ */

function buildMeaningChoiceQuestion(
  target: UsableWord,
  skill: 'en2zh' | 'listen',
  variant: number,
  ctx: BuildContext,
): Question | null {
  const answer = target.meaning;
  const plan = optionPlan(countOthers(ctx.pool, target));
  if (!plan) return null;
  const distractors = pickMeaningDistractors(target, ctx.pool, ctx.rng).slice(0, plan.max);
  if (distractors.length < plan.need) return null;

  const options = shuffleWithRng([answer, ...distractors], ctx.rng);
  let prompt: string;
  if (skill === 'listen') {
    prompt = ctx.t('domain.practice.listenPrompt');
  } else if (variant === 0) {
    prompt = ctx.t('domain.practice.en2zhPromptV0', { term: target.term });
  } else {
    prompt = ctx.t('domain.practice.en2zhPromptV1', { term: target.term });
  }

  return {
    id: uid('q'),
    wordId: target.id,
    prompt: clip(prompt, MAX_PROMPT),
    options,
    answer,
    explanation: clip(
      `${describeMeaning(target, ctx)}${describeExample(target, ctx) ? ` ${describeExample(target, ctx)}` : ''}`,
      MAX_EXPLANATION,
    ),
    difficulty: DIFFICULTY[skill],
    skill,
    audio: skill === 'listen' ? true : undefined,
  };
}

function buildTermChoiceQuestion(
  target: UsableWord,
  variant: number,
  ctx: BuildContext,
): Question | null {
  const answer = target.term;
  const plan = optionPlan(countOthers(ctx.pool, target));
  if (!plan) return null;
  const distractors = pickTermDistractors(target, ctx.pool, ctx.rng).slice(0, plan.max);
  if (distractors.length < plan.need) return null;

  const options = shuffleWithRng([answer, ...distractors], ctx.rng);
  const prompt =
    variant === 0
      ? ctx.t('domain.practice.zh2enPromptV0', { meaning: target.meaning })
      : ctx.t('domain.practice.zh2enPromptV1', { meaning: target.meaning });

  return {
    id: uid('q'),
    wordId: target.id,
    prompt: clip(prompt, MAX_PROMPT),
    options,
    answer,
    explanation: clip(
      `${ctx.t('domain.practice.zh2enExplain', {
        meaning: target.meaning,
        term: target.term,
        posWrap: posSuffix(target, ctx.t),
      })}${describeExample(target, ctx) ? ` ${describeExample(target, ctx)}` : ''}`,
      MAX_EXPLANATION,
    ),
    difficulty: DIFFICULTY.zh2en,
    skill: 'zh2en',
  };
}

function buildSpellQuestion(
  target: UsableWord,
  variant: number,
  ctx: BuildContext,
): Question | null {
  const answer = target.term;
  const phoneticNote = target.phonetic
    ? ctx.t('domain.practice.phoneticNote', { phonetic: target.phonetic })
    : '';
  const prompt =
    variant === 0
      ? ctx.t('domain.practice.spellPromptV0', { meaning: target.meaning, phoneticNote })
      : ctx.t('domain.practice.spellPromptV1', { meaning: target.meaning });

  return {
    id: uid('q'),
    wordId: target.id,
    prompt: clip(prompt, MAX_PROMPT),
    answer,
    acceptableAnswers: collectAcceptableAnswers(answer),
    explanation: clip(
      `${ctx.t('domain.practice.spellExplain', {
        term: target.term,
        phonetic: target.phonetic ? ` ${target.phonetic}` : '',
        meaning: target.meaning,
      })}${describeExample(target, ctx) ? ` ${describeExample(target, ctx)}` : ''}`,
      MAX_EXPLANATION,
    ),
    difficulty: DIFFICULTY.spell,
    skill: 'spell',
  };
}

function buildSentenceQuestion(
  target: UsableWord,
  variant: number,
  ctx: BuildContext,
): Question | null {
  if (!target.example) return null;
  const blank = blankOutTerm(target.example, target.term);
  if (!blank) return null;

  const answer = blank.form;
  const plan = optionPlan(countOthers(ctx.pool, target));
  if (!plan) return null;

  const answerKey = normalizeAnswer(answer);
  const distractors = pickTermDistractors(target, ctx.pool, ctx.rng)
    .filter((text) => normalizeAnswer(text) !== answerKey)
    .slice(0, plan.max);
  if (distractors.length < plan.need) return null;

  const options = shuffleWithRng([answer, ...distractors], ctx.rng);
  const prompt =
    variant === 0
      ? ctx.t('domain.practice.sentencePromptV0', { blank: blank.prompt })
      : ctx.t('domain.practice.sentencePromptV1', { blank: blank.prompt });
  const translation = target.exampleTranslation
    ? ctx.t('domain.practice.exampleTranslationWrap', { text: target.exampleTranslation })
    : '';

  return {
    id: uid('q'),
    wordId: target.id,
    prompt: clip(prompt, MAX_PROMPT),
    options,
    answer,
    explanation: clip(
      ctx.t('domain.practice.sentenceExplain', {
        answer,
        example: target.example,
        translation,
        meaning: describeMeaning(target, ctx),
      }),
      MAX_EXPLANATION,
    ),
    difficulty: DIFFICULTY.sentence,
    skill: 'sentence',
  };
}

function buildTranslateQuestion(
  target: UsableWord,
  variant: number,
  ctx: BuildContext,
): Question | null {
  if (!ctx.aiAvailable) return null;
  if (!target.example || !target.exampleTranslation) return null;

  const direction: 'en2zh' | 'zh2en' = variant === 1 ? 'zh2en' : 'en2zh';
  const prompt =
    direction === 'en2zh'
      ? ctx.t('domain.practice.translatePromptZh', { text: target.example })
      : ctx.t('domain.practice.translatePromptEn', { text: target.exampleTranslation });
  const answer = direction === 'en2zh' ? target.exampleTranslation : target.example;

  return {
    id: uid('q'),
    wordId: target.id,
    prompt: clip(prompt, MAX_PROMPT),
    answer,
    explanation: clip(
      ctx.t('domain.practice.referenceTranslation', {
        answer,
        meaning: describeMeaning(target, ctx),
      }),
      MAX_EXPLANATION,
    ),
    difficulty: DIFFICULTY.translate,
    skill: 'translate',
    direction,
  };
}

/** 单个技能的一套题干变体；内容不适用（如缺例句）时返回 null。 */
function buildOneQuestion(
  target: UsableWord,
  skill: Skill,
  variant: number,
  ctx: BuildContext,
): Question | null {
  switch (skill) {
    case 'en2zh':
      return buildMeaningChoiceQuestion(target, 'en2zh', variant, ctx);
    case 'listen':
      return variant === 0 ? buildMeaningChoiceQuestion(target, 'listen', 0, ctx) : null;
    case 'zh2en':
      return buildTermChoiceQuestion(target, variant, ctx);
    case 'spell':
      return buildSpellQuestion(target, variant, ctx);
    case 'sentence':
      return buildSentenceQuestion(target, variant, ctx);
    case 'translate':
      return buildTranslateQuestion(target, variant, ctx);
  }
  return null;
}

function skillAllowed(skill: Skill, ctx: BuildContext): boolean {
  const meta = SKILL_META[skill];
  if (!meta) return false;
  if (meta.needsTts && !ctx.ttsAvailable) return false;
  if (meta.needsAI && !ctx.aiAvailable) return false;
  return true;
}

/**
 * 尝试为某个词生成一道指定技能的题：
 * 依次尝试各题干变体，跳过「wordId+skill+prompt」已出现过的题目。
 */
function tryBuildSkill(
  target: UsableWord,
  skill: Skill,
  ctx: BuildContext,
): Question | null {
  if (!isSkillValue(skill) || !skillAllowed(skill, ctx)) return null;
  if (skill === 'translate' && ctx.translateCount >= ctx.maxTranslate) return null;

  const variantLimit = VARIANT_LIMIT[skill] ?? 1;
  for (let variant = 0; variant < variantLimit; variant += 1) {
    const exercise = buildOneQuestion(target, skill, variant, ctx);
    if (!exercise) continue;
    const key = `${target.key}:${skill}:${exercise.prompt}`;
    if (ctx.usedKeys.has(key)) continue;
    ctx.usedKeys.add(key);
    if (skill === 'translate') ctx.translateCount += 1;
    return exercise;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 技能序列                                                            */
/* ------------------------------------------------------------------ */

/** 选出 count 道题实际可用的技能序列。 */
export function pickSkills(
  options: Pick<GenerateOptions, 'skills' | 'ttsAvailable' | 'aiAvailable' | 'rng'> & {
    count: number;
  },
): Skill[] {
  try {
    return pickSkillSequence(options);
  } catch {
    return [];
  }
}

function pickSkillSequence(
  options:
    | (Pick<GenerateOptions, 'skills' | 'ttsAvailable' | 'aiAvailable' | 'rng'> & {
        count: number;
      })
    | undefined,
): Skill[] {
  const count = normalizeCount(options?.count);
  if (count <= 0) return [];
  const ttsAvailable = options?.ttsAvailable === true;
  const aiAvailable = options?.aiAvailable === true;
  const rng = normalizeRng(options?.rng);
  const maxTranslate = count < 3 ? 0 : Math.floor(count / 3);

  const available = SKILLS.filter((skill) => {
    const meta = SKILL_META[skill];
    if (meta.needsTts && !ttsAvailable) return false;
    if (meta.needsAI && !aiAvailable) return false;
    if (skill === 'translate' && maxTranslate <= 0) return false;
    return true;
  });

  const requested: Skill[] = [];
  const rawSkills = options && Array.isArray(options.skills) ? options.skills : [];
  for (const raw of rawSkills) {
    if (!isSkillValue(raw)) continue;
    if (!available.includes(raw) || requested.includes(raw)) continue;
    requested.push(raw);
  }

  // 指定技能优先，其余可用技能打乱后补在末尾，再循环取 count 个。
  const remainder = shuffleWithRng(
    available.filter((skill) => !requested.includes(skill)),
    rng,
  );
  const ordered = [...requested, ...remainder];
  if (ordered.length === 0) return [];

  const result: Skill[] = [];
  let translateUsed = 0;
  let cursor = 0;
  let guard = 0;
  const guardLimit = count * ordered.length + ordered.length + 4;
  while (result.length < count && guard < guardLimit) {
    guard += 1;
    const skill = ordered[cursor % ordered.length];
    cursor += 1;
    if (skill === 'translate') {
      if (translateUsed >= maxTranslate) continue; // 互译占比 ≤1/3
      translateUsed += 1;
    }
    result.push(skill);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 批量出题                                                            */
/* ------------------------------------------------------------------ */

function createContext(pool: UsableWord[], options: GenerateOptions | undefined, count: number): BuildContext {
  const locale = options?.locale ?? DEFAULT_LOCALE;
  return {
    pool,
    ttsAvailable: options?.ttsAvailable === true,
    aiAvailable: options?.aiAvailable === true,
    rng: normalizeRng(options?.rng),
    locale,
    t: createT(locale),
    usedKeys: new Set<string>(),
    translateCount: 0,
    maxTranslate: count < 3 ? 0 : Math.floor(count / 3),
  };
}

/**
 * 为一组目标词生成题目：先按目标词顺序保证每个词至少 1 题，
 * 其余题量按技能序列轮转补齐；总数不超过 count。
 */
function buildForTargets(
  targets: UsableWord[],
  ctx: BuildContext,
  sequence: Skill[],
  count: number,
): Question[] {
  const result: Question[] = [];
  if (targets.length === 0 || ctx.pool.length === 0 || sequence.length === 0) return result;

  let guard = 0;
  const guardLimit = count * (sequence.length + FALLBACK_SKILLS.length) + 16;

  // 每个词已用技能计数：保证「同词同技能一轮内不重复」，并让新词优先覆盖多种题型。
  const usageByWord = new Map<string, Map<Skill, number>>();
  const usageOf = (targetKey: string, skill: Skill): number =>
    usageByWord.get(targetKey)?.get(skill) ?? 0;
  const markUsage = (targetKey: string, skill: Skill): void => {
    const map = usageByWord.get(targetKey) ?? new Map<Skill, number>();
    map.set(skill, (map.get(skill) ?? 0) + 1);
    usageByWord.set(targetKey, map);
  };

  while (result.length < count && guard < guardLimit) {
    guard += 1;
    let progressed = false;

    for (let index = 0; index < targets.length && result.length < count; index += 1) {
      const target = targets[index];
      let built = false;

      // 技能候选：同词已用次数少的优先；次数相同按技能序列（薄弱优先）。
      const candidates = sequence
        .map((skill, order) => ({ skill, order, used: usageOf(target.key, skill) }))
        .sort((a, b) => a.used - b.used || a.order - b.order);
      for (const candidate of candidates) {
        const exercise = tryBuildSkill(target, candidate.skill, ctx);
        if (exercise) {
          markUsage(target.key, candidate.skill);
          result.push(exercise);
          progressed = true;
          built = true;
          break;
        }
      }

      // 该词的主技能都不适用时，回退到基础技能补齐（同样避开已用过的技能）。
      if (!built) {
        const fallbacks = FALLBACK_SKILLS.map((skill, order) => ({
          skill,
          order,
          used: usageOf(target.key, skill),
        })).sort((a, b) => a.used - b.used || a.order - b.order);
        for (const candidate of fallbacks) {
          const exercise = tryBuildSkill(target, candidate.skill, ctx);
          if (exercise) {
            markUsage(target.key, candidate.skill);
            result.push(exercise);
            progressed = true;
            built = true;
            break;
          }
        }
      }
    }

    if (!progressed) break;
  }

  return result;
}

/** 为单个词生成 count 道题（含新词全部题型）。 */
export function buildQuestions(word: Word, options: GenerateOptions): Question[] {
  try {
    if (!word || typeof word !== 'object' || !options) return [];
    const count = normalizeCount(options.count);
    if (count <= 0) return [];

    const target = toUsableWords([word])[0];
    if (!target) return [];

    const rawWords = Array.isArray(options.words) ? options.words : [];
    const pool = toUsableWords([word, ...rawWords]);
    if (pool.length === 0) return [];

    const ctx = createContext(pool, options, count);
    const explicitSkills = Array.isArray(options.skills) && options.skills.length > 0;
    // 新词默认按技能表顺序尽量覆盖「全部题型」；复习时由调用方传入薄弱优先的技能顺序。
    const skillOrder = !explicitSkills && options.isNewWord === true ? SKILLS : options.skills;
    const sequence = pickSkillSequence({
      skills: skillOrder,
      count,
      ttsAvailable: ctx.ttsAvailable,
      aiAvailable: ctx.aiAvailable,
      rng: ctx.rng,
    });

    return buildForTargets([target], ctx, sequence, count);
  } catch {
    return [];
  }
}

/** 为多个复习词生成 count 道题，尽量覆盖每个词（每词 ≥1 题）。 */
export function buildMixedQuestions(words: Word[], options: GenerateOptions): Question[] {
  try {
    if (!Array.isArray(words) || words.length === 0 || !options) return [];
    const count = normalizeCount(options.count);
    if (count <= 0) return [];

    const targets = toUsableWords(words);
    if (targets.length === 0) return [];

    const rawWords = Array.isArray(options.words) ? options.words : [];
    const pool = toUsableWords([...words, ...rawWords]);
    if (pool.length === 0) return [];

    const ctx = createContext(pool, options, count);
    const sequence = pickSkillSequence({
      skills: options.skills,
      count,
      ttsAvailable: ctx.ttsAvailable,
      aiAvailable: ctx.aiAvailable,
      rng: ctx.rng,
    });

    return buildForTargets(targets, ctx, sequence, count);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 判分                                                                */
/* ------------------------------------------------------------------ */

/** 是否为互译题（UI 据此走 LLM 判分 / 三档 verdict）。 */
export function isTranslation(question: Question): boolean {
  try {
    if (!question || typeof question !== 'object') return false;
    return question.skill === 'translate';
  } catch {
    return false;
  }
}

/** 宽松归一化：在 normalizeAnswer 基础上再容忍首尾引号等标点。 */
function normalizeLoose(value: string): string {
  return normalizeAnswer(value)
    .replace(/[.!。！?？,，;；:：'"“”‘’]+$/g, '')
    .trim();
}

/**
 * 本地判分。
 * - choice / sentence：用 normalizeAnswer 严格匹配 answer；
 * - spell / fill：容忍大小写、首尾标点与空格，并接受 acceptableAnswers 中的变体；
 * - translate：自由作答，本地只做归一化后的等价比较（UI 以 LLM 三档判定为准）。
 */
export function checkAnswer(question: Question, response: string): boolean {
  try {
    if (!question || typeof question !== 'object') return false;
    const answer = typeof question.answer === 'string' ? question.answer : '';
    if (!answer.trim()) return false;
    const raw = typeof response === 'string' ? response : '';
    if (!raw.trim()) return false;

    const answerKey = normalizeAnswer(answer);
    if (!answerKey) return false;
    const responseKey = normalizeAnswer(raw);
    if (!responseKey) return false;

    if (question.skill === 'spell') {
      if (normalizeLoose(raw) === normalizeLoose(answer)) return true;
      const acceptable = Array.isArray(question.acceptableAnswers)
        ? question.acceptableAnswers
        : [];
      for (const variant of acceptable) {
        if (typeof variant !== 'string') continue;
        if (normalizeLoose(variant) === normalizeLoose(raw)) return true;
      }
      return false;
    }

    return responseKey === answerKey;
  } catch {
    return false;
  }
}

/** 技能展示名；缺省或非法时返回 fallback 文案。 */
export function skillLabel(skill?: Skill, locale: Locale = DEFAULT_LOCALE): string {
  const t = createT(locale);
  if (!isSkillValue(skill)) return t('domain.skill.fallback');
  return getSkillMeta(skill, locale).label;
}
