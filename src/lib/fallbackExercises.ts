/**
 * 本地兜底出题器：未配置 LLM 或调用失败时，用词库自身生成可判分的练习题。
 *
 * 契约（UI 直接依赖）：
 * - `buildLocalExercises(words, mistakes, count)` 永不抛错；
 * - words 为空 / count <= 0 时返回 []；
 * - 返回数量 <= count，每道题 `source: 'local'`、id 唯一、difficulty 在 1~5；
 * - choice：3~4 个互不重复的选项，answer 严格等于其中一个选项原文；
 * - fill：prompt 含 ____，answer 非空，acceptableAnswers 覆盖原形与大小写。
 *
 * 选题策略：错词优先（wrongCount 降序、lastWrongAt 降序），但先尽量覆盖不同单词，
 * 错词不足时从其余词库补新词；类型在 choice / fill 之间交替，保证一次练习有混合题型。
 */

import type { Exercise, ExerciseType, Mistake, Word } from '../types';
import { shuffle, uid } from './utils';

/** 已清洗过的可用单词视图，避免在生成过程中反复处理脏数据。 */
interface UsableWord {
  /** 去重键：优先 word.id，缺失时退回词条本身。 */
  key: string;
  word: Word;
  term: string;
  meaning: string;
  partOfSpeech?: string;
}

interface ScoredCandidate {
  text: string;
  word: UsableWord;
  similarity: number;
  samePartOfSpeech: boolean;
}

type ChoiceDirection = 'term-meaning' | 'meaning-term';

/** 释义字符重叠比例高于该值说明两个义项太接近，用作干扰项会造成“双解”。 */
const MAX_MEANING_OVERLAP = 0.5;
const MIN_OPTIONS = 3;
const MAX_OPTIONS = 4;
/** 每轮最多给每个单词出 2 道题（choice / fill 各一），两轮保证重复利用时题型不同。 */
const MAX_ROUNDS = 2;

/* ------------------------------------------------------------------ */
/* 数据清洗                                                            */
/* ------------------------------------------------------------------ */

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
      term,
      meaning,
      partOfSpeech: trimOrEmpty(word.partOfSpeech) || undefined,
    });
  }

  return result;
}

function normalizeCount(count: number): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) return 0;
  const floored = Math.floor(count);
  return floored > 0 ? floored : 0;
}

/** 从 mistakes 中安全取出某词的错题记录；没有错题或数据非法时返回 null。 */
function getMistake(
  mistakes: Record<string, Mistake> | null | undefined,
  word: Word,
): Mistake | null {
  if (typeof mistakes !== 'object' || mistakes === null) return null;
  const wordId = trimOrEmpty(word.id);
  if (!wordId) return null;
  const raw = (mistakes as Record<string, unknown>)[wordId];
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Partial<Mistake>;
  const wrongCount =
    typeof record.wrongCount === 'number' && Number.isFinite(record.wrongCount)
      ? record.wrongCount
      : 0;
  if (wrongCount <= 0) return null;
  return {
    wordId,
    wrongCount,
    correctStreak: 0,
    firstWrongAt: typeof record.firstWrongAt === 'number' ? record.firstWrongAt : 0,
    lastWrongAt: typeof record.lastWrongAt === 'number' ? record.lastWrongAt : 0,
    lastAttemptAt: typeof record.lastAttemptAt === 'number' ? record.lastAttemptAt : 0,
  };
}

/** 错词按 wrongCount 降序、lastWrongAt 降序、词条字母序稳定排序。 */
function prioritizeWrongWords(
  pool: UsableWord[],
  mistakeMap: Map<string, Mistake>,
): UsableWord[] {
  return pool
    .filter((item) => mistakeMap.has(item.key))
    .sort((a, b) => {
      const mistakeA = mistakeMap.get(a.key);
      const mistakeB = mistakeMap.get(b.key);
      const countDiff = (mistakeB?.wrongCount ?? 0) - (mistakeA?.wrongCount ?? 0);
      if (countDiff !== 0) return countDiff;
      const timeDiff = (mistakeB?.lastWrongAt ?? 0) - (mistakeA?.lastWrongAt ?? 0);
      if (timeDiff !== 0) return timeDiff;
      return a.term.localeCompare(b.term);
    });
}

/* ------------------------------------------------------------------ */
/* 相似度：用于挑选“相近但不至于双解”的干扰项                          */
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

function rankCandidates(candidates: ScoredCandidate[]): ScoredCandidate[] {
  // 先打乱再稳定排序：同分时保留随机顺序，避免每次练习总是挑到同一批干扰项。
  const shuffled = shuffle(candidates);
  return shuffled.sort((a, b) => {
    if (a.samePartOfSpeech !== b.samePartOfSpeech) return a.samePartOfSpeech ? -1 : 1;
    return b.similarity - a.similarity;
  });
}

/** 释义干扰项：同词性优先、释义相近优先，但重叠过高（近义/同义）的直接排除。 */
function pickMeaningDistractors(
  target: UsableWord,
  others: UsableWord[],
  limit: number,
): ScoredCandidate[] {
  const seen = new Set<string>([target.meaning]);
  const candidates: ScoredCandidate[] = [];

  for (const other of others) {
    if (other.meaning === target.meaning) continue;
    if (seen.has(other.meaning)) continue;
    seen.add(other.meaning);
    const similarity = meaningOverlap(target.meaning, other.meaning);
    if (similarity > MAX_MEANING_OVERLAP) continue;
    candidates.push({
      text: other.meaning,
      word: other,
      similarity,
      samePartOfSpeech: isSamePartOfSpeech(target.partOfSpeech, other.partOfSpeech),
    });
  }

  return rankCandidates(candidates).slice(0, limit);
}

/** 词条干扰项：同词性优先、拼写相近优先；释义几乎相同的词条排除，避免答案不唯一。 */
function pickTermDistractors(
  target: UsableWord,
  others: UsableWord[],
  limit: number,
): ScoredCandidate[] {
  const seen = new Set<string>([target.term.toLowerCase()]);
  const candidates: ScoredCandidate[] = [];

  for (const other of others) {
    const lower = other.term.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (meaningOverlap(target.meaning, other.meaning) > MAX_MEANING_OVERLAP) continue;
    candidates.push({
      text: other.term,
      word: other,
      similarity: prefixSimilarity(target.term.toLowerCase(), lower),
      samePartOfSpeech: isSamePartOfSpeech(target.partOfSpeech, other.partOfSpeech),
    });
  }

  return rankCandidates(candidates).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 题目生成                                                            */
/* ------------------------------------------------------------------ */

function difficultyFor(base: number, wrongCount: number): number {
  const bump = wrongCount >= 3 ? 2 : wrongCount >= 1 ? 1 : 0;
  return Math.min(5, Math.max(1, Math.round(base + bump)));
}

function nextExerciseId(usedIds: Set<string>): string {
  let id = uid('ex');
  let guard = 0;
  while (usedIds.has(id) && guard < 20) {
    id = uid('ex');
    guard += 1;
  }
  usedIds.add(id);
  return id;
}

function describeWord(target: UsableWord): string {
  const parts: string[] = [target.term];
  const phonetic = trimOrEmpty(target.word.phonetic);
  if (phonetic) parts.push(phonetic);
  if (target.partOfSpeech) parts.push(target.partOfSpeech);
  return `${parts.join(' ')} 意为「${target.meaning}」`;
}

function buildChoiceExplanation(
  target: UsableWord,
  direction: ChoiceDirection,
  distractors: ScoredCandidate[],
): string {
  if (direction === 'term-meaning') {
    let text = `${describeWord(target)}。`;
    const example = trimOrEmpty(target.word.example);
    const translation = trimOrEmpty(target.word.exampleTranslation);
    if (example) text += `例句：${example}`;
    if (translation) text += `（${translation}）`;
    return text;
  }

  const parts: string[] = [];
  if (target.partOfSpeech) parts.push(target.partOfSpeech);
  const posSuffix = parts.length > 0 ? `（${parts.join(' ')}）` : '';
  let text = `「${target.meaning}」对应的单词是 ${target.term}${posSuffix}。`;
  if (distractors.length > 0) {
    const lines = distractors
      .map((item) => `${item.word.term}（${item.word.meaning}）`)
      .join('；');
    text += `其他选项：${lines}。`;
  }
  return text;
}

function buildChoice(
  target: UsableWord,
  pool: UsableWord[],
  direction: ChoiceDirection,
  wrongCount: number,
  usedIds: Set<string>,
): Exercise | null {
  const others = pool.filter((item) => item.key !== target.key);
  const distractors =
    direction === 'term-meaning'
      ? pickMeaningDistractors(target, others, MAX_OPTIONS - 1)
      : pickTermDistractors(target, others, MAX_OPTIONS - 1);

  // 至少需要 2 个干扰项，才能凑出 3 个选项。
  if (distractors.length < MIN_OPTIONS - 1) return null;

  const answer = direction === 'term-meaning' ? target.meaning : target.term;
  const options = shuffle([answer, ...distractors.map((item) => item.text)]);
  const prompt =
    direction === 'term-meaning'
      ? `「${target.term}」最接近以下哪个意思？`
      : `以下哪个单词意为「${target.meaning}」？`;

  return {
    id: nextExerciseId(usedIds),
    wordId: target.word.id,
    type: 'choice',
    prompt,
    options,
    answer,
    explanation: buildChoiceExplanation(target, direction, distractors),
    difficulty: difficultyFor(direction === 'term-meaning' ? 2 : 3, wrongCount),
    source: 'local',
  };
}

function buildChoiceInPreferredDirections(
  target: UsableWord,
  pool: UsableWord[],
  choiceOrdinal: number,
  wrongCount: number,
  usedIds: Set<string>,
): Exercise | null {
  const directions: ChoiceDirection[] =
    choiceOrdinal % 2 === 0 ? ['term-meaning', 'meaning-term'] : ['meaning-term', 'term-meaning'];
  for (const direction of directions) {
    const exercise = buildChoice(target, pool, direction, wrongCount, usedIds);
    if (exercise) return exercise;
  }
  return null;
}

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

  // 辅音字母 + y 结尾：study → studies / studied。
  if (last === 'y' && base.length > 2 && !'aeiou'.includes(beforeLast)) {
    const stem = base.slice(0, -1);
    forms.add(`${stem}ies`);
    forms.add(`${stem}ied`);
    forms.add(`${stem}ier`);
    forms.add(`${stem}iest`);
  }

  // 辅音 + 元音 + 辅音结尾：admit → admitted / admitting（会多生成一些形式，但只在例句里匹配时才使用）。
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

/** 填空等价答案：原形、例句实际形式、首字母大写的变体都覆盖，避免判分误杀。 */
function collectAcceptableAnswers(term: string, form?: string): string[] {
  const values = new Set<string>();
  const add = (value?: string) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    values.add(trimmed);
    values.add(trimmed.toLowerCase());
    values.add(`${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`);
  };
  add(term);
  add(form);
  return [...values];
}

function buildFill(
  target: UsableWord,
  wrongCount: number,
  usedIds: Set<string>,
): Exercise {
  const example = trimOrEmpty(target.word.example);
  const translation = trimOrEmpty(target.word.exampleTranslation);
  const blank = example ? blankOutTerm(example, target.term) : null;

  const prompt = blank
    ? blank.prompt
    : `The word ____ means "${target.meaning}".`;
  const answer = blank ? blank.form : target.term;

  let explanation = `应填「${answer}」：${describeWord(target)}。`;
  if (example) explanation += `原句：${example}`;
  if (translation) explanation += `（${translation}）`;

  return {
    id: nextExerciseId(usedIds),
    wordId: target.word.id,
    type: 'fill',
    prompt,
    answer,
    acceptableAnswers: collectAcceptableAnswers(target.term, blank?.form),
    explanation,
    difficulty: difficultyFor(3, wrongCount),
    source: 'local',
  };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

function buildLocalExercisesUnsafe(
  words: Word[],
  mistakes: Record<string, Mistake>,
  count: number,
): Exercise[] {
  const pool = toUsableWords(words);
  const limit = normalizeCount(count);
  if (pool.length === 0 || limit <= 0) return [];

  const mistakeMap = new Map<string, Mistake>();
  for (const item of pool) {
    const mistake = getMistake(mistakes, item.word);
    if (mistake) mistakeMap.set(item.key, mistake);
  }

  const wrongWords = prioritizeWrongWords(pool, mistakeMap);
  const freshWords = shuffle(pool.filter((item) => !mistakeMap.has(item.key)));
  const ordered = [...wrongWords, ...freshWords];

  const exercises: Exercise[] = [];
  const usedIds = new Set<string>();
  const usedVariants = new Set<string>();
  let choiceOrdinal = 0;

  // 逐轮出题：第 1 轮覆盖尽量多的不同单词，第 2 轮再补第二种题型。
  for (let round = 0; round < MAX_ROUNDS && exercises.length < limit; round += 1) {
    for (let index = 0; index < ordered.length && exercises.length < limit; index += 1) {
      const target = ordered[index];
      const preferChoice = round === 0 ? index % 2 === 0 : index % 2 !== 0;
      const types: ExerciseType[] = preferChoice ? ['choice', 'fill'] : ['fill', 'choice'];
      const wrongCount = mistakeMap.get(target.key)?.wrongCount ?? 0;

      for (const type of types) {
        const variantKey = `${target.key}:${type}`;
        if (usedVariants.has(variantKey)) continue;

        const exercise =
          type === 'choice'
            ? buildChoiceInPreferredDirections(
                target,
                ordered,
                choiceOrdinal,
                wrongCount,
                usedIds,
              )
            : buildFill(target, wrongCount, usedIds);
        if (!exercise) continue;

        if (type === 'choice') choiceOrdinal += 1;
        usedVariants.add(variantKey);
        exercises.push(exercise);
        break;
      }
    }
  }

  return exercises;
}

/**
 * 用本地词库生成可自动判分的练习题。
 *
 * @param words 当前单词列表（通常来自 AppData.words）
 * @param mistakes wordId -> 错题档案
 * @param count 期望题目数量（实际上限）
 */
export function buildLocalExercises(
  words: Word[],
  mistakes: Record<string, Mistake>,
  count: number,
): Exercise[] {
  try {
    return buildLocalExercisesUnsafe(words, mistakes, count);
  } catch {
    // 兜底出题器不能拖垮 UI：任何异常都退化为空题目列表，由调用方提示。
    return [];
  }
}
