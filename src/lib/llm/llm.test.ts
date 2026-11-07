/**
 * LLM 出题层单元测试（vitest，node 环境，全部 mock 全局 fetch）。
 *
 * Phase A 之后所有 LLM 传输都经同源代理 `POST /api/llm/forward`：
 * mock 的 fetch 只拦截代理路径，断言 `body.url` 才是上游地址、`headers` 是发给上游的头。
 *
 * 覆盖：URL 规范化、OpenAI / Anthropic 请求构造与响应解析、思考参数映射与 400 去参重试、
 * response_format 降级重试、错误码映射、SSE 两条协议流式解析、模型列表、连通性测试不抛错、
 * 提示词内容、以及生成层的 JSON 容错 / 严格校验 / 答案修正 / 选项打乱 / 去重 / 题量限制 / 取消。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMSettings, Word } from '../../types';
import type { ExerciseRequest, ExerciseTarget } from './types';
import { LLMError } from './types';
import {
  ANTHROPIC_VERSION,
  buildAnthropicRequestBody,
  buildOpenAIRequestBody,
  buildRequestHeaders,
  buildThinkingParams,
  chatComplete,
  extractServerErrorDetail,
  fetchModels,
  hasUsableLLMConfig,
  mapHttpStatus,
  normalizeBaseUrl,
  parseAnthropicContent,
  parseAnthropicModels,
  parseCompletionContent,
  parseOllamaModels,
  parseOpenAIContent,
  parseOpenAIModels,
  resolveEndpoint,
  splitAnthropicMessages,
  streamChat,
  testLLMConnection,
} from './providers';
import { buildMessages, PROMPT_VERSION, SYSTEM_PROMPT } from './prompts';
import { extractJsonCandidate, generateExercises, parseExercises } from './generate';
import * as llmEntry from './index';

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

const fetchMock = vi.fn();
const PROXY_PATH = '/api/llm/forward';

interface ProxyPayload {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  stream?: boolean;
}

interface ProxyCall {
  path: string;
  init: RequestInit;
  payload: ProxyPayload;
  /** 已解析的「上游请求体」 */
  upstreamBody: Record<string, unknown>;
}

function proxyCallAt(index: number): ProxyCall {
  const calls = fetchMock.mock.calls;
  const normalizedIndex = index < 0 ? calls.length + index : index;
  const args = calls[normalizedIndex] as [RequestInfo | URL, RequestInit | undefined] | undefined;
  if (!args) throw new Error(`没有第 ${index} 次 fetch 调用`);

  const [input, init] = args;
  const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const requestInit = init ?? {};
  const rawBody = typeof requestInit.body === 'string' ? requestInit.body : '{}';
  const payload = JSON.parse(rawBody) as ProxyPayload;
  let upstreamBody: Record<string, unknown> = {};
  if (typeof payload.body === 'string') {
    try {
      upstreamBody = JSON.parse(payload.body) as Record<string, unknown>;
    } catch {
      upstreamBody = {};
    }
  }
  return { path, init: requestInit, payload, upstreamBody };
}

function lastProxyCall(): ProxyCall {
  return proxyCallAt(-1);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 轻量 headers shim：只提供 get('content-type')。 */
function headerBag(contentType?: string): Headers {
  return {
    get: (name: string) =>
      contentType && name.toLowerCase() === 'content-type' ? contentType : null,
  } as unknown as Headers;
}

function jsonResponse(payload: unknown, status = 200, contentType = 'application/json'): Response {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerBag(contentType),
    text: async () => text,
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

/** 构造一个可流式读取的 SSE 响应；chunks 按给定顺序入队。 */
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

/** 永远不会结束的 SSE 流（用于超时 / 取消测试）。 */
function hangingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {
      // 故意什么都不做，保持挂起
    },
  });
  return {
    ok: true,
    status: 200,
    headers: headerBag('text/event-stream'),
    body,
    text: async () => '',
  } as unknown as Response;
}

function sseEvent(eventName: string | null, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return `${eventName ? `event: ${eventName}\n` : ''}data: ${json}\n\n`;
}

function openAIDelta(token: string): string {
  return sseEvent(null, { choices: [{ index: 0, delta: { content: token } }] });
}

function anthropicDelta(token: string): string {
  return sseEvent('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: token },
  });
}

function anthropicMessageStop(): string {
  return sseEvent('message_stop', { type: 'message_stop' });
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
    vendor: 'custom',
    thinkingMode: 'provider-default',
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
    vendor: 'anthropic',
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
/* URL 规范化                                                          */
/* ------------------------------------------------------------------ */

describe('normalizeBaseUrl', () => {
  it('去掉首尾空白与末尾斜杠', () => {
    expect(normalizeBaseUrl('  https://api.deepseek.com/v1/  ')).toBe('https://api.deepseek.com/v1');
    expect(normalizeBaseUrl('http://localhost:11434///')).toBe('http://localhost:11434');
  });
});

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

  it('为 Anthropic 拼接 /v1/messages（官方主机 / 版本层 / 厂商前缀）', () => {
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' })).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' })).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages' })).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    // 兼容网关通常只给厂商前缀，真实端点是 {前缀}/v1/messages。
    expect(
      resolveEndpoint({
        provider: 'anthropic',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
      }),
    ).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages');
    expect(
      resolveEndpoint({
        provider: 'anthropic',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/',
      }),
    ).toBe('https://ark.cn-beijing.volces.com/api/coding/v1/messages');
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe(
      'https://api.deepseek.com/anthropic/v1/messages',
    );
    // 已填到版本层（含非 v1）时只补 /messages，不再重复 /v1。
    expect(resolveEndpoint({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1beta' })).toBe(
      'https://api.anthropic.com/v1beta/messages',
    );
  });

  it('baseUrl 为空时抛 config', () => {
    const error = syncLLMError(() => resolveEndpoint({ provider: 'openai', baseUrl: '   ' }));
    expect(error.code).toBe('config');
  });
});

/* ------------------------------------------------------------------ */
/* 请求头 / 请求体（纯函数）                                           */
/* ------------------------------------------------------------------ */

describe('buildRequestHeaders', () => {
  it('OpenAI 兼容：Content-Type + Bearer', () => {
    const headers = buildRequestHeaders(makeSettings());
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer sk-test-key');
  });

  it('apiKey 为空时不发 Authorization（兼容本地 Ollama）', () => {
    const headers = buildRequestHeaders(makeSettings({ apiKey: '   ' }));
    expect(headers.Authorization).toBeUndefined();
  });

  it('Anthropic：x-api-key + anthropic-version，且不再有浏览器直连头', () => {
    const headers = buildRequestHeaders(anthropicSettings());
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it('Anthropic 兼容网关：额外携带 Authorization Bearer（火山方舟等只认 Bearer）', () => {
    for (const baseUrl of [
      'https://ark.cn-beijing.volces.com/api/coding',
      'https://api.deepseek.com/anthropic',
      'https://my-gateway.test/anthropic',
    ]) {
      const headers = buildRequestHeaders(anthropicSettings({ baseUrl }));
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers.Authorization).toBe('Bearer sk-ant-test');
      expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    }
  });

  it('Anthropic 网关未填 Key 时两个鉴权头都不发', () => {
    const headers = buildRequestHeaders(
      anthropicSettings({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', apiKey: '' }),
    );
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
  });

  it('不带 Origin / Cookie（代理会剥离，客户端也不发）', () => {
    expect(buildRequestHeaders(makeSettings()).Origin).toBeUndefined();
    expect(buildRequestHeaders(makeSettings()).Cookie).toBeUndefined();
  });
});

describe('buildThinkingParams：按 vendor 映射', () => {
  const cases: Array<[LLMSettings['vendor'], Partial<LLMSettings>, Record<string, unknown>]> = [
    ['anthropic', {}, { thinking: { type: 'disabled' } }],
    ['deepseek', {}, { thinking: { type: 'disabled' } }],
    ['glm', {}, { thinking: { type: 'disabled' } }],
    ['volcengine', {}, { thinking: { type: 'disabled' } }],
    ['kimi', { model: 'moonshot-v1-8k' }, { thinking: { type: 'disabled' } }],
    ['kimi', { model: 'kimi-k3' }, { reasoning_effort: 'low' }],
    ['qwen', {}, { enable_thinking: false }],
    ['siliconflow', {}, { enable_thinking: false }],
    ['openai', {}, { reasoning_effort: 'minimal' }],
    ['ollama', {}, { reasoning_effort: 'none' }],
    ['minimax', {}, {}],
    ['custom', {}, {}],
    [undefined, {}, {}],
  ];

  for (const [vendor, overrides, expected] of cases) {
    it(`vendor=${String(vendor)}${overrides.model ? ` model=${overrides.model}` : ''} → ${JSON.stringify(expected)}`, () => {
      expect(buildThinkingParams(makeSettings({ vendor, ...overrides }))).toEqual(expected);
    });
  }
});

describe('buildOpenAIRequestBody', () => {
  it('包含 model / messages / temperature / max_tokens', () => {
    const body = buildOpenAIRequestBody(makeSettings(), [{ role: 'user', content: 'hi' }]);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(1024);
    expect(body.response_format).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it('jsonMode 才带 response_format', () => {
    expect(buildOpenAIRequestBody(makeSettings(), [], { jsonMode: true }).response_format).toEqual({
      type: 'json_object',
    });
  });

  it('thinkingMode=off / noThink 时注入关闭思考参数；provider-default 不注入', () => {
    const offBody = buildOpenAIRequestBody(makeSettings({ vendor: 'deepseek', thinkingMode: 'off' }), []);
    expect(offBody.thinking).toEqual({ type: 'disabled' });

    const noThinkBody = buildOpenAIRequestBody(makeSettings({ vendor: 'qwen' }), [], { noThink: true });
    expect(noThinkBody.enable_thinking).toBe(false);

    const defaultBody = buildOpenAIRequestBody(makeSettings({ vendor: 'deepseek' }), []);
    expect(defaultBody.thinking).toBeUndefined();
  });

  it('openai vendor 用 reasoning_effort；maxTokens 覆盖与 temperature clamp', () => {
    const body = buildOpenAIRequestBody(makeSettings({ vendor: 'openai', thinkingMode: 'off' }), [], {
      maxTokens: 2,
      temperature: 9,
    });
    expect(body.reasoning_effort).toBe('minimal');
    expect(body.max_tokens).toBe(2);
    expect(body.temperature).toBe(2);
  });
});

describe('splitAnthropicMessages / buildAnthropicRequestBody', () => {
  it('拆分 system 消息为顶层 system 字段', () => {
    expect(
      splitAnthropicMessages([
        { role: 'system', content: '指令一' },
        { role: 'user', content: '问题' },
        { role: 'system', content: '指令二' },
      ]),
    ).toEqual({
      system: '指令一\n\n指令二',
      messages: [{ role: 'user', content: '问题' }],
    });
  });

  it('构造 Anthropic 请求体：system + messages + max_tokens，无 response_format', () => {
    const body = buildAnthropicRequestBody(
      anthropicSettings(),
      [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '用户问题' },
      ],
      { jsonMode: true, maxTokens: 8, temperature: 0.9 },
    );
    expect(body.system).toBe('系统指令');
    expect(body.messages).toEqual([{ role: 'user', content: '用户问题' }]);
    expect(body.max_tokens).toBe(8);
    expect(body.temperature).toBe(0.9);
    expect(body.response_format).toBeUndefined();
    expect(body.thinking).toBeUndefined();

    // Anthropic temperature 上限 1
    expect(
      buildAnthropicRequestBody(anthropicSettings(), [{ role: 'user', content: 'hi' }], {
        temperature: 2,
      }).temperature,
    ).toBe(1);
  });

  it('thinkingMode=off 时 Anthropic 注入 thinking.disabled；没有 user 消息时抛 config', () => {
    const body = buildAnthropicRequestBody(
      anthropicSettings({ thinkingMode: 'off' }),
      [{ role: 'user', content: 'hi' }],
    );
    expect(body.thinking).toEqual({ type: 'disabled' });

    const error = syncLLMError(() =>
      buildAnthropicRequestBody(anthropicSettings(), [{ role: 'system', content: '只有 system' }]),
    );
    expect(error.code).toBe('config');
  });
});

/* ------------------------------------------------------------------ */
/* chatComplete：经同源代理，OpenAI 兼容                               */
/* ------------------------------------------------------------------ */

describe('chatComplete：OpenAI 兼容（经代理）', () => {
  it('请求只发往本地代理，上游地址在 body.url，并合法解析 content', async () => {
    fetchMock.mockResolvedValue(openAICompletion('hello'));

    const text = await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { jsonMode: true });
    expect(text).toBe('hello');

    const call = lastProxyCall();
    expect(call.path).toBe(PROXY_PATH);
    expect(call.init.method).toBe('POST');
    expect(call.payload.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.payload.method).toBe('POST');
    expect(call.payload.stream).toBeUndefined();
    expect(call.payload.headers['Content-Type']).toBe('application/json');
    expect(call.payload.headers.Authorization).toBe('Bearer sk-test-key');
    expect(call.payload.headers.Origin).toBeUndefined();
    expect(call.payload.headers.Cookie).toBeUndefined();
    expect(call.init.headers).not.toHaveProperty('Origin');

    expect(call.upstreamBody.model).toBe('deepseek-chat');
    expect(call.upstreamBody.max_tokens).toBe(1024);
    expect(call.upstreamBody.temperature).toBe(0.7);
    expect(call.upstreamBody.response_format).toEqual({ type: 'json_object' });
    expect(call.upstreamBody.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('不直连厂商域名（fetch 参数永远只有本地代理路径）', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]);
    const call = lastProxyCall();
    expect(call.path).not.toContain('api.deepseek.com');
    expect(call.path.startsWith('/api/')).toBe(true);
    expect(call.payload.url).toContain('api.deepseek.com');
  });

  it('未开启 jsonMode 时不发送 response_format', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]);
    expect(lastProxyCall().upstreamBody.response_format).toBeUndefined();
  });

  it('apiKey 为空时上游请求不带 Authorization 头', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings({ apiKey: '   ' }), [{ role: 'user', content: 'hi' }]);
    expect(lastProxyCall().payload.headers.Authorization).toBeUndefined();
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
/* chatComplete：思考参数注入与 400 去参重试                           */
/* ------------------------------------------------------------------ */

describe('chatComplete：思考参数', () => {
  it('thinkingMode=off 时按 vendor 注入参数', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(
      makeSettings({ vendor: 'deepseek', thinkingMode: 'off' }),
      [{ role: 'user', content: 'hi' }],
    );
    expect(lastProxyCall().upstreamBody.thinking).toEqual({ type: 'disabled' });
  });

  it('opts.noThink 也能强制注入（qwen → enable_thinking=false）', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings({ vendor: 'qwen' }), [{ role: 'user', content: 'hi' }], {
      noThink: true,
    });
    expect(lastProxyCall().upstreamBody.enable_thinking).toBe(false);
  });

  it('thinkingMode=provider-default 且未 noThink 时不注入', async () => {
    fetchMock.mockResolvedValue(openAICompletion('ok'));
    await chatComplete(makeSettings({ vendor: 'deepseek' }), [{ role: 'user', content: 'hi' }]);
    expect(lastProxyCall().upstreamBody.thinking).toBeUndefined();
  });

  it('上游 400 点名思考参数时去掉参数重试一次', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Unsupported parameter: thinking' } }, 400),
      )
      .mockResolvedValueOnce(openAICompletion('ok'));

    const text = await chatComplete(
      makeSettings({ vendor: 'deepseek', thinkingMode: 'off' }),
      [{ role: 'user', content: 'hi' }],
    );
    expect(text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyCallAt(0).upstreamBody.thinking).toEqual({ type: 'disabled' });
    expect(proxyCallAt(1).upstreamBody.thinking).toBeUndefined();
  });

  it('上游 400 未点名思考参数时不重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request: model' } }, 400));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings({ vendor: 'deepseek', thinkingMode: 'off' }), [
        { role: 'user', content: 'hi' },
      ]),
    );
    expect(error.code).toBe('http');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('去参重试后仍 400 时抛出最终错误', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Unknown parameter enable_thinking' } }, 400),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'still bad' } }, 400));

    const error = await asyncLLMError(() =>
      chatComplete(makeSettings({ vendor: 'qwen', thinkingMode: 'off' }), [
        { role: 'user', content: 'hi' },
      ]),
    );
    expect(error.code).toBe('http');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* chatComplete：jsonMode 400/422 去 response_format 重试               */
/* ------------------------------------------------------------------ */

describe('chatComplete：response_format 降级重试', () => {
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
    expect(proxyCallAt(0).upstreamBody.response_format).toEqual({ type: 'json_object' });
    expect(proxyCallAt(1).upstreamBody.response_format).toBeUndefined();
  });

  it('422 同样去掉 response_format 重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'unsupported field' } }, 422))
      .mockResolvedValueOnce(openAICompletion('{}'));

    const text = await chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], {
      jsonMode: true,
    });
    expect(text).toBe('{}');
    expect(proxyCallAt(1).upstreamBody.response_format).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* chatComplete：错误映射                                               */
/* ------------------------------------------------------------------ */

describe('chatComplete：错误映射', () => {
  it('上游 401 → auth，且不会做 response_format 重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { jsonMode: true }),
    );
    expect(error.code).toBe('auth');
    expect(error.message).toContain('API Key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('上游 429 → rate-limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'slow down' } }, 429));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('rate-limit');
  });

  it('上游 5xx → server', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'boom' } }, 503));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('server');
  });

  it('上游其他非 2xx → http（带状态码与服务端摘要）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request detail' } }, 422));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('http');
    expect(error.message).toContain('HTTP 422');
    expect(error.message).toContain('bad request detail');
  });

  it('代理 bad-request JSON → config，且不触发参数重试', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'bad-request', message: 'url must be http(s)' } }, 400),
    );
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }], { jsonMode: true }),
    );
    expect(error.code).toBe('config');
    expect(error.message).toContain('本地代理');
    expect(error.detail).toContain('url must be http(s)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('代理 network JSON → network（502）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'network', message: 'ECONNREFUSED' } }, 502),
    );
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('network');
    expect(error.detail).toContain('ECONNREFUSED');
  });

  it('代理 timeout JSON → timeout（504）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'timeout', message: 'upstream timed out' } }, 504),
    );
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('timeout');
  });

  it('直接 fetch TypeError → network', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await asyncLLMError(() =>
      chatComplete(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('network');
    expect(error.message).toContain('本地代理');
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

describe('chatComplete：Anthropic（经代理）', () => {
  it('拆分 system 消息并发送 Anthropic 必需请求头（无浏览器直连头）', async () => {
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

    const call = lastProxyCall();
    expect(call.path).toBe(PROXY_PATH);
    expect(call.payload.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.payload.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.payload.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(call.payload.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    expect(call.upstreamBody.system).toBe('系统指令');
    expect(call.upstreamBody.messages).toEqual([{ role: 'user', content: '用户问题' }]);
    expect(call.upstreamBody.max_tokens).toBe(1024);
    // Anthropic 不支持 OpenAI 的 response_format，不应发送
    expect(call.upstreamBody.response_format).toBeUndefined();
  });

  it('Anthropic 兼容网关（火山方舟）：请求 /api/coding/v1/messages 并携带 Bearer', async () => {
    fetchMock.mockResolvedValue(anthropicCompletion('OK'));

    const text = await chatComplete(
      anthropicSettings({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }),
      [{ role: 'user', content: 'hi' }],
    );
    expect(text).toBe('OK');

    const call = lastProxyCall();
    expect(call.payload.url).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/messages',
    );
    expect(call.payload.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.payload.headers.Authorization).toBe('Bearer sk-ant-test');
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

/* ------------------------------------------------------------------ */
/* 响应解析纯函数                                                      */
/* ------------------------------------------------------------------ */

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

  it('parseCompletionContent 按协议分派', () => {
    expect(parseCompletionContent('openai', { choices: [{ message: { content: 'x' } }] })).toBe('x');
    expect(parseCompletionContent('anthropic', { content: [{ type: 'text', text: 'y' }] })).toBe('y');
  });
});

describe('extractServerErrorDetail / mapHttpStatus', () => {
  it('从 JSON error / detail / 纯文本里提取摘要并截断', () => {
    expect(extractServerErrorDetail('{"error":{"message":"invalid key"}}')).toBe('invalid key');
    expect(extractServerErrorDetail('{"detail":{"message":"bad"}}')).toBe('bad');
    expect(extractServerErrorDetail('plain failure text')).toBe('plain failure text');
    expect(extractServerErrorDetail('   ')).toBe('');
    expect(extractServerErrorDetail('x'.repeat(300))).toHaveLength(241); // 240 + …
  });

  it('状态码映射为对应 code', () => {
    expect(mapHttpStatus(401, '').code).toBe('auth');
    expect(mapHttpStatus(403, '').code).toBe('auth');
    expect(mapHttpStatus(429, '').code).toBe('rate-limit');
    expect(mapHttpStatus(500, '').code).toBe('server');
    const other = mapHttpStatus(418, '{"error":{"message":"teapot"}}');
    expect(other.code).toBe('http');
    expect(other.message).toContain('HTTP 418');
    expect(other.message).toContain('teapot');
  });
});

/* ------------------------------------------------------------------ */
/* streamChat：OpenAI SSE                                              */
/* ------------------------------------------------------------------ */

describe('streamChat：OpenAI SSE', () => {
  it('逐段回调 onToken，按顺序拼接；[DONE] 结束；请求带 stream:true', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([openAIDelta('你'), openAIDelta('好'), sseEvent(null, '[DONE]')]),
    );

    const tokens: string[] = [];
    const text = await streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });

    expect(tokens).toEqual(['你', '好']);
    expect(text).toBe('你好');

    const call = lastProxyCall();
    expect(call.path).toBe(PROXY_PATH);
    expect(call.payload.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.payload.stream).toBe(true);
    expect(call.upstreamBody.model).toBe('deepseek-chat');
    // 上游请求体必须带 stream:true，否则上游只回整包 JSON，就不会有逐段回调。
    expect(call.upstreamBody.stream).toBe(true);
    expect(call.init.headers).toMatchObject({ Accept: 'text/event-stream' });
  });

  it('chunk 边界切断行也能正确解析（缓冲）', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"cont',
        'ent":"你"}}]}\n\n',
        openAIDelta('好'),
        'data: [DONE]\n\n',
      ]),
    );

    const tokens: string[] = [];
    const text = await streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['你', '好']);
    expect(text).toBe('你好');
  });

  it('忽略 reasoning_content，只取正文', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sseEvent(null, { choices: [{ delta: { reasoning_content: '思考中…' } }] }),
        openAIDelta('答'),
        sseEvent(null, '[DONE]'),
      ]),
    );

    const tokens: string[] = [];
    await streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['答']);
  });

  it('流自然结束（没有 [DONE]）时也返回已拼接内容', async () => {
    fetchMock.mockResolvedValue(sseResponse([openAIDelta('a'), openAIDelta('b')]));
    await expect(
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    ).resolves.toBe('ab');
  });

  it('CRLF 换行也能解析', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(`${openAIDelta('好').replace(/\n/g, '\r\n')}data: [DONE]\r\n\r\n`),
    );
    const tokens: string[] = [];
    const text = await streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['好']);
    expect(text).toBe('好');
  });

  it('没有事件名只靠 data 行的 OpenAI 事件也能解析', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([`data:${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`]),
    );
    await expect(
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    ).resolves.toBe('x');
  });

  it('200 但上游返回普通 JSON 时降级为一次性文本', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: '整段内容' } }] }),
    );
    const tokens: string[] = [];
    const text = await streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['整段内容']);
    expect(text).toBe('整段内容');
  });
});

/* ------------------------------------------------------------------ */
/* streamChat：Anthropic SSE                                           */
/* ------------------------------------------------------------------ */

describe('streamChat：Anthropic SSE', () => {
  it('解析 content_block_delta，message_stop 结束，逐段 onToken', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        anthropicDelta('你'),
        anthropicDelta('好'),
        anthropicMessageStop(),
      ]),
    );

    const tokens: string[] = [];
    const text = await streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });

    expect(tokens).toEqual(['你', '好']);
    expect(text).toBe('你好');
    expect(lastProxyCall().payload.stream).toBe(true);
    // 上游请求体必须带 stream:true，否则 Anthropic 兼容网关只回整包 JSON。
    expect(lastProxyCall().upstreamBody.stream).toBe(true);
  });

  it('上游请求体带 stream:true，且不污染非流式请求', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([anthropicDelta('答'), anthropicMessageStop()]),
    );
    await streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }]);
    expect(lastProxyCall().upstreamBody.stream).toBe(true);

    fetchMock.mockResolvedValue(anthropicCompletion('OK'));
    await chatComplete(anthropicSettings(), [{ role: 'user', content: 'hi' }]);
    expect(lastProxyCall().upstreamBody.stream).toBeUndefined();
  });

  it('忽略 thinking_delta，只取 text delta', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: '思考' },
        }),
        anthropicDelta('答'),
        anthropicMessageStop(),
      ]),
    );
    const tokens: string[] = [];
    await streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['答']);
  });

  it('message_stop 之后的数据不再处理', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        anthropicDelta('你'),
        anthropicMessageStop(),
        anthropicDelta('坏'),
      ]),
    );
    const tokens: string[] = [];
    const text = await streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }], {
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['你']);
    expect(text).toBe('你');
  });

  it('事件名缺失但 payload 带 type 时也能解析', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sseEvent(null, {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'x' },
        }),
        sseEvent(null, { type: 'message_stop' }),
      ]),
    );
    await expect(
      streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }]),
    ).resolves.toBe('x');
  });

  it('error 事件（overloaded_error）→ LLMError(server)', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sseEvent('error', {
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ]),
    );
    const error = await asyncLLMError(() =>
      streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('server');
    expect(error.detail).toContain('Overloaded');
    expect(error.message).toContain('服务端');
  });

  it('error 事件（rate_limit_error）→ LLMError(rate-limit)', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        sseEvent('error', {
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }),
      ]),
    );
    const error = await asyncLLMError(() =>
      streamChat(anthropicSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('rate-limit');
  });
});

/* ------------------------------------------------------------------ */
/* streamChat：错误 / 中断 / 思考参数                                  */
/* ------------------------------------------------------------------ */

describe('streamChat：错误与中断', () => {
  it('上游 401 → auth，不重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid key' } }, 401));
    const error = await asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('auth');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('代理 JSON 错误（502 network）→ network', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'network', message: 'upstream unreachable' } }, 502),
    );
    const error = await asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('network');
    expect(error.detail).toContain('upstream unreachable');
  });

  it('代理 JSON 错误（504 timeout）→ timeout', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'timeout', message: 'upstream timed out' } }, 504),
    );
    const error = await asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    );
    expect(error.code).toBe('timeout');
  });

  it('400 点名思考参数时去掉参数重试一次', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'Unsupported parameter: enable_thinking' } }, 400),
      )
      .mockResolvedValueOnce(sseResponse([openAIDelta('好'), sseEvent(null, '[DONE]')]));

    const text = await streamChat(
      makeSettings({ vendor: 'qwen', thinkingMode: 'off' }),
      [{ role: 'user', content: 'hi' }],
    );
    expect(text).toBe('好');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyCallAt(0).upstreamBody.enable_thinking).toBe(false);
    expect(proxyCallAt(1).upstreamBody.enable_thinking).toBeUndefined();
  });

  it('上游 400 点名 stream 时去掉流式标记重试一次，并按一次性 JSON 兼容', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'stream: Extra inputs are not permitted' } }, 400),
      )
      .mockResolvedValueOnce(openAICompletion('好'));

    const tokens: string[] = [];
    const text = await streamChat(
      makeSettings(),
      [{ role: 'user', content: 'hi' }],
      { onToken: (token) => tokens.push(token) },
    );

    expect(text).toBe('好');
    expect(tokens).toEqual(['好']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyCallAt(0).upstreamBody.stream).toBe(true);
    expect(proxyCallAt(1).upstreamBody.stream).toBeUndefined();
  });

  it('noThink 选项在流式请求里同样注入思考关闭参数', async () => {
    fetchMock.mockResolvedValue(sseResponse([openAIDelta('ok'), sseEvent(null, '[DONE]')]));
    await streamChat(makeSettings({ vendor: 'ollama' }), [{ role: 'user', content: 'hi' }], {
      noThink: true,
    });
    expect(lastProxyCall().upstreamBody.reasoning_effort).toBe('none');
  });

  it('请求超时 → timeout', async () => {
    fetchMock.mockResolvedValue(hangingSseResponse());
    const error = await asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], { timeoutMs: 10 }),
    );
    expect(error.code).toBe('timeout');
  });

  it('调用方已取消 → aborted，且不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], { signal: controller.signal }),
    );
    expect(error.code).toBe('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('流式读取过程中取消 → aborted', async () => {
    fetchMock.mockResolvedValue(hangingSseResponse());
    const controller = new AbortController();
    const promise = asyncLLMError(() =>
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }], {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    );
    setTimeout(() => controller.abort(), 5);
    const error = await promise;
    expect(error.code).toBe('aborted');
  });

  it('Malformed SSE data 行被忽略，不崩', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: 这不是 JSON\n\n', openAIDelta('ok'), sseEvent(null, '[DONE]')]),
    );
    await expect(
      streamChat(makeSettings(), [{ role: 'user', content: 'hi' }]),
    ).resolves.toBe('ok');
  });
});

/* ------------------------------------------------------------------ */
/* fetchModels                                                         */
/* ------------------------------------------------------------------ */

describe('fetchModels', () => {
  it('OpenAI 兼容：GET {base}/models，解析 data[].id 并去重', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }],
      }),
    );

    const result = await fetchModels(makeSettings());
    expect(result.models.map((model) => model.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(result.warning).toBeUndefined();

    const call = lastProxyCall();
    expect(call.path).toBe(PROXY_PATH);
    expect(call.payload.url).toBe('https://api.deepseek.com/v1/models');
    expect(call.payload.method).toBe('GET');
    expect(call.payload.headers.Authorization).toBe('Bearer sk-test-key');
    expect(call.payload.body).toBeUndefined();
  });

  it('只填主机时补 /v1/models', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-4o-mini' }] }));
    await fetchModels(makeSettings({ baseUrl: 'https://api.openai.com', apiKey: '' }));
    expect(lastProxyCall().payload.url).toBe('https://api.openai.com/v1/models');
  });

  it('Anthropic：解析 id / display_name / lifecycle / max_tokens', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          {
            id: 'claude-sonnet-4-5',
            display_name: 'Claude Sonnet 4.5',
            lifecycle: 'active',
            max_tokens: 8192,
          },
          {
            id: 'claude-3-5-sonnet',
            display_name: 'Claude 3.5 Sonnet',
            lifecycle: 'deprecated',
            max_tokens: 4096,
          },
        ],
      }),
    );

    const result = await fetchModels(anthropicSettings());
    expect(result.models).toEqual([
      {
        id: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        lifecycle: 'active',
        maxTokens: 8192,
      },
      {
        id: 'claude-3-5-sonnet',
        displayName: 'Claude 3.5 Sonnet',
        lifecycle: 'deprecated',
        maxTokens: 4096,
      },
    ]);

    const call = lastProxyCall();
    expect(call.payload.url).toBe('https://api.anthropic.com/v1/models');
    expect(call.payload.method).toBe('GET');
    expect(call.payload.headers['x-api-key']).toBe('sk-ant-test');
    expect(call.payload.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(call.payload.headers.Authorization).toBeUndefined();
  });

  it('Anthropic 兼容网关（火山方舟）：GET {前缀}/v1/models 并携带 Bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'deepseek-v4.1-flash' }] }));

    const result = await fetchModels(
      anthropicSettings({ baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }),
    );
    expect(result.models.map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);

    const call = lastProxyCall();
    expect(call.payload.url).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/models',
    );
    expect(call.payload.method).toBe('GET');
    expect(call.payload.headers.Authorization).toBe('Bearer sk-ant-test');
    expect(call.payload.headers['x-api-key']).toBe('sk-ant-test');
  });

  it('Anthropic 缺 API Key 时返回中文 warning，不发请求', async () => {
    const result = await fetchModels(anthropicSettings({ apiKey: '' }));
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('API Key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Ollama：/models 失败时回落 origin/api/tags 并解析 models[].name', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'not found' } }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: 'qwen2.5:7b' }, { name: 'llama3.2:3b' }] }),
      );

    const result = await fetchModels(
      makeSettings({ vendor: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
    );

    expect(result.models.map((model) => model.id)).toEqual(['qwen2.5:7b', 'llama3.2:3b']);
    expect(result.warning).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(proxyCallAt(0).payload.url).toBe('http://localhost:11434/v1/models');
    expect(proxyCallAt(1).payload.url).toBe('http://localhost:11434/api/tags');
    expect(proxyCallAt(1).payload.method).toBe('GET');
  });

  it('Ollama：/models 成功时不再回落 api/tags', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'qwen2.5:7b' }] }));
    const result = await fetchModels(
      makeSettings({ vendor: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
    );
    expect(result.models.map((model) => model.id)).toEqual(['qwen2.5:7b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Ollama：两次都失败时返回空列表 + 中文 warning（永不抛错）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'not found' } }, 404))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await fetchModels(
      makeSettings({ vendor: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '' }),
    );
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('获取模型列表失败');
    expect(result.warning).toContain('回落');
  });

  it('网络错误时返回空列表 + 中文 warning，不抛错', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const result = await fetchModels(makeSettings());
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('获取模型列表失败');
    expect(result.warning).toContain('本地代理');
  });

  it('401 时返回空列表 + 鉴权 warning，不抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid key' } }, 401));
    const result = await fetchModels(makeSettings());
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('API Key');
    expect(result.warning).toContain('获取模型列表失败');
  });

  it('返回空列表（200 但 data 为空）时给出 warning', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [] }));
    const result = await fetchModels(makeSettings());
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('为空');
  });

  it('Base URL 为空时直接返回 warning，不发请求', async () => {
    const result = await fetchModels(makeSettings({ baseUrl: '   ' }));
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('Base URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('响应不是合法 JSON 时返回 warning，不抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse('not json'));
    const result = await fetchModels(makeSettings());
    expect(result.models).toEqual([]);
    expect(result.warning).toContain('获取模型列表失败');
  });
});

describe('模型列表解析纯函数', () => {
  it('parseOpenAIModels 忽略无 id 项', () => {
    expect(parseOpenAIModels({ data: [{ id: 'a' }, {}, { id: '' }, { id: 'b' }] })).toEqual([
      { id: 'a' },
      { id: 'b' },
    ]);
    expect(parseOpenAIModels({})).toEqual([]);
  });

  it('parseAnthropicModels 做字段兜底（status / max_output_tokens）', () => {
    expect(
      parseAnthropicModels({
        data: [{ id: 'x', status: 'retired', max_output_tokens: 1000 }],
      }),
    ).toEqual([{ id: 'x', lifecycle: 'retired', maxTokens: 1000 }]);
  });

  it('parseOllamaModels 兼容 models[].name', () => {
    expect(parseOllamaModels({ models: [{ name: 'a' }, { name: 'a' }, {}] })).toEqual([{ id: 'a' }]);
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
  it('成功时返回 ok、延迟与模型名，并发送 max_tokens=1 的极短请求', async () => {
    fetchMock.mockResolvedValue(openAICompletion('OK'));

    const result = await testLLMConnection(makeSettings());

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.message).toContain('连接成功');
    expect(result.model).toBe('deepseek-chat');
    expect(lastProxyCall().upstreamBody.max_tokens).toBe(1);
  });

  it('响应成功但内容为空也算成功', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' } }] }));
    const result = await testLLMConnection(makeSettings());
    expect(result.ok).toBe(true);
    expect(result.message).toContain('连接成功');
  });

  it('强制 noThink：thinkingMode 默认时也注入关闭思考参数', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'OK' } }] }));
    const result = await testLLMConnection(makeSettings({ vendor: 'deepseek' }));
    expect(result.ok).toBe(true);
    expect(lastProxyCall().upstreamBody.thinking).toEqual({ type: 'disabled' });
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

  it('代理网络错误时返回可操作的中文提示且不抛错', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'network', message: 'ECONNREFUSED' } }, 502),
    );
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
  it('走完整流程：进度回调 + JSON 模式请求（经代理）+ 校验后的题目', async () => {
    fetchMock.mockResolvedValue(completionWithExercises([choiceItem(), fillItem()]));
    const progress: string[] = [];

    const result = await generateExercises(
      makeRequest({ count: 2, onProgress: (stage) => progress.push(stage) }),
    );

    expect(progress).toEqual(['正在整理错词…', '正在校验题目…']);
    expect(result).toHaveLength(2);
    expect(result.every((exercise) => exercise.source === 'llm')).toBe(true);

    const call = lastProxyCall();
    expect(call.path).toBe(PROXY_PATH);
    expect(call.payload.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(call.upstreamBody.response_format).toEqual({ type: 'json_object' });
    const sentMessages = call.upstreamBody.messages as Array<{ role: string; content: string }>;
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
  it('保持 5 个函数 / PROMPT_VERSION / LLMError 导出', () => {
    expect(typeof llmEntry.hasUsableLLMConfig).toBe('function');
    expect(typeof llmEntry.testLLMConnection).toBe('function');
    expect(typeof llmEntry.chatComplete).toBe('function');
    expect(typeof llmEntry.streamChat).toBe('function');
    expect(typeof llmEntry.fetchModels).toBe('function');
    expect(typeof llmEntry.generateExercises).toBe('function');
    expect(typeof llmEntry.PROMPT_VERSION).toBe('string');
    expect(typeof llmEntry.LLMError).toBe('function');
  });
});
