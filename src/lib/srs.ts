/**
 * 间隔重复（SRS）排程。
 *
 * 算法借鉴 SM-2，但针对「自评四档 + 学习步骤」做了简化：
 * - again：10 分钟后重来，难度系数下降、遗忘次数 +1；
 * - hard：间隔增长放慢，难度系数略降；
 * - good：按当前难度系数扩展间隔；
 * - easy：更快扩展，难度系数略升。
 * 间隔达到 30 天视为「已掌握」，但依旧会按计划到期复习。
 */

import type { Grade, SrsCard, SrsStatus } from '../types';
import { addDays, clamp } from './utils';

export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
export const MASTERED_INTERVAL = 30;
export const RELEARN_INTERVAL_MINUTES = 10;
/** 单次最长间隔（天），避免 5 年后才复习。 */
export const MAX_INTERVAL = 180;

export function createCard(wordId: string, now = Date.now()): SrsCard {
  return {
    wordId,
    status: 'new',
    ease: 2.5,
    interval: 0,
    dueAt: now,
    reps: 0,
    lapses: 0,
  };
}

function deriveStatus(reps: number, interval: number): SrsStatus {
  if (reps === 0) return 'new';
  if (interval >= MASTERED_INTERVAL) return 'mastered';
  if (reps >= 2) return 'review';
  return 'learning';
}

/** 对一张卡片执行一次自评，返回新卡片（不修改入参）。 */
export function gradeCard(card: SrsCard, grade: Grade, now = Date.now()): SrsCard {
  const reps = card.reps + 1;
  let ease = card.ease;
  let interval = card.interval;
  let lapses = card.lapses;
  let dueAt: number;

  if (grade === 'again') {
    ease = clamp(ease - 0.2, MIN_EASE, MAX_EASE);
    lapses += 1;
    interval = 0;
    dueAt = now + RELEARN_INTERVAL_MINUTES * 60_000;
    return {
      ...card,
      ease,
      interval,
      lapses,
      reps,
      status: 'learning',
      dueAt,
      lastReviewedAt: now,
    };
  }

  // 只有真正的第一次作答使用固定学习步长；此后的复习（包括 relearn）都在既有间隔上扩展
  const wasFresh = card.reps === 0 || card.status === 'new';

  if (wasFresh) {
    // 初次/学习阶段：用固定的小步长建立记忆
    if (grade === 'hard') {
      ease = clamp(ease - 0.12, MIN_EASE, MAX_EASE);
      interval = 1;
    } else if (grade === 'good') {
      interval = 2;
    } else {
      ease = clamp(ease + 0.1, MIN_EASE, MAX_EASE);
      interval = 4;
    }
  } else {
    // 复习阶段：在既有间隔上扩展
    if (grade === 'hard') {
      ease = clamp(ease - 0.12, MIN_EASE, MAX_EASE);
      interval = Math.max(1, Math.round(interval * 1.2));
    } else if (grade === 'good') {
      interval = Math.max(1, Math.round(interval * ease));
    } else {
      ease = clamp(ease + 0.1, MIN_EASE, MAX_EASE);
      interval = Math.max(2, Math.round(interval * ease * 1.3));
    }
  }

  interval = clamp(interval, 1, MAX_INTERVAL);
  dueAt = addDays(now, interval);

  return {
    ...card,
    ease,
    interval,
    lapses,
    reps,
    status: deriveStatus(reps, interval),
    dueAt,
    lastReviewedAt: now,
  };
}

export function isDue(card: SrsCard, now = Date.now()): boolean {
  return card.dueAt <= now;
}

/** 闪卡按钮上的间隔预览文案。 */
export function previewInterval(card: SrsCard, grade: Grade, now = Date.now()): string {
  const next = gradeCard(card, grade, now);
  const diff = next.dueAt - now;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(diff / 86_400_000);
  if (days < 60) return `${days} 天`;
  return `${Math.round(days / 30)} 个月`;
}

export const GRADE_META: Record<
  Grade,
  { label: string; hint: string; tone: 'again' | 'hard' | 'good' | 'easy'; key: string }
> = {
  again: { label: '没记住', hint: '10 分钟后再来', tone: 'again', key: '1' },
  hard: { label: '有点模糊', hint: '缩短间隔', tone: 'hard', key: '2' },
  good: { label: '记住了', hint: '正常推进', tone: 'good', key: '3' },
  easy: { label: '太简单了', hint: '拉长间隔', tone: 'easy', key: '4' },
};

export const SRS_STATUS_META: Record<
  SrsStatus,
  { label: string; tone: 'muted' | 'vermilion' | 'gold' | 'sage' }
> = {
  new: { label: '新词', tone: 'muted' },
  learning: { label: '学习中', tone: 'vermilion' },
  review: { label: '复习中', tone: 'gold' },
  mastered: { label: '已掌握', tone: 'sage' },
};

/** 0~100 的主观掌握度，用于进度条。 */
export function masteryScore(card: SrsCard): number {
  if (card.status === 'new') return 0;
  if (card.interval >= MASTERED_INTERVAL) return 100;
  if (card.status === 'learning') return Math.min(35, 10 + card.reps * 8);
  return clamp(Math.round(30 + (card.interval / MASTERED_INTERVAL) * 65), 30, 96);
}
