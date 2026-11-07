import { describe, expect, it } from 'vitest';
import type { SrsCard } from '../types';
import {
  MASTERED_INTERVAL,
  MIN_EASE,
  MAX_EASE,
  createCard,
  gradeCard,
  isDue,
  masteryScore,
  previewInterval,
} from './srs';

const NOW = new Date('2026-11-07T09:00:00+08:00').getTime();
const DAY = 86_400_000;

function after(card: SrsCard, grade: Parameters<typeof gradeCard>[1], now = NOW) {
  return gradeCard(card, grade, now);
}

describe('createCard', () => {
  it('新卡是 new 状态、立即到期', () => {
    const card = createCard('w1', NOW);
    expect(card).toMatchObject({
      wordId: 'w1',
      status: 'new',
      ease: 2.5,
      interval: 0,
      reps: 0,
      lapses: 0,
      dueAt: NOW,
    });
    expect(isDue(card, NOW)).toBe(true);
  });
});

describe('gradeCard', () => {
  it('again 会进入 10 分钟学习步并记录遗忘', () => {
    const card = createCard('w1', NOW);
    const next = after(card, 'again');
    expect(next.status).toBe('learning');
    expect(next.interval).toBe(0);
    expect(next.lapses).toBe(1);
    expect(next.reps).toBe(1);
    expect(next.ease).toBeLessThan(card.ease);
    expect(next.dueAt).toBe(NOW + 10 * 60_000);
    expect(isDue(next, NOW)).toBe(false);
    expect(isDue(next, NOW + 10 * 60_000)).toBe(true);
  });

  it('新词 good 后间隔为 2 天，状态仍为 learning', () => {
    const next = after(createCard('w1', NOW), 'good');
    expect(next.interval).toBe(2);
    expect(next.status).toBe('learning');
    expect(next.dueAt).toBe(NOW + 2 * DAY);
    expect(next.lastReviewedAt).toBe(NOW);
  });

  it('新词 easy 的初始间隔大于 good，hard 最小', () => {
    const hard = after(createCard('w1', NOW), 'hard');
    const good = after(createCard('w1', NOW), 'good');
    const easy = after(createCard('w1', NOW), 'easy');
    expect(hard.interval).toBeLessThan(good.interval);
    expect(good.interval).toBeLessThan(easy.interval);
  });

  it('复习阶段的 good 会按难度系数扩展间隔并进入 review', () => {
    const learning = after(createCard('w1', NOW), 'good'); // interval 2, reps 1
    const review = after(learning, 'good'); // interval round(2*2.5)=5, reps 2
    expect(review.interval).toBe(5);
    expect(review.status).toBe('review');
    expect(review.dueAt).toBe(NOW + 5 * DAY);
  });

  it('连续 easy 最终达成 mastered（间隔 >= 30 天）', () => {
    let card = createCard('w1', NOW);
    for (let i = 0; i < 6; i += 1) card = after(card, 'easy');
    expect(card.interval).toBeGreaterThanOrEqual(MASTERED_INTERVAL);
    expect(card.status).toBe('mastered');
    expect(masteryScore(card)).toBe(100);
  });

  it('复习阶段 again 会回到 learning 并保留既有间隔历史', () => {
    let card = createCard('w1', NOW);
    card = after(card, 'good');
    card = after(card, 'good');
    const previousInterval = card.interval;
    const lapsed = after(card, 'again');
    expect(lapsed.status).toBe('learning');
    expect(lapsed.interval).toBe(0);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.dueAt).toBe(NOW + 10 * 60_000);
    expect(previousInterval).toBeGreaterThan(0);
  });

  it('难度系数始终被限制在 [1.3, 3.0]', () => {
    let card = createCard('w1', NOW);
    for (let i = 0; i < 20; i += 1) card = after(card, 'again');
    expect(card.ease).toBeGreaterThanOrEqual(MIN_EASE);

    card = createCard('w2', NOW);
    for (let i = 0; i < 20; i += 1) card = after(card, 'easy');
    expect(card.ease).toBeLessThanOrEqual(MAX_EASE);
  });

  it('间隔不会超过 180 天', () => {
    let card = createCard('w1', NOW);
    for (let i = 0; i < 20; i += 1) card = after(card, 'easy');
    expect(card.interval).toBeLessThanOrEqual(180);
  });

  it('不修改传入的卡片对象', () => {
    const card = createCard('w1', NOW);
    const snapshot = { ...card };
    after(card, 'good');
    expect(card).toEqual(snapshot);
  });
});

describe('预览与掌握度', () => {
  it('previewInterval 返回中文时间文案', () => {
    expect(previewInterval(createCard('w1', NOW), 'again')).toBe('10 分钟');
    expect(previewInterval(createCard('w1', NOW), 'hard')).toMatch(/天/);
    expect(previewInterval(createCard('w1', NOW), 'easy')).toMatch(/天/);
  });

  it('masteryScore 随状态递增', () => {
    const fresh = createCard('w1', NOW);
    const learning = after(fresh, 'good');
    let review = learning;
    review = after(review, 'good');
    expect(masteryScore(fresh)).toBe(0);
    expect(masteryScore(learning)).toBeGreaterThan(0);
    expect(masteryScore(review)).toBeGreaterThan(masteryScore(learning));
  });
});
