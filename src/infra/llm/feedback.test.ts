/**
 * AI 讲解与互译判分单测（vitest / node 环境，全部 mock 全局 fetch）。
 *
 * 口径来源：docs/phase-b-contract.md 第 7 节。
 * 覆盖：VERDICT 协议行解析、「改进：」段提取、本地降级讲解与判分、鼓励语、
 * 未配置模型时的降级（不抛错），以及 mock `/api/llm/forward` 代理后的流式解析。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMSettings, Question, Word } from '@/domain/types';
import {
  encouragement,
  localAnswerFeedback,
  localTranslationGrade,
  parseFeedbackImprovement,
  parseTranslationVerdict,
  streamAnswerFeedback,
  streamTranslationGrade,
} from './feedback';

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

const fetchMock = vi.fn();
const PROXY_PATH = '/api/llm/forward';

const NOW = new Date('2026-11-07T12:00:00+08:00').getTime();

const WORD: Word = {
  id: 'w1',
  term: 'abandon',
  phonetic: '/əˈbændən/',
  partOfSpeech: 'v.',
  meaning: '放弃；抛弃',
  example: 'He abandoned the plan last year.',
  exampleTranslation: '他去年放弃了这个计划。',
  tags: ['CET-4'],
  createdAt: NOW,
};

const CHOICE: Question = {
  id: 'ex_1',
  wordId: 'w1',
  skill: 'en2zh',
  prompt: '「abandon」最接近以下哪个意思？',
  options: ['放弃；抛弃', '蜡烛'],
  answer: '放弃；抛弃',
  explanation: '「abandon」意为「放弃；抛弃」。',
  difficulty: 2,
};

const TRANSLATE: Question = {
  id: 'ex_2',
  wordId: 'w1',
  skill: 'translate',
  prompt: '把下面的英文句子翻译成中文：He abandoned the plan last year.',
  answer: '他去年放弃了这个计划。',
  explanation: '参考译文：他去年放弃了这个计划。',
  difficulty: 4,
  direction: 'en2zh',
};

function makeSettings(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return {
    provider: 'openai',
    vendor: 'custom',
    thinkingMode: 'provider-default',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-key',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 1024,
    ...overrides,
  };
}

/** 轻量 headers shim：只提供 get('content-type')。 */
function headerBag(contentType?: string): Headers {
  return {
    get: (name: string) =>
      contentType && name.toLowerCase() === 'content-type' ? contentType : null,
  } as unknown as Headers;
}

/** 构造一个可流式读取的 SSE 响应。 */
function sseResponse(chunks: string | string[], contentType = 'text/event-stream'): Response {
  const parts = typeof chunks === 'string' ? [chunks] : chunks;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    headers: headerBag(contentType),
    body,
    text: async () => parts.join(''),
  } as unknown as Response;
}

function sseEvent(eventName: string | null, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${json}\n\n`;
}

function openAIDelta(token: string): string {
  return sseEvent(null, { choices: [{ index: 0, delta: { content: token } }] });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* 纯解析函数                                                          */
/* ------------------------------------------------------------------ */

describe('parseTranslationVerdict', () => {
  it('解析三档判定', () => {
    expect(parseTranslationVerdict('VERDICT: perfect')).toBe('perfect');
    expect(parseTranslationVerdict('VERDICT: good')).toBe('good');
    expect(parseTranslationVerdict('VERDICT: poor')).toBe('poor');
  });

  it('首行格式错误时返回 null', () => {
    // 缺冒号不是协议行。
    expect(parseTranslationVerdict('VERDICT perfect')).toBeNull();
    // 档位拼错（后面还跟字母）不匹配。
    expect(parseTranslationVerdict('VERDICT: perfectish')).toBeNull();
    expect(parseTranslationVerdict('VERDICT: unknown')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(parseTranslationVerdict('')).toBeNull();
    expect(parseTranslationVerdict(undefined as unknown as string)).toBeNull();
  });

  it('协议行不在首行时容错查找', () => {
    expect(parseTranslationVerdict('判分如下\nVERDICT: good')).toBe('good');
  });

  it('大小写不敏感', () => {
    expect(parseTranslationVerdict('VERDICT: POOR')).toBe('poor');
  });
});

describe('parseFeedbackImprovement', () => {
  it('抽出「改进：」段', () => {
    const text = '错因：与近义词混淆\n记忆点：abandon = 放弃\n改进：下次先默念中文再选';
    expect(parseFeedbackImprovement(text)).toBe('下次先默念中文再选');
  });

  it('支持「改进建议：」写法', () => {
    expect(parseFeedbackImprovement('改进建议：多读三遍')).toBe('多读三遍');
  });

  it('「改进」后面又出现段落标签时截断', () => {
    const text = '改进：先核对拼写\n错因：漏字母';
    expect(parseFeedbackImprovement(text)).toBe('先核对拼写');
  });

  it('没有「改进」段时返回 undefined', () => {
    expect(parseFeedbackImprovement('错因：与近义词混淆\n记忆点：abandon = 放弃')).toBeUndefined();
    expect(parseFeedbackImprovement('')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 本地降级                                                            */
/* ------------------------------------------------------------------ */

describe('localAnswerFeedback', () => {
  it('降级讲解含「错因 / 记忆点 / 改进」三段且状态为 local-fallback', () => {
    const feedback = localAnswerFeedback({
      word: WORD,
      question: CHOICE,
      response: '蜡烛',
    });
    expect(feedback.status).toBe('local-fallback');
    expect(feedback.explanation).toContain('错因：');
    expect(feedback.explanation).toContain('记忆点：');
    expect(feedback.explanation).toContain('改进：');
    expect(feedback.improvement && feedback.improvement.length).toBeGreaterThan(0);
    expect(feedback.explanation).toContain('蜡烛');
  });

  it('留白时也给出可读讲解', () => {
    const feedback = localAnswerFeedback({ word: WORD, question: CHOICE, response: '  ' });
    expect(feedback.status).toBe('local-fallback');
    expect(feedback.explanation).toContain('留白');
  });
});

describe('localTranslationGrade', () => {
  it('与参考译文一致判 perfect', () => {
    const grade = localTranslationGrade({
      word: WORD,
      question: TRANSLATE,
      response: TRANSLATE.answer,
    });
    expect(grade.verdict).toBe('perfect');
    expect(grade.status).toBe('local-fallback');
    expect(grade.improvement && grade.improvement.length).toBeGreaterThan(0);
  });

  it('意思接近判 good', () => {
    const grade = localTranslationGrade({
      word: WORD,
      question: TRANSLATE,
      response: '他去年放弃了那个计划。',
    });
    expect(grade.verdict).toBe('good');
  });

  it('意思差距大判 poor', () => {
    const grade = localTranslationGrade({
      word: WORD,
      question: TRANSLATE,
      response: '今天的天气非常好。',
    });
    expect(grade.verdict).toBe('poor');
  });

  it('留白判 poor', () => {
    const grade = localTranslationGrade({ word: WORD, question: TRANSLATE, response: '' });
    expect(grade.verdict).toBe('poor');
    expect(grade.explanation).toContain('留白');
  });
});

describe('encouragement', () => {
  it('返回非空的中文鼓励语', () => {
    const text = encouragement();
    expect(typeof text).toBe('string');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(encouragement(7).trim().length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 未配置模型时的降级                                                  */
/* ------------------------------------------------------------------ */

describe('未配置模型时的降级', () => {
  const unconfigured = makeSettings({ baseUrl: '', model: '', apiKey: '' });

  it('streamAnswerFeedback 未配置时返回 local-fallback 且不抛错', async () => {
    await expect(
      streamAnswerFeedback({ word: WORD, question: CHOICE, response: '蜡烛' }, unconfigured),
    ).resolves.toMatchObject({ status: 'local-fallback' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streamTranslationGrade 未配置时返回 local-fallback 且不抛错', async () => {
    const grade = await streamTranslationGrade(
      { word: WORD, question: TRANSLATE, response: '他去年放弃了这个计划。' },
      unconfigured,
    );
    expect(grade.status).toBe('local-fallback');
    expect(grade.verdict).toBe('perfect');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('网络失败时降级为本地讲解，不抛错', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const feedback = await streamAnswerFeedback(
      { word: WORD, question: CHOICE, response: '蜡烛' },
      makeSettings(),
    );
    expect(feedback.status).toBe('local-fallback');
    expect(feedback.explanation).toContain('错因：');
  });
});

/* ------------------------------------------------------------------ */
/* mock 代理转发：流式讲解 / 流式判分                                   */
/* ------------------------------------------------------------------ */

describe('streamAnswerFeedback（mock /api/llm/forward）', () => {
  it('解析 AI 讲解里的「改进：」段', async () => {
    const text = '错因：把 abandon 和 abdicate 混淆了\n记忆点：abandon = 放弃\n改进：下次先默念中文再选';
    fetchMock.mockResolvedValue(sseResponse([openAIDelta(text)]));

    const tokens: string[] = [];
    const feedback = await streamAnswerFeedback(
      { word: WORD, question: CHOICE, response: 'abdicate' },
      makeSettings(),
      { onToken: (chunk) => tokens.push(chunk) },
    );

    expect(feedback.status).toBe('ok');
    expect(feedback.explanation).toContain('错因：');
    expect(feedback.improvement).toBe('下次先默念中文再选');
    expect(tokens.join('')).toContain('记忆点');
    // 请求确实走了同源代理。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(PROXY_PATH);
  });
});

describe('streamTranslationGrade（mock /api/llm/forward）', () => {
  it('解析 VERDICT 协议行并回调 onVerdict', async () => {
    const text = 'VERDICT: good\n\n你的译文基本达意，但漏了时间状语。\n改进：注意补上 last year';
    fetchMock.mockResolvedValue(sseResponse([openAIDelta(text)]));

    const verdicts: string[] = [];
    const tokens: string[] = [];
    const grade = await streamTranslationGrade(
      { word: WORD, question: TRANSLATE, response: '他放弃了这个计划。' },
      makeSettings(),
      {
        onToken: (chunk) => tokens.push(chunk),
        onVerdict: (verdict) => verdicts.push(verdict),
      },
    );

    expect(grade.status).toBe('ok');
    expect(grade.verdict).toBe('good');
    expect(verdicts).toEqual(['good']);
    expect(grade.improvement).toBe('注意补上 last year');
    // onToken 只回传讲解正文，不含 VERDICT 行。
    expect(tokens.join('')).not.toContain('VERDICT');
    expect(tokens.join('')).toContain('你的译文基本达意');
  });

  it('模型没按协议输出时降级为本地判分', async () => {
    fetchMock.mockResolvedValue(sseResponse([openAIDelta('这段译文看起来还不错。')]));
    const grade = await streamTranslationGrade(
      { word: WORD, question: TRANSLATE, response: '他去年放弃了这个计划。' },
      makeSettings(),
    );
    expect(grade.status).toBe('local-fallback');
    expect(grade.verdict).toBe('perfect');
  });
});
