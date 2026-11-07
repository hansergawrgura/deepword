/**
 * LLM 出题层单元测试（vitest，node 环境，全部 mock 全局 fetch）。
 *
 * 覆盖：URL 规范化、OpenAI / Anthropic 请求构造与响应解析、response_format 降级重试、
 * 错误码映射、连通性测试不抛错、提示词内容、以及生成层的 JSON 容错 / 严格校验 /
 * 答案修正 / 选项打乱 / 去重 / 题量限制 / 取消。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMSettings, Word } from '../../types';
import type { ExerciseRequest, ExerciseTarget } from './types';
import { LLMError } from './types';
import {
  chatComplete,
  hasUsableLLMConfig,
  parseAnthropicContent,
  parseOpenAIContent,
  resolveEndpoint,
  testLLMConnection,
} from './providers';
import { buildMessages, PROMPT_VERSION, SYSTEM_PROMPT } from './prompts';
import { extractJsonCandidate, generateExercises, parseExercises } from './generate';
import * as llmEntry from './index';

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

const fetchMock = vi.fn();

interface FetchCall {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fetchCallAt(index: number): FetchCall {
  const calls = fetchMock.mock.calls;
  const normalizedIndex = index < 0 ? calls.length + index : index;
  const args = calls[normalizedIndex] as [RequestInfo | URL, RequestInit | undefined] | undefined;
  if (!args) throw new Error(`没有第 ${index} 次 fetch 调用`);

  const [input, init] = args;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const requestInit = init ?? {};
  const headers = (requestInit.headers ?? {}) as Record<string, string>;
  const body =
    typeof requestInit.body === 'string' ? (JSON.parse(requestInit.body) as Record<string, unknown>) : {};

  return { url, init: requestInit, headers, body };
}

function lastFetchCall(): FetchCall {
  return fetchCallAt(-1);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as unknown as Response;
}

function openAICompletion(content: string): Response {
  return jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content } }] });
}

function anthropicCompletion(text: string): Response {
  return jsonResponse({ content: [{ type: 'text', text }] });
}

function completionWithExercises(exercises: unknown[]): Response {
  return openAICompletion(JSON.stringify({ exercises }));
}

/** 挂起直到 AbortSignal 触发（用于超时 / 取消测试）。 */
function pendingOnAbort(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      if (signal?.aborted) {
        reject(abortError);
        return;
      }
      signal?.addEventListener('abort', () => reject(abortError), { once: true });
    });
}

function makeSettings(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return {
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1/',
    apiKey: 'sk-test-key',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 1024,
    ...overrides,
  };
}

function anthropicSettings(overrides: Partial<LLMSettings> = {}): LLMSettings {
  return makeSettings({
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    model: 'claude-3-5-sonnet-latest',
    ...overrides,
  });
}

function makeWord(overrides: Partial<Word> = {}): Word {
  return {
    id: 'w_abandon',
    term: 'abandon',
    meaning: '放弃；抛弃',
    partOfSpeech: 'v.',
    example: 'He abandoned the plan.',
    exampleTranslation: '他放弃了这个计划。',
    tags: ['CET-4'],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<ExerciseTarget> = {}): ExerciseTarget {
  return {
    word: makeWord(),
    wrongCount: 3,
    correctStreak: 0,
    srsStatus: 'learning',
    lastExerciseType: 'choice',
    recentAccuracy: 0.3,
    ...overrides,
  };
}

function targetFor(wordId: string, term = 'abandon'): ExerciseTarget {
  return makeTarget({ word: makeWord({ id: wordId, term }) });
}

function makeRequest(overrides: Partial<ExerciseRequest> = {}): ExerciseRequest {
  return {
    targets: [makeTarget()],
    count: 2,
    difficulty: 'adaptive',
    settings: makeSettings(),
    ...overrides,
  };
}

function choiceItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wordId: 'w_abandon',
    type: 'choice',
    prompt: '「abandon」最接近的意思是？',
    options: ['放弃；抛弃', '建造', '灌溉', '测量'],
    answer: '放弃；抛弃',
    acceptableAnswers: [],
    explanation: 'abandon 表示放弃、抛弃。',
    difficulty: 3,
    ...overrides,
  };
}

function fillItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wordId: 'w_abandon',
    type: 'fill',
    prompt: 'He decided to ____ the plan.',
    answer: 'abandon',
    acceptableAnswers: ['abandoned', 'give up'],
    explanation: 'decide to do 后接动词原形 abandon。',
    difficulty: 2,
    ...overrides,
  };
}

function payloadOf(...exercises: unknown[]): string {
  return JSON.stringify({ exercises });
}

function syncLLMError(fn: () => unknown): LLMError {
  try {
    fn();
  } catch (error) {
    if (error instanceof LLMError) return error;
    throw error;
  }
  throw new Error('预期抛出 LLMError，但没有抛错');
}

async function asyncLLMError(fn: () => Promise<unknown>): Promise<LLMError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof LLMError) return error;
    throw error;
  }
  throw new Error('预期抛出 LLMError，但没有抛错');
}

/* ------------------------------------------------------------------ */
/* resolveEndpoint                                                     */
/* ------------------------------------------------------------------ */

describe('resolveEndpoint', () => {
  it('为 OpenAI 兼容接口拼接 /chat/completions', () => {
    expect(resolveEndpoint({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1' })).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(resolveEndpoint({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1/' })).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(resolveEndpoint({ provider: 'openai', baseUrl: 'https://api.openai.com' })).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(resolveEndpoint({ provider: 'openai', baseUrl: 'http://localhost:11434' })).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('已包含 /chat/completions 时不再重复拼接', () => {
    expect(
      resolveEndpoint({ provider: 'openai', baseUrl: 'https://gateway.example.com/v1/chat/completions' }),
    ).toBe('https://gateway.example.com/v1/chat/completions');
  });

  it('为 Anthropic 拼接 /v1/messages', () => {
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(
      resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages' }),
    ).toBe('https://api.anthropic.com/v1/messages');
  });

  it('baseUrl 为空时抛 config', () => {
    const error = syncLLMError(() => resolveEndpoint({ provider: 'openai', baseUrl: '   ' }));
    expect(error.code).toBe('config');
  });
});

/* ------------------------------------------------------------------ */
/* chatComplete：OpenAI 兼容                                           */
/* ------------------------------------------------------------------ */

describe('chatComplete：OpenAI 兼容', () => {
  it('正常解析 choices[0].message.content，并发送正确的请求', async () => {
    fetchMock.mockResolvedValue(openAICompletion('hello'));

    const text = await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], {
      jsonMode: true,
    });
    expect(text).toBe('hello');

    const call = lastFetchCall();
    expect(call.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Authorization).toBe('Bearer sk-test-key');
    expect(call.body.model).toBe('deepseek-chat');
    expect(call.body.max_tokens).toBe(1024);
    expect(call.body.temperature).toBe(0.7);
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    expect(call.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('未开启 jsonMode 时不发送 response_format', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]);
    expect(lastFetchCall().body.response_format).toBeUndefined();
  });

  it('apiKey 为空时不发送 Authorization 头（兼容本地 Ollama）', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings({ apiKey: '   ' }), [{ role: 'user', content: 'hi' }]);
    expect(lastFetchCall().headers.Authorization).toBeUndefined();
  });

  it('服务端不支持 response_format（400）时自动去掉重试一次', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'response_format is not supported' } }, 400),
      )
      .mockResolvedValueOnce(openAICompletion('{"exercises":[]}'));

    const text = await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], {
      jsonMode: true,
    });
    expect(text).toBe('{"exercises":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchCallAt(0).body.response_format).toEqual({ type: 'json_object' });
    expect(fetchCallAt(1).body.response_format).toBeUndefined();
  });

  it('content 为多段数组时拼接文本', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: [{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }] } }],
      }),
    );
    const text = await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('hello');
  });

  it('content 为空时返回空字符串', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' } }] }));
    await expect(chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }])).resolves.toBe('');
  });

  it('响应体不是 JSON 时抛 parse', async () => {
    fetchMock.mockResolvedValue(jsonResponse('plain text'));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('parse');
  });
});

/* ------------------------------------------------------------------ */
/* 错误映射                                                            */
/* ------------------------------------------------------------------ */

describe('chatComplete：错误映射', () => {
  it('401 → auth，且不会做 response_format 重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { jsonMode: true }),
    );
    expect(error.code).toBe('auth');
    expect(error.message).toContain('API Key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 → rate-limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'slow down' } }, 429));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('rate-limit');
  });

  it('5xx → server', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 503));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('server');
  });

  it('其他非 2xx → http（带状态码与服务端摘要）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request detail' } }, 422));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('http');
    expect(error.message).toContain('HTTP 422');
    expect(error.message).toContain('bad request detail');
  });

  it('fetch TypeError → network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('network');
  });

  it('请求超时 → timeout', async () => {
    fetchMock.mockImplementation(pendingOnAbort());
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { timeoutMs: 10 }),
    );
    expect(error.code).toBe('timeout');
  });

  it('调用方已取消 → aborted，且不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { signal: controller.signal }),
    );
    expect(error.code).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求进行中取消 → aborted', async () => {
    fetchMock.mockImplementation(pendingOnAbort());
    const controller = new AbortController();
    const promise = asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    );
    setTimeout(() => controller.abort(), 5);
    const error = await promise;
    expect(error.code).toBe('aborted');
  });
});

/* ------------------------------------------------------------------ */
/* chatComplete：Anthropic                                             */
/* ------------------------------------------------------------------ */

describe('chatComplete：Anthropic', () => {
  it('拆分 system 消息并发送 Anthropic 必需请求头', async () => {
    fetchMock.mockResolvedValue(anthropicCompletion('OK'));

    const text = await chatComplete(
      anthropicSettings(),
      [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '用户问题' },
      ],
      { jsonMode: true },
    );
    expect(text).toBe('OK');

    const call = lastFetchCall();
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(call.body.system).toBe('系统指令');
    expect(call.body.messages).toEqual([{ role: 'user', content: '用户问题' }]);
    expect(call.body.max_tokens).toBe(1024);
    // Anthropic 不支持 OpenAI 的 response_format，不应发送
    expect(call.body.response_format).toBeUndefined();
  });

  it('拼接 content 中所有 text 块，忽略非 text 块', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'text', text: '{"exercises":' },
          { type: 'thinking', thinking: '不该出现' },
          { type: 'text', text: '[]}' },
        ],
      }),
    );
    const text = await chatComplete(anthropicSettings(), [{ role: 'user', content: 'hi' }]);
    expect(text).toBe('{"exercises":[]}');
  });

  it('缺少 API Key 时抛 config，且不发请求', async () => {
    const error = await asyncLLMError(() =>
      chatComplete(anthropicSettings({ apiKey: '' }), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('config');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('响应解析纯函数', () => {
  it('parseOpenAIContent 兼容空 choices / 旧版 text / 顶层 content', () => {
    expect(parseOpenAIContent({ choices: [] })).toBe('');
    expect(parseOpenAIContent({})).toBe('');
    expect(parseOpenAIContent({ choices: [{ text: 'legacy' }] })).toBe('legacy');
    expect(parseOpenAIContent({ content: 'direct' })).toBe('direct');
    expect(parseOpenAIContent(null)).toBe('');
  });

  it('parseAnthropicContent 只拼接 text 块', () => {
    expect(
      parseAnthropicContent({
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'x' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
    expect(parseAnthropicContent({ content: [] })).toBe('');
    expect(parseAnthropicContent({})).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* hasUsableLLMConfig / testLLMConnection                              */
/* ------------------------------------------------------------------ */

describe('hasUsableLLMConfig', () => {
  it('baseUrl 与 model 非空即可（允许空 apiKey 以支持 Ollama）', () => {
    expect(hasUsableLLMConfig(makeSettings({ apiKey: '' }))).toBe(true);
    expect(hasUsableLLMConfig(makeSettings({ baseUrl: '   ' }))).toBe(false);
    expect(hasUsableLLMConfig(makeSettings({ model: '' }))).toBe(false);
  });
});

describe('testLLMConnection', () => {
  it('成功时返回 ok、延迟与模型名，并发送极短请求', async () => {
    fetchMock.mockResolvedValue(openAICompletion('OK'));

    const result = await testLLMConnection(makeSettings());

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toContain('连接成功');
    expect(result.model).toBe('deepseek-chat');
    expect(lastFetchCall().body.max_tokens).toBe(8);
  });

  it('401 时返回 ok:false 且不抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401));

    const result = await testLLMConnection(makeSettings());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('API Key');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('网络错误时返回可操作的中文提示且不抛错', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const result = await testLLMConnection(makeSettings());

    expect(result.ok).toBe(false);
    expect(result.message).toContain('网络');
  });

  it('配置缺失时直接返回提示且不发请求', async () => {
    const result = await testLLMConnection(makeSettings({ baseUrl: '' }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Base URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Anthropic 缺 API Key 时返回提示且不发请求', async () => {
    const result = await testLLMConnection(anthropicSettings({ apiKey: '' }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* prompts                                                             */
/* ------------------------------------------------------------------ */

describe('prompts', () => {
  it('导出提示词版本与中文系统提示', () => {
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).toContain('资深');
    expect(SYSTEM_PROMPT).toContain('JSON');
    expect(SYSTEM_PROMPT).toContain('____');
    expect(SYSTEM_PROMPT).toContain('correction');
  });

  it('buildMessages 携带错词上下文与输出格式约束', () => {
    const messages = buildMessages(makeRequest({ count: 3 }));

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    const userPrompt = messages[1].content;
    expect(userPrompt).toContain('w_abandon');
    expect(userPrompt).toContain('abandon');
    expect(userPrompt).toContain('放弃；抛弃');
    expect(userPrompt).toContain('"wrongCount": 3');
    expect(userPrompt).toContain('"lastExerciseType": "choice"');
    expect(userPrompt).toContain('"recentAccuracy": 0.3');
    expect(userPrompt).toContain('adaptive');
    expect(userPrompt).toContain('"exercises"');
    expect(userPrompt).toContain('3 道');
  });

  it('难度档位影响提示词内容', () => {
    expect(buildMessages(makeRequest({ difficulty: 'foundation' }))[1].content).toContain('foundation');
    expect(buildMessages(makeRequest({ difficulty: 'challenge' }))[1].content).toContain('challenge');
  });
});

/* ------------------------------------------------------------------ */
/* JSON 提取容错                                                       */
/* ------------------------------------------------------------------ */

describe('extractJsonCandidate', () => {
  it('去掉 markdown 代码围栏', () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonCandidate('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('截取夹在解释文字中的 JSON 对象', () => {
    expect(extractJsonCandidate('好的，结果如下：{"a":1} 希望对你有帮助')).toBe('{"a":1}');
  });

  it('没有 JSON 时返回 null', () => {
    expect(extractJsonCandidate('抱歉，我无法完成。')).toBeNull();
    expect(extractJsonCandidate('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* parseExercises：严格校验                                            */
/* ------------------------------------------------------------------ */

describe('parseExercises', () => {
  const singleTargetRequest = () => ({ targets: [makeTarget()], count: 5 });

  it('解析代码围栏 JSON，并生成合法 Exercise', () => {
    const raw = `\`\`\`json\n${payloadOf(choiceItem(), fillItem())}\n\`\`\``;

    const result = parseExercises(raw, singleTargetRequest());

    expect(result).toHaveLength(2);
    const [choice, fill] = result;

    expect(choice.type).toBe('choice');
    expect(choice.source).toBe('llm');
    expect(choice.id).toMatch(/^ex_/);
    expect(choice.wordId).toBe('w_abandon');
    expect(choice.options).toHaveLength(4);
    expect(choice.options).toContain(choice.answer);
    expect(choice.answer).toBe('放弃；抛弃');
    expect(choice.difficulty).toBe(3);

    expect(fill.type).toBe('fill');
    expect(fill.options).toBeUndefined();
    expect(fill.answer).toBe('abandon');
    expect(fill.acceptableAnswers).toEqual(['abandon', 'abandoned', 'give up']);
  });

  it('丢弃所有不合法的题目，只保留合法题', () => {
    const items = [
      choiceItem(),
      choiceItem({ wordId: 'w_unknown' }),
      choiceItem({ type: 'essay' }),
      choiceItem({ prompt: '重复选项题', options: ['放弃', '放弃', '建造'] }),
      choiceItem({ prompt: '只有两个选项', options: ['放弃', '建造'] }),
      choiceItem({ prompt: '答案不在选项', options: ['建造', '灌溉', '测量'], answer: '放弃' }),
      choiceItem({ prompt: '空解析题', explanation: '   ' }),
      choiceItem({ prompt: '' }),
      choiceItem({ prompt: 'x'.repeat(501) }),
      fillItem({ prompt: '没有空格的题干' }),
      fillItem({ prompt: '空答案 ____', answer: '   ' }),
      null,
      'not-an-object',
      42,
    ];

    const result = parseExercises(payloadOf(...items), singleTargetRequest());

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('choice');
    expect(result[0].prompt).toBe('「abandon」最接近的意思是？');
  });

  it('答案按归一化匹配修正为选项原文，并容忍序号前缀', () => {
    const normalizedItem = choiceItem({
      prompt: '归一化修正题',
      options: ['Abandon', 'Build', 'Irrigate', 'Measure'],
      answer: 'abandon',
    });
    const numberedItem = choiceItem({
      prompt: '序号前缀题',
      options: ['放弃；抛弃', '建造', '灌溉'],
      answer: 'A. 放弃；抛弃',
    });

    const result = parseExercises(payloadOf(normalizedItem, numberedItem), {
      targets: [makeTarget()],
      count: 5,
    });

    expect(result).toHaveLength(2);
    expect(result[0].answer).toBe('Abandon');
    expect(result[0].options).toContain('Abandon');
    expect(result[1].answer).toBe('放弃；抛弃');
  });

  it('选择题选项会被打乱，正确答案仍在选项中', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const item = choiceItem({
      options: ['放弃；抛弃', '建造', '灌溉', '测量'],
      answer: '放弃；抛弃',
    });

    const [exercise] = parseExercises(payloadOf(item), { targets: [makeTarget()], count: 1 });

    expect(exercise.options).toEqual(expect.arrayContaining(['放弃；抛弃', '建造', '灌溉', '测量']));
    expect(exercise.options).not.toEqual(['放弃；抛弃', '建造', '灌溉', '测量']);
    expect(exercise.options).toContain(exercise.answer);
  });

  it('fill 支持全角下划线，并合并去重 acceptableAnswers', () => {
    const item = fillItem({
      prompt: '他决定＿＿这个计划。',
      answer: '放弃',
      acceptableAnswers: ['放棄', '放弃', '   ', 'give up'],
    });

    const [exercise] = parseExercises(payloadOf(item), { targets: [makeTarget()], count: 1 });

    expect(exercise.type).toBe('fill');
    expect(exercise.acceptableAnswers).toEqual(['放弃', '放棄', 'give up']);
  });

  it('difficulty clamp 到 1~5，非法值回落为 3', () => {
    const targets = ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => targetFor(id));
    const items = [
      choiceItem({ wordId: 'w1', prompt: '题一', difficulty: 9 }),
      choiceItem({ wordId: 'w2', prompt: '题二', difficulty: -2 }),
      choiceItem({ wordId: 'w3', prompt: '题三', difficulty: '4' }),
      choiceItem({ wordId: 'w4', prompt: '题四', difficulty: 'abc' }),
      choiceItem({ wordId: 'w5', prompt: '题五', difficulty: undefined }),
    ];

    const result = parseExercises(payloadOf(...items), { targets, count: 5 });

    expect(result.map((exercise) => exercise.difficulty)).toEqual([5, 1, 4, 3, 3]);
  });

  it('超长 explanation 截断到 400 字以内', () => {
    const item = choiceItem({ explanation: '中'.repeat(450) });

    const [exercise] = parseExercises(payloadOf(item), { targets: [makeTarget()], count: 1 });

    expect(exercise.explanation.length).toBe(400);
    expect(exercise.explanation.endsWith('…')).toBe(true);
  });

  it('按 wordId + type + 归一化 prompt 去重', () => {
    const items = [
      choiceItem({ prompt: '「abandon」最接近的意思是？' }),
      choiceItem({ prompt: '「abandon」最接近的意思是？', options: ['甲', '乙', '丙'], answer: '甲' }),
    ];

    const result = parseExercises(payloadOf(...items), { targets: [makeTarget()], count: 5 });

    expect(result).toHaveLength(1);
  });

  it('每个词最多保留 2 道题', () => {
    const items = [
      choiceItem({ prompt: '题A' }),
      choiceItem({ prompt: '题B' }),
      choiceItem({ prompt: '题C' }),
    ];

    const result = parseExercises(payloadOf(...items), { targets: [makeTarget()], count: 5 });

    expect(result).toHaveLength(2);
    expect(result.map((exercise) => exercise.prompt)).toEqual(['题A', '题B']);
  });

  it('最多截取 count 道题', () => {
    const targets = ['w1', 'w2', 'w3'].map((id) => targetFor(id));
    const items = [
      choiceItem({ wordId: 'w1', prompt: '题一' }),
      choiceItem({ wordId: 'w2', prompt: '题二' }),
      choiceItem({ wordId: 'w3', prompt: '题三' }),
    ];

    const result = parseExercises(payloadOf(...items), { targets, count: 2 });

    expect(result).toHaveLength(2);
    expect(result.map((exercise) => exercise.wordId)).toEqual(['w1', 'w2']);
  });

  it('根节点直接是数组时也能容错', () => {
    const result = parseExercises(JSON.stringify([choiceItem()]), singleTargetRequest());
    expect(result).toHaveLength(1);
  });

  it('没有 JSON 时抛 parse', () => {
    const error = syncLLMError(() => parseExercises('抱歉，我无法完成。', singleTargetRequest()));
    expect(error.code).toBe('parse');
  });

  it('缺少 exercises 数组时抛 parse', () => {
    const error = syncLLMError(() => parseExercises('{"foo":[]}', singleTargetRequest()));
    expect(error.code).toBe('parse');
  });

  it('exercises 为空数组时抛 empty', () => {
    const error = syncLLMError(() => parseExercises(payloadOf(), singleTargetRequest()));
    expect(error.code).toBe('empty');
  });

  it('题目全部不合法时抛 parse', () => {
    const error = syncLLMError(() =>
      parseExercises(payloadOf(choiceItem({ wordId: 'w_unknown' })), singleTargetRequest()),
    );
    expect(error.code).toBe('parse');
  });
});

/* ------------------------------------------------------------------ */
/* generateExercises：编排                                             */
/* ------------------------------------------------------------------ */

describe('generateExercises', () => {
  it('走完整流程：进度回调 + JSON 模式请求 + 校验后的题目', async () => {
    fetchMock.mockResolvedValue(completionWithExercises([choiceItem(), fillItem()]));
    const progress: string[] = [];

    const result = await generateExercises(
      makeRequest({ count: 2, onProgress: (stage) => progress.push(stage) }),
    );

    expect(progress).toEqual(['正在整理错词…', '正在校验题目…']);
    expect(result).toHaveLength(2);
    expect(result.every((exercise) => exercise.source === 'llm')).toBe(true);

    const call = lastFetchCall();
    expect(call.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.body.response_format).toEqual({ type: 'json_object' });
    const sentMessages = call.body.messages as Array<{ role: string; content: string }>;
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages[1].content).toContain('w_abandon');
  });

  it('最多返回 count 道题', async () => {
    const targets = ['w1', 'w2', 'w3'].map((id) => targetFor(id));
    fetchMock.mockResolvedValue(
      completionWithExercises([
        choiceItem({ wordId: 'w1', prompt: '题一' }),
        choiceItem({ wordId: 'w2', prompt: '题二' }),
        choiceItem({ wordId: 'w3', prompt: '题三' }),
      ]),
    );

    const result = await generateExercises(makeRequest({ targets, count: 2 }));

    expect(result).toHaveLength(2);
  });

  it('模型返回空内容时抛 empty', async () => {
    fetchMock.mockResolvedValue(openAICompletion('   '));

    const error = await asyncLLMError(() => generateExercises(makeRequest()));

    expect(error.code).toBe('empty');
  });

  it('模型返回非法 JSON 时抛 parse', async () => {
    fetchMock.mockResolvedValue(openAICompletion('这不是 JSON'));

    const error = await asyncLLMError(() => generateExercises(makeRequest()));

    expect(error.code).toBe('parse');
  });

  it('接口 401 时向上抛 auth', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid key' } }, 401));

    const error = await asyncLLMError(() => generateExercises(makeRequest()));

    expect(error.code).toBe('auth');
  });

  it('配置缺失时抛 config 且不发请求', async () => {
    const error = await asyncLLMError(() =>
      generateExercises(makeRequest({ settings: makeSettings({ baseUrl: '' }) })),
    );

    expect(error.code).toBe('config');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('没有错词时抛 empty', async () => {
    const error = await asyncLLMError(() => generateExercises(makeRequest({ targets: [] })));
    expect(error.code).toBe('empty');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('传入已取消的 signal 时直接抛 aborted 且不发请求', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await asyncLLMError(() =>
      generateExercises(makeRequest({ signal: controller.signal })),
    );

    expect(error.code).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求过程中取消时抛 aborted', async () => {
    fetchMock.mockImplementation(pendingOnAbort());
    const controller = new AbortController();

    const promise = asyncLLMError(() =>
      generateExercises(makeRequest({ signal: controller.signal })),
    );
    setTimeout(() => controller.abort(), 5);

    const error = await promise;
    expect(error.code).toBe('aborted');
  });
});

/* ------------------------------------------------------------------ */
/* barrel 导出契约                                                     */
/* ------------------------------------------------------------------ */

describe('LLM 层 barrel 导出契约', () => {
  it('保持 4 个函数 / PROMPT_VERSION / LLMError 导出', () => {
    expect(typeof llmEntry.hasUsableLLMConfig).toBe('function');
    expect(typeof llmEntry.testLLMConnection).toBe('function');
    expect(typeof llmEntry.generateExercises).toBe('function');
    expect(typeof llmEntry.PROMPT_VERSION).toBe('string');
    expect(typeof llmEntry.LLMError).toBe('function');
  });
});
