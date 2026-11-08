import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearLookupCache,
  getCachedLookup,
  lookupCacheKey,
  normalizeLookupText,
  setCachedLookup,
  buildQuestionLookupContext,
} from './lookup';
import type { Question, Word } from '@/domain/types';

const WORD: Word = {
  id: 'w1',
  term: 'minimize',
  phonetic: '/ˈmɪnɪmaɪz/',
  partOfSpeech: 'v.',
  meaning: '使降到最低；最小化',
  tags: [],
  createdAt: 0,
};

const QUESTION: Question = {
  id: 'q1',
  wordId: 'w1',
  skill: 'en2zh',
  prompt: '「minimize」最接近以下哪个意思？',
  options: ['使降到最低；最小化', '最大化'],
  answer: '使降到最低；最小化',
  explanation: 'local',
  difficulty: 2,
};

describe('lookup cache helpers', () => {
  beforeEach(() => {
    clearLookupCache();
  });

  it('normalizeLookupText 压缩空白', () => {
    expect(normalizeLookupText('  foo   bar \n')).toBe('foo bar');
  });

  it('缓存按 kind + 文本 + 上下文区分', () => {
    setCachedLookup('word', 'Minimize', '释义 A');
    expect(getCachedLookup('word', 'minimize')).toBe('释义 A');
    expect(getCachedLookup('sentence', 'minimize')).toBeUndefined();
    expect(lookupCacheKey('word', 'MINIMIZE')).toBe(lookupCacheKey('word', 'minimize'));
  });

  it('buildQuestionLookupContext 带上题干与目标词', () => {
    const ctx = buildQuestionLookupContext(QUESTION, WORD);
    expect(ctx).toContain('minimize');
    expect(ctx).toContain('en2zh');
    expect(ctx).toContain(QUESTION.prompt);
  });
});
