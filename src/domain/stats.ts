/** 统计与错题分析（v3：无 SRS / 闪卡）。 */

import type { Locale } from '@/i18n/types';
import { DEFAULT_LOCALE } from '@/i18n/types';
import { createT } from '@/i18n/t';
import type { AppData, Attempt, DailyStat, LearningStats, Mistake, Word } from './types';
import { isMastered } from './mastery';
import { dayKey, percent } from './utils';

export const DAILY_GOAL = 20;

export type WordLearningStatus = 'new' | 'learning' | 'review' | 'mastered';

export const WORD_LEARNING_STATUS_META: Record<
  WordLearningStatus,
  { label: string; tone: 'muted' | 'vermilion' | 'gold' | 'sage' }
> = {
  new: { label: 'New', tone: 'muted' },
  learning: { label: 'Learning', tone: 'vermilion' },
  review: { label: 'In review', tone: 'gold' },
  mastered: { label: 'Mastered', tone: 'sage' },
};

export function wordStatusLabel(status: WordLearningStatus, locale: Locale = DEFAULT_LOCALE): string {
  const t = createT(locale);
  return t(`domain.status.${status}`);
}

export interface Overview {
  totalWords: number;
  learnedWords: number;
  masteredCount: number;
  dueCount: number;
  newCount: number;
  todayReviewed: number;
  todayCorrect: number;
  todayAccuracy: number | null;
  accuracy7: number | null;
  streak: number;
  mistakeCount: number;
  unresolvedMistakes: number;
  todayProgress: number;
}

export interface WordProgress {
  word: Word;
  mistake?: Mistake;
  attempts: number;
  accuracy: number | null;
  wrongCount: number;
  correctStreak: number;
  lastAttemptAt?: number;
  status: WordLearningStatus;
  mastered: boolean;
}

export interface HeatmapCell {
  key: string;
  date: Date;
  reviewed: number;
  level: 0 | 1 | 2 | 3 | 4;
}

export interface RecentActivity {
  attempt: Attempt;
  word?: Word;
}

export function emptyDaily(): DailyStat {
  return { reviewed: 0, correct: 0, wrong: 0, learned: 0 };
}

export function getDailyStat(stats: LearningStats, ts = Date.now()): DailyStat {
  return stats.daily[dayKey(ts)] ?? emptyDaily();
}

export function recordDailyEvent(
  stats: LearningStats,
  event: { now?: number; correct: boolean; learned?: boolean; reviewedDelta?: number },
): LearningStats {
  const now = event.now ?? Date.now();
  const key = dayKey(now);
  const current = stats.daily[key] ?? emptyDaily();
  const next: DailyStat = {
    reviewed: current.reviewed + (event.reviewedDelta ?? 1),
    correct: current.correct + (event.correct ? 1 : 0),
    wrong: current.wrong + (event.correct ? 0 : 1),
    learned: current.learned + (event.learned ? 1 : 0),
  };
  return { ...stats, daily: { ...stats.daily, [key]: next } };
}

export function pruneDaily(stats: LearningStats, keepDays = 400, now = Date.now()): LearningStats {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const kept: Record<string, DailyStat> = {};
  for (const [key, value] of Object.entries(stats.daily)) {
    const ts = new Date(`${key}T00:00:00`).getTime();
    if (Number.isFinite(ts) && ts >= cutoff.getTime()) kept[key] = value;
  }
  return { ...stats, daily: kept };
}

export function computeStreak(daily: Record<string, DailyStat>, now = Date.now()): number {
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  if ((daily[dayKey(cursor)]?.reviewed ?? 0) <= 0) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  for (let i = 0; i < 3650; i += 1) {
    if ((daily[dayKey(cursor)]?.reviewed ?? 0) > 0) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

export function getAccuracy(
  attempts: Attempt[],
  options: { days?: number; now?: number } = {},
): number | null {
  const now = options.now ?? Date.now();
  const days = options.days;
  const since = days ? now - days * 86_400_000 : -Infinity;
  const relevant = attempts.filter((a) => a.createdAt >= since);
  if (relevant.length === 0) return null;
  const correct = relevant.filter((a) => a.correct).length;
  return percent(correct, relevant.length);
}

export function getHeatmap(
  daily: Record<string, DailyStat>,
  days = 28,
  now = Date.now(),
): HeatmapCell[] {
  const cells: HeatmapCell[] = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i += 1) {
    const key = dayKey(cursor);
    const reviewed = daily[key]?.reviewed ?? 0;
    const level: HeatmapCell['level'] =
      reviewed <= 0 ? 0 : reviewed < 5 ? 1 : reviewed < 10 ? 2 : reviewed < 20 ? 3 : 4;
    cells.push({ key, date: new Date(cursor), reviewed, level });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
}

export function accuracyForWord(attempts: Attempt[], wordId: string, sample = 10): number | null {
  const relevant = attempts
    .filter((a) => a.wordId === wordId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, sample);
  if (relevant.length === 0) return null;
  return percent(relevant.filter((a) => a.correct).length, relevant.length);
}

function wordStatus(data: AppData, wordId: string, attempts: number, mistake?: Mistake): WordLearningStatus {
  if (isMastered(data, wordId)) return 'mastered';
  if (attempts <= 0) return 'new';
  if (mistake && mistake.wrongCount > 0 && mistake.correctStreak < 2) return 'learning';
  return 'review';
}

export function getWordProgressList(data: AppData, _now = Date.now()): WordProgress[] {
  const byWord = new Map<string, Attempt[]>();
  for (const attempt of data.attempts) {
    const list = byWord.get(attempt.wordId);
    if (list) list.push(attempt);
    else byWord.set(attempt.wordId, [attempt]);
  }
  for (const list of byWord.values()) {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }
  return data.words.map((word) => {
    const mistake = data.mistakes[word.id];
    const attempts = byWord.get(word.id) ?? [];
    const accuracy = accuracyForWord(data.attempts, word.id);
    const mastered = isMastered(data, word.id);
    return {
      word,
      mistake,
      attempts: attempts.length,
      accuracy,
      wrongCount: mistake?.wrongCount ?? 0,
      correctStreak: mistake?.correctStreak ?? 0,
      lastAttemptAt: attempts[0]?.createdAt ?? mistake?.lastAttemptAt,
      status: wordStatus(data, word.id, attempts.length, mistake),
      mastered,
    };
  });
}

export function getWeakWords(
  data: AppData,
  limit = 8,
  options: { includeUnpracticed?: boolean; now?: number } = {},
): WordProgress[] {
  const now = options.now ?? Date.now();
  const list = getWordProgressList(data, now);
  const scored = list
    .map((item) => {
      let score = 0;
      if (item.mistake) {
        score += item.wrongCount * 12;
        score += Math.max(0, 3 - item.correctStreak) * 3;
        if (item.lastAttemptAt) {
          const daysAgo = (now - item.lastAttemptAt) / 86_400_000;
          if (daysAgo < 3) score += 6;
        }
      }
      if (item.accuracy !== null) score += Math.round((100 - item.accuracy) * 0.25);
      if (item.mastered && item.wrongCount === 0) score -= 20;
      return { item, score };
    })
    .filter(({ item, score }) => {
      if (score > 0) return true;
      if (!options.includeUnpracticed) return false;
      return item.status === 'new' || item.attempts === 0;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.lastAttemptAt ?? 0) - (a.item.lastAttemptAt ?? 0);
    });
  return scored.slice(0, limit).map(({ item }) => item);
}

export function getMistakeList(data: AppData, now = Date.now()): WordProgress[] {
  return getWordProgressList(data, now)
    .filter((item) => item.mistake && item.mistake.wrongCount > 0)
    .sort((a, b) => {
      const aResolved = a.mistake!.correctStreak >= 2;
      const bResolved = b.mistake!.correctStreak >= 2;
      if (aResolved !== bResolved) return aResolved ? 1 : -1;
      if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
      return b.mistake!.lastWrongAt - a.mistake!.lastWrongAt;
    });
}

export function getMasteryBreakdown(data: AppData): Record<WordLearningStatus, number> {
  const result: Record<WordLearningStatus, number> = {
    new: 0,
    learning: 0,
    review: 0,
    mastered: 0,
  };
  for (const item of getWordProgressList(data)) {
    result[item.status] += 1;
  }
  return result;
}

export function getRecentActivity(data: AppData, limit = 6): RecentActivity[] {
  const wordMap = new Map(data.words.map((word) => [word.id, word]));
  return [...data.attempts]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((attempt) => ({ attempt, word: wordMap.get(attempt.wordId) }));
}

function hasAttemptsForWord(data: AppData, wordId: string): boolean {
  return data.attempts.some((a) => a.wordId === wordId);
}

export function getOverview(data: AppData, now = Date.now()): Overview {
  let newCount = 0;
  let learnedWords = 0;
  let masteredCount = 0;
  let dueCount = 0;

  for (const word of data.words) {
    if (isMastered(data, word.id)) {
      masteredCount += 1;
      continue;
    }
    if (hasAttemptsForWord(data, word.id)) {
      learnedWords += 1;
      dueCount += 1;
    } else {
      newCount += 1;
    }
  }

  const today = getDailyStat(data.stats, now);
  const todayAccuracy =
    today.correct + today.wrong > 0 ? percent(today.correct, today.correct + today.wrong) : null;
  const mistakeList = getMistakeList(data, now);
  const unresolved = mistakeList.filter((item) => item.correctStreak < 2).length;

  return {
    totalWords: data.words.length,
    learnedWords,
    masteredCount,
    dueCount,
    newCount,
    todayReviewed: today.reviewed,
    todayCorrect: today.correct,
    todayAccuracy,
    accuracy7: getAccuracy(data.attempts, { days: 7, now }),
    streak: computeStreak(data.stats.daily, now),
    mistakeCount: mistakeList.length,
    unresolvedMistakes: unresolved,
    todayProgress: Math.min(100, Math.round((today.reviewed / DAILY_GOAL) * 100)),
  };
}
