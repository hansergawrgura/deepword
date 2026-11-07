/**
 * Phase B 一轮练习的选词与题量规划。
 *
 * 契约来源：docs/phase-b-contract.md 第 5 节。
 * - 复习候选 = 已学（SRS 卡片状态非 new）且未掌握（无 mastery 记录、卡片状态非 mastered）的词；
 * - 排序：闪卡「不认识」标记（data.reviewPriority，值 = 标记时间，越早越优先）最优先，
 *   其后按 scoreReviewWord 降序（薄弱优先），同分按最近作答久远优先；
 * - 新词与掌握词永不出现在复习列表；
 * - 复习词数 = clamp(settings.reviewWordsPerRound, 4, 6)，不足时按实际数量；
 * - roundNo = (data.session?.roundNo ?? 0) + 1。
 *
 * 设计约束：纯函数、不读写 localStorage、不抛错；脏数据（缺卡片 / 空词库 / 字段缺失）安全降级。
 */

import type { AppData, PracticeSettings, SrsCard, Word } from '../types';
import { clamp, sample, uid } from './utils';
import { scoreWordWeakness } from './weakness';

export interface RoundPlan {
  /** uid('round') */
  id: string;
  /** 第几轮（从 1 起）。 */
  roundNo: number;
  /** 本轮新词（第一个；兼容旧调用方）。 */
  newWord: Word | null;
  /** 本轮新词列表（数量取自 settings.newWordsPerRound，1~10）。 */
  newWords: Word[];
  /** 复习词（4~6，按薄弱度）。 */
  reviewWords: Word[];
}

/** 每轮复习词数的下限 / 上限（契约固定 4~6）。 */
export const MIN_REVIEW_WORDS = 4;
export const MAX_REVIEW_WORDS = 6;
/** settings.reviewWordsPerRound 缺失或非法时的兜底值。 */
export const DEFAULT_REVIEW_WORDS = 6;

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

/** 归一化时间戳：非法值回退到当前时间。 */
function normalizeNow(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

/** 取词库（过滤脏数据、按 id 去重）。 */
function wordsOf(data: AppData): Word[] {
  const words = Array.isArray(data?.words) ? (data.words as Word[]) : [];
  const seen = new Set<string>();
  const result: Word[] = [];
  for (const word of words) {
    if (!word || typeof word !== 'object') continue;
    const id = typeof word.id === 'string' ? word.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(word);
  }
  return result;
}

/** 取某个词的 SRS 卡片（没有卡片时为 undefined）。 */
function cardOf(data: AppData, wordId: string): SrsCard | undefined {
  const srs = data?.srs;
  if (!srs || typeof srs !== 'object') return undefined;
  const card = srs[wordId];
  return card && typeof card === 'object' ? card : undefined;
}

/** 是否已掌握：存在掌握记录，或卡片状态为 mastered。 */
function isMasteredWord(data: AppData, wordId: string, card?: SrsCard): boolean {
  if (data?.mastery && data.mastery[wordId]) return true;
  const target = card ?? cardOf(data, wordId);
  return Boolean(target) && target!.status === 'mastered';
}

/**
 * 是否「已学」（卡片状态非 new）。
 *
 * 脏数据兜底：状态仍是 new，但已有合法复习记录（reps > 0 且 lastReviewedAt 不晚于 now）时视为已学。
 */
function isLearned(card: SrsCard | undefined, now: number): boolean {
  if (!card) return false;
  if (card.status !== 'new') return true;
  return (
    typeof card.reps === 'number' &&
    card.reps > 0 &&
    typeof card.lastReviewedAt === 'number' &&
    card.lastReviewedAt <= now
  );
}

/** 某个词最近一次练习作答的时间戳（没有则 undefined）。 */
function lastAttemptAt(data: AppData, wordId: string): number | undefined {
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  let latest: number | undefined;
  for (const attempt of attempts) {
    if (!attempt || attempt.wordId !== wordId) continue;
    if (attempt.kind !== 'exercise') continue;
    const at = attempt.createdAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest;
}

/** 排除词 id 集合（脏数据里的非字符串 id 直接忽略）。 */
function toExcludeSet(excludeWordIds: string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(excludeWordIds)) return set;
  for (const id of excludeWordIds) {
    if (typeof id === 'string' && id.trim()) set.add(id.trim());
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 统计可用的新词 / 复习词 / 已掌握词数量（供仪表盘与扉页展示）。
 *
 * @param data 应用数据（只读）
 * @param now 当前时间（毫秒），缺省 Date.now()
 */
export function countAvailable(
  data: AppData,
  now?: number,
): { newWords: number; reviewWords: number; mastered: number } {
  const nowTs = normalizeNow(now);
  let newWords = 0;
  let reviewWords = 0;
  let mastered = 0;

  for (const word of wordsOf(data)) {
    const card = cardOf(data, word.id);
    if (isMasteredWord(data, word.id, card)) {
      mastered += 1;
      continue;
    }
    if (isLearned(card, nowTs)) reviewWords += 1;
    else newWords += 1;
  }

  return { newWords, reviewWords, mastered };
}

/**
 * 随机挑一个未学过且未掌握的词作为本轮新词；没有可用新词时返回 null。
 *
 * @param data 应用数据（只读）
 * @param now 当前时间（毫秒），缺省 Date.now()
 */
export function pickNewWord(data: AppData, now?: number): Word | null {
  return selectNewWord(data, normalizeNow(now), new Set<string>());
}

/**
 * 挑出复习词（按薄弱度排序）。
 *
 * @param data 应用数据（只读）
 * @param limit 最多返回多少个复习词
 * @param options.now 当前时间；options.excludeWordIds 需要排除的词（如本轮新词）
 */
export function pickReviewWords(
  data: AppData,
  limit: number,
  options: { now?: number; excludeWordIds?: string[] } = {},
): Word[] {
  const nowTs = normalizeNow(options?.now);
  const max =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (max <= 0) return [];

  const excluded = toExcludeSet(options?.excludeWordIds);
  const priority = data?.reviewPriority;

  const candidates = wordsOf(data).filter((word) => {
    if (excluded.has(word.id)) return false;
    const card = cardOf(data, word.id);
    if (isMasteredWord(data, word.id, card)) return false;
    return isLearned(card, nowTs);
  });

  const scored = candidates.map((word) => {
    const marked = priority && typeof priority === 'object' ? priority[word.id] : undefined;
    const priorityAt =
      typeof marked === 'number' && Number.isFinite(marked) ? marked : undefined;
    const lastAt = lastAttemptAt(data, word.id);
    return {
      word,
      priorityAt,
      score: scoreReviewWord(data, word, nowTs),
      // 从未作答的词视为最久远，优先复习。
      idleMs: typeof lastAt === 'number' ? nowTs - lastAt : Number.MAX_SAFE_INTEGER,
    };
  });

  scored.sort((a, b) => {
    // 闪卡「不认识」标记的词最优先；标记越早越优先。
    if (a.priorityAt !== undefined || b.priorityAt !== undefined) {
      if (a.priorityAt === undefined) return 1;
      if (b.priorityAt === undefined) return -1;
      if (a.priorityAt !== b.priorityAt) return a.priorityAt - b.priorityAt;
    }
    if (b.score !== a.score) return b.score - a.score;
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs; // 最近作答越久远越优先
    return a.word.id.localeCompare(b.word.id);
  });

  return scored.slice(0, max).map((item) => item.word);
}

/**
 * 规划一轮练习：1 个新词 + 4~6 个复习词。
 *
 * @param data 应用数据（只读）
 * @param settings 练习设置（决定每轮复习词数）
 * @param options.now 当前时间；options.excludeWordIds 本轮排除的词
 */
export function planRound(
  data: AppData,
  settings: PracticeSettings,
  options: { now?: number; excludeWordIds?: string[] } = {},
): RoundPlan {
  const nowTs = normalizeNow(options?.now);
  const excluded = toExcludeSet(options?.excludeWordIds);

  const newWordLimit = clamp(
    Math.round(
      typeof settings?.newWordsPerRound === 'number' && Number.isFinite(settings.newWordsPerRound)
        ? settings.newWordsPerRound
        : 1,
    ),
    MIN_NEW_WORDS,
    MAX_NEW_WORDS,
  );

  const newWords = selectNewWords(data, nowTs, excluded, newWordLimit);
  const newWord = newWords[0] ?? null;

  // 本轮新词不重复复习。
  const reviewExcluded = new Set(excluded);
  for (const word of newWords) reviewExcluded.add(word.id);

  const reviewLimit = clamp(
    Math.round(
      typeof settings?.reviewWordsPerRound === 'number' &&
        Number.isFinite(settings.reviewWordsPerRound)
        ? settings.reviewWordsPerRound
        : DEFAULT_REVIEW_WORDS,
    ),
    MIN_REVIEW_WORDS,
    MAX_REVIEW_WORDS,
  );

  const reviewWords = pickReviewWords(data, reviewLimit, {
    now: nowTs,
    excludeWordIds: [...reviewExcluded],
  });

  const roundNo = (data?.session?.roundNo ?? 0) + 1;

  return {
    id: uid('round'),
    roundNo: Number.isFinite(roundNo) ? roundNo : 1,
    newWord,
    newWords,
    reviewWords,
  };
}

/**
 * 复习优先级分数，分越高越该优先复习。
 *
 * = 薄弱度（错误次数、近期正确率、最近作答久远、闪卡「不认识」标记）
 * + SRS 侧信号（遗忘次数、学习阶段、已到期）。
 */
export function scoreReviewWord(data: AppData, word: Word, now?: number): number {
  const nowTs = normalizeNow(now);
  if (!data || typeof data !== 'object' || !word || typeof word !== 'object') return 0;

  const card = cardOf(data, word.id);
  // 已掌握的词不再参与复习排序（与 weakness 的口径保持一致）。
  if (isMasteredWord(data, word.id, card)) return 0;

  const base = scoreWordWeakness(data, word.id, nowTs);

  let bonus = 0;
  if (card) {
    const lapses = typeof card.lapses === 'number' && Number.isFinite(card.lapses) ? card.lapses : 0;
    bonus += lapses * 4;
    if (card.status === 'learning') bonus += 3;
    if (typeof card.dueAt === 'number' && Number.isFinite(card.dueAt) && card.dueAt <= nowTs) {
      bonus += 5;
    }
  }

  return Math.round((base + bonus) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* 内部实现                                                            */
/* ------------------------------------------------------------------ */

/** 每轮新词数的下限 / 上限。 */
export const MIN_NEW_WORDS = 1;
export const MAX_NEW_WORDS = 10;

/** 选未学过且未掌握的新词（可排除指定 id）。 */
function selectNewWords(
  data: AppData,
  now: number,
  excluded: Set<string>,
  count: number,
): Word[] {
  const candidates = wordsOf(data).filter((word) => {
    if (excluded.has(word.id)) return false;
    const card = cardOf(data, word.id);
    if (isMasteredWord(data, word.id, card)) return false;
    if (isLearned(card, now)) return false;
    const term = typeof word.term === 'string' ? word.term.trim() : '';
    return term.length > 0;
  });
  if (candidates.length === 0) return [];
  const limit = Math.max(MIN_NEW_WORDS, Math.min(MAX_NEW_WORDS, Math.round(count) || 1));
  return sample(candidates, limit);
}

/** 选一个未学过且未掌握的新词（可排除指定 id）。 */
function selectNewWord(data: AppData, now: number, excluded: Set<string>): Word | null {
  return selectNewWords(data, now, excluded, 1)[0] ?? null;
}
