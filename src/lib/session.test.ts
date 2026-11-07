import { describe, expect, it } from 'vitest';
import type { AppData, SrsCard, Word } from '../types';
import { DATA_VERSION } from '../types';
import { DEFAULT_LLM_SETTINGS } from './storage';
import { createCard, gradeCard } from './srs';
import { buildStudyQueue, countDue, DEFAULT_NEW_LIMIT, DEFAULT_SESSION_LIMIT } from './session';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();
const DAY = 86_400_000;

function makeWord(id: string): Word {
  return {
    id,
    term: `word${id}`,
    meaning: '释义',
    tags: [],
    createdAt: NOW - 10 * DAY,
  };
}

function makeData(cards: Record<string, SrsCard>, count = 5): AppData {
  const words = Array.from({ length: count }, (_, index) => makeWord(`w${index + 1}`));
  return {
    version: DATA_VERSION,
    words,
    srs: cards,
    attempts: [],
    mistakes: {},
    settings: { ...DEFAULT_LLM_SETTINGS },
    theme: 'light',
    stats: { daily: {} },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('buildStudyQueue', () => {
  it('优先安排到期复习，再补新词，并受 limit 限制', () => {
    const due = gradeCard(gradeCard(createCard('w1', NOW), 'good', NOW - 7 * DAY), 'good', NOW - 6 * DAY);
    const learning = gradeCard(createCard('w3', NOW), 'again', NOW - DAY);
    const notDue = gradeCard(createCard('w4', NOW), 'good', NOW - DAY);
    const data = makeData({ w1: due, w3: learning, w4: notDue }, 4);

    const queue = buildStudyQueue(data, { now: NOW, limit: 10, newLimit: 2 });
    expect(queue.items.map((item) => item.word.id)).toEqual(['w3', 'w1', 'w2']);
    expect(queue.items[0].isDue).toBe(true);
    expect(queue.items[1].isDue).toBe(true);
    expect(queue.items[2].isNew).toBe(true); // w2 没有卡片 → 新词
    expect(queue.newCount).toBe(1);
    expect(queue.dueCount).toBe(2);
  });

  it('混合模式下新词数量不会超过剩余名额', () => {
    const due = gradeCard(createCard('w1', NOW), 'good', NOW - 7 * DAY);
    const data = makeData({ w1: due }, 20);
    const queue = buildStudyQueue(data, { now: NOW, limit: 5, newLimit: 10 });
    expect(queue.items).toHaveLength(5);
    expect(queue.items.filter((item) => item.isNew)).toHaveLength(4);
    expect(queue.items.filter((item) => item.isDue)).toHaveLength(1);
  });

  it('review 模式只返回到期卡', () => {
    const due = gradeCard(createCard('w1', NOW), 'good', NOW - 7 * DAY);
    const data = makeData({ w1: due }, 10);
    const queue = buildStudyQueue(data, { now: NOW, mode: 'review' });
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].word.id).toBe('w1');
  });

  it('new 模式只返回新词，最多 newLimit 个', () => {
    const data = makeData({}, 30);
    const queue = buildStudyQueue(data, { now: NOW, mode: 'new', newLimit: 3 });
    expect(queue.items).toHaveLength(3);
    expect(queue.items.every((item) => item.isNew)).toBe(true);
    expect(DEFAULT_NEW_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_SESSION_LIMIT).toBeGreaterThan(0);
  });

  it('没有任何单词时返回空队列', () => {
    const queue = buildStudyQueue(makeData({}, 0), { now: NOW });
    expect(queue.items).toEqual([]);
    expect(queue.dueCount).toBe(0);
    expect(queue.newCount).toBe(0);
  });

  it('到期卡超过 limit 时只取最早的', () => {
    const early = gradeCard(createCard('w1', NOW), 'good', NOW - 20 * DAY);
    const late = gradeCard(createCard('w2', NOW), 'good', NOW - 10 * DAY);
    const data = makeData({ w1: early, w2: late }, 2);
    const queue = buildStudyQueue(data, { now: NOW, limit: 1, mode: 'review' });
    expect(queue.items.map((item) => item.word.id)).toEqual(['w1']);
  });
});

describe('countDue', () => {
  it('分别统计到期卡与新词', () => {
    const due = gradeCard(createCard('w1', NOW), 'good', NOW - 7 * DAY);
    const notDue = gradeCard(createCard('w2', NOW), 'good', NOW);
    const data = makeData({ w1: due, w2: notDue }, 4);
    expect(countDue(data, NOW)).toEqual({ due: 1, newWords: 2 });
  });
});
