/** 学习会话队列：学习中的卡片优先，其次是到期复习，最后是没学过的新词。 */

import type { AppData, SrsCard, StudyMode, StudyQueue, Word } from '../types';
import { createCard, isDue } from './srs';

export interface QueueOptions {
  now?: number;
  /** 本轮最多包含多少张卡 */
  limit?: number;
  /** 本轮最多引入多少张新词 */
  newLimit?: number;
  mode?: StudyMode;
}

export const DEFAULT_SESSION_LIMIT = 24;
export const DEFAULT_NEW_LIMIT = 10;

function sortedCards(
  words: Word[],
  cards: Record<string, SrsCard>,
  now: number,
): Array<{ word: Word; card: SrsCard }> {
  return words.map((word) => ({ word, card: cards[word.id] ?? createCard(word.id, now) }));
}

/** 组装今日学习队列。 */
export function buildStudyQueue(data: AppData, options: QueueOptions = {}): StudyQueue {
  const now = options.now ?? Date.now();
  const mode = options.mode ?? 'mixed';
  const limit = options.limit ?? DEFAULT_SESSION_LIMIT;
  const newLimit = options.newLimit ?? DEFAULT_NEW_LIMIT;
  const all = sortedCards(data.words, data.srs, now);

  const learning = all
    .filter(({ card }) => card.status === 'learning' && isDue(card, now))
    .sort((a, b) => a.card.dueAt - b.card.dueAt);

  const dueReviews = all
    .filter(
      ({ card }) =>
        (card.status === 'review' || card.status === 'mastered') && isDue(card, now),
    )
    .sort((a, b) => a.card.dueAt - b.card.dueAt);

  const dueCount = learning.length + dueReviews.length;
  const newWords = all.filter(({ card }) => card.status === 'new');
  const newCount = newWords.length;

  let picked: Array<{ word: Word; card: SrsCard; isNew: boolean; isDue: boolean }> = [];

  if (mode === 'review') {
    picked = [...learning, ...dueReviews].map(({ word, card }) => ({
      word,
      card,
      isNew: false,
      isDue: true,
    }));
  } else if (mode === 'new') {
    picked = newWords.slice(0, newLimit).map(({ word, card }) => ({
      word,
      card,
      isNew: true,
      isDue: false,
    }));
  } else {
    const dueItems = [...learning, ...dueReviews].map(({ word, card }) => ({
      word,
      card,
      isNew: false,
      isDue: true,
    }));
    const remainingSlots = Math.max(0, limit - dueItems.length);
    const limitedNew = newWords.slice(0, Math.min(newLimit, remainingSlots));
    picked = [...dueItems, ...limitedNew.map(({ word, card }) => ({
      word,
      card,
      isNew: true,
      isDue: false,
    }))];
  }

  return {
    items: picked.slice(0, limit),
    dueCount,
    newCount,
  };
}

/** 本轮之外，全库还有多少到期卡（用于仪表盘）。 */
export function countDue(data: AppData, now = Date.now()): { due: number; newWords: number } {
  let due = 0;
  let newWords = 0;
  for (const word of data.words) {
    const card = data.srs[word.id];
    if (!card || card.status === 'new') {
      newWords += 1;
      continue;
    }
    if (isDue(card, now)) due += 1;
  }
  return { due, newWords };
}

/** 供「专项复习」按词选取使用。 */
export function getWordWithCard(
  data: AppData,
  wordId: string,
  now = Date.now(),
): { word: Word; card: SrsCard } | null {
  const word = data.words.find((item) => item.id === wordId);
  if (!word) return null;
  return { word, card: data.srs[wordId] ?? createCard(wordId, now) };
}
