/**
 * 一轮练习的选词与题量规划（v3：基于作答与掌握，无 SRS）。
 *
 * - 新词：未掌握且该 wordId 无任何 Attempt；
 * - 复习词：未掌握且已有 ≥1 次 Attempt；
 * - 排序：scoreReviewWord（薄弱度）降序，同分按最近作答久远优先。
 */

import type { AppData, PracticeSettings, Word } from './types';
import { clamp, sample, uid } from './utils';
import { isMastered } from './mastery';
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

/** 每轮新词数的下限 / 上限。 */
export const MIN_NEW_WORDS = 1;
export const MAX_NEW_WORDS = 10;

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function normalizeNow(now?: number): number {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

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

function attemptWordIds(data: AppData): Set<string> {
  const ids = new Set<string>();
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  for (const attempt of attempts) {
    if (!attempt || typeof attempt.wordId !== 'string') continue;
    const id = attempt.wordId.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function hasAttempts(data: AppData, wordId: string): boolean {
  return attemptWordIds(data).has(wordId);
}

function lastAttemptAt(data: AppData, wordId: string): number | undefined {
  const attempts = Array.isArray(data?.attempts) ? data.attempts : [];
  let latest: number | undefined;
  for (const attempt of attempts) {
    if (!attempt || attempt.wordId !== wordId) continue;
    const at = attempt.createdAt;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest;
}

function toExcludeSet(excludeWordIds: string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(excludeWordIds)) return set;
  for (const id of excludeWordIds) {
    if (typeof id === 'string' && id.trim()) set.add(id.trim());
  }
  return set;
}

function isNewWord(data: AppData, wordId: string): boolean {
  return !isMastered(data, wordId) && !hasAttempts(data, wordId);
}

function isReviewWord(data: AppData, wordId: string): boolean {
  return !isMastered(data, wordId) && hasAttempts(data, wordId);
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

export function countAvailable(
  data: AppData,
  _now?: number,
): { newWords: number; reviewWords: number; mastered: number } {
  let newWords = 0;
  let reviewWords = 0;
  let mastered = 0;

  for (const word of wordsOf(data)) {
    if (isMastered(data, word.id)) {
      mastered += 1;
      continue;
    }
    if (isNewWord(data, word.id)) newWords += 1;
    else if (isReviewWord(data, word.id)) reviewWords += 1;
  }

  return { newWords, reviewWords, mastered };
}

export function pickNewWord(data: AppData, _now?: number): Word | null {
  return selectNewWord(data, new Set<string>());
}

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

  const candidates = wordsOf(data).filter((word) => {
    if (excluded.has(word.id)) return false;
    return isReviewWord(data, word.id);
  });

  const scored = candidates.map((word) => {
    const lastAt = lastAttemptAt(data, word.id);
    return {
      word,
      score: scoreReviewWord(data, word, nowTs),
      idleMs: typeof lastAt === 'number' ? nowTs - lastAt : Number.MAX_SAFE_INTEGER,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.idleMs !== a.idleMs) return b.idleMs - a.idleMs;
    return a.word.id.localeCompare(b.word.id);
  });

  return scored.slice(0, max).map((item) => item.word);
}

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

  const newWords = selectNewWords(data, excluded, newWordLimit);
  const newWord = newWords[0] ?? null;

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

/** 复习优先级分数（v3 = 薄弱度）。 */
export function scoreReviewWord(data: AppData, word: Word, now?: number): number {
  const nowTs = normalizeNow(now);
  if (!data || typeof data !== 'object' || !word || typeof word !== 'object') return 0;
  if (isMastered(data, word.id)) return 0;
  return scoreWordWeakness(data, word.id, nowTs);
}

function selectNewWords(data: AppData, excluded: Set<string>, count: number): Word[] {
  const candidates = wordsOf(data).filter((word) => {
    if (excluded.has(word.id)) return false;
    if (!isNewWord(data, word.id)) return false;
    const term = typeof word.term === 'string' ? word.term.trim() : '';
    return term.length > 0;
  });
  if (candidates.length === 0) return [];
  const limit = Math.max(MIN_NEW_WORDS, Math.min(MAX_NEW_WORDS, Math.round(count) || 1));
  return sample(candidates, limit);
}

function selectNewWord(data: AppData, excluded: Set<string>): Word | null {
  return selectNewWords(data, excluded, 1)[0] ?? null;
}
