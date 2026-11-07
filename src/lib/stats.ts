/** 统计与错题分析：仪表盘、错题本、AI 特训选词都从这里取数。 */

import type {
  AppData,
  Attempt,
  DailyStat,
  LearningStats,
  Mistake,
  SrsCard,
  SrsStatus,
  Word,
} from '../types';
import { createCard, isDue, masteryScore } from './srs';
import { dayKey, percent } from './utils';

export const DAILY_GOAL = 20;

export interface Overview {
  totalWords: number;
  learnedWords: number;
  masteredCount: number;
  dueCount: number;
  newCount: number;
  /** 今日完成的学习/练习次数 */
  todayReviewed: number;
  todayCorrect: number;
  todayAccuracy: number | null;
  /** 近 7 天正确率 */
  accuracy7: number | null;
  streak: number;
  mistakeCount: number;
  unresolvedMistakes: number;
  /** 今日目标完成度 0~100 */
  todayProgress: number;
}

export interface WordProgress {
  word: Word;
  card: SrsCard;
  mistake?: Mistake;
  attempts: number;
  /** 最近最多 10 次的正确率 */
  accuracy: number | null;
  wrongCount: number;
  correctStreak: number;
  lastAttemptAt?: number;
  mastery: number;
  due: boolean;
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

/** 把一次学习事件写入当日统计，返回新的 stats（不修改入参）。 */
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

/** 只保留最近 N 天的每日统计，避免 localStorage 无限增长。 */
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

/** 连击天数：以今天（或昨天，若今天还没学）为终点，向前数连续有学习记录的天数。 */
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

/** 近 N 天热力图，按时间从旧到新排列。 */
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
  const relevant = attempts.filter((a) => a.wordId === wordId).slice(0, sample);
  if (relevant.length === 0) return null;
  return percent(relevant.filter((a) => a.correct).length, relevant.length);
}

/** 把整个词库映射为带学习进度的列表，供词库页 / 错题本 / 特训选词使用。 */
export function getWordProgressList(data: AppData, now = Date.now()): WordProgress[] {
  const byWord = new Map<string, Attempt[]>();
  for (const attempt of data.attempts) {
    const list = byWord.get(attempt.wordId);
    if (list) list.push(attempt);
    else byWord.set(attempt.wordId, [attempt]);
  }
  return data.words.map((word) => {
    const card = data.srs[word.id] ?? createCard(word.id, now);
    const mistake = data.mistakes[word.id];
    const attempts = byWord.get(word.id) ?? [];
    const accuracy = accuracyForWord(attempts, word.id);
    return {
      word,
      card,
      mistake,
      attempts: attempts.length,
      accuracy,
      wrongCount: mistake?.wrongCount ?? 0,
      correctStreak: mistake?.correctStreak ?? 0,
      lastAttemptAt: attempts[0]?.createdAt ?? mistake?.lastAttemptAt,
      mastery: masteryScore(card),
      due: card.status !== 'new' && isDue(card, now),
    };
  });
}

/**
 * 薄弱词排序：错误次数权重最高，其次是近期正确率、遗忘次数与到期状态。
 * 默认只返回「有过错误或明显薄弱」的词；没有错题时可通过 includeUnpracticed
 * 回退到尚未练习的词。
 */
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
      score += item.card.lapses * 4;
      if (item.due) score += 5;
      if (item.card.status === 'mastered' && item.wrongCount === 0) score -= 20;
      return { item, score };
    })
    .filter(({ item, score }) => {
      if (score > 0) return true;
      if (!options.includeUnpracticed) return false;
      return item.card.status === 'new' || item.attempts === 0;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.item.lastAttemptAt ?? 0) - (a.item.lastAttemptAt ?? 0);
    });
  return scored.slice(0, limit).map(({ item }) => item);
}

/** 错题本列表：有答错记录的词，按错误次数与最近出错时间排序。 */
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

export function getMasteryBreakdown(data: AppData): Record<SrsStatus, number> {
  const result: Record<SrsStatus, number> = { new: 0, learning: 0, review: 0, mastered: 0 };
  for (const word of data.words) {
    const card = data.srs[word.id];
    result[card?.status ?? 'new'] += 1;
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

export function getOverview(data: AppData, now = Date.now()): Overview {
  let dueCount = 0;
  let newCount = 0;
  let masteredCount = 0;
  let learnedWords = 0;
  for (const word of data.words) {
    const card = data.srs[word.id];
    if (!card) {
      newCount += 1;
      continue;
    }
    if (card.status === 'new') {
      newCount += 1;
    } else {
      learnedWords += 1;
      if (isDue(card, now)) dueCount += 1;
      if (card.status === 'mastered') masteredCount += 1;
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
