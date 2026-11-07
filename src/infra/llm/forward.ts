/**
 * LLM 传输层：构造 OpenAI 兼容 / Anthropic 请求，统一经同源本地代理转发，
 * 并把各种失败映射为带 code 的 LLMError。
 *
 * 设计原则：
 * - 纯函数（URL 规范化、请求体构造、响应解析、HTTP 状态映射、思考参数映射）与网络调用分离，便于单测；
 * - 所有真实请求都发往 `POST /api/llm/forward`（dev 由 Vite middleware、prod 由 node server 提供），
 *   浏览器不再直连厂商域名，也就不需要 CORS 与 anthropic 浏览器直连头；
 * - 所有失败都抛带 code 的 LLMError，UI 据此给出可操作提示或回退本地题库；
 * - `fetchModels` / `testLLMConnection` 永不抛错，失败返回中文 warning / 可操作提示。
 */

import type { LLMSettings, ProviderKind } from '@/domain/types';
import {
  resolveEndpoint,
  resolveModelsEndpoint,
  resolveOllamaTagsEndpoint,
  isOfficialAnthropicHost,
} from './endpoints';
import {
  applyThinkingParams,
  hasThinkingParams,
  mentionsStreamParam,
  mentionsThinkingParam,
  removeThinkingParams,
} from './vendors';
import type {
  ChatCompleteExtOptions,
  ChatMessage,
  FetchModelsResult,
  LLMConnectionResult,
  ModelInfo,
  StreamChatOptions,
} from './types';
import { LLMError } from './types';

export { normalizeBaseUrl, resolveEndpoint } from './endpoints';
export { buildThinkingParams, THINKING_PARAM_KEYS } from './vendors';

/** 普通请求默认超时：90 秒。 */
export const DEFAULT_TIMEOUT_MS = 90_000;
/** 连通性测试 / 模型列表用较短超时，避免设置页卡太久。 */
export const CONNECTION_TEST_TIMEOUT_MS = 20_000;
/** Anthropic API 版本头。 */
export const ANTHROPIC_VERSION = '2023-06-01';
/** 本地代理转发入口（同源，浏览器只认这个路径）。 */
export const LLM_FORWARD_PATH = '/api/llm/forward';

/* ------------------------------------------------------------------ */
/* 设置校验                                                            */
/* ------------------------------------------------------------------ */

/** 判断设置是否足够发起一次真实请求（apiKey 允许为空，以支持本地 Ollama）。 */
export function hasUsableLLMConfig(settings: LLMSettings): boolean {
  return Boolean(settings.baseUrl.trim() && settings.model.trim());
}

function assertUsableSettings(settings: LLMSettings): void {
  if (!settings.baseUrl.trim()) {
    throw new LLMError('config', '尚未填写 Base URL，请到设置页补全（例如 https://api.deepseek.com/v1）。');
  }
  if (!settings.model.trim()) {
    throw new LLMError('config', '尚未填写模型名，请到设置页补全（例如 deepseek-chat）。');
  }
  if (settings.provider === 'anthropic' && !settings.apiKey.trim()) {
    throw new LLMError('config', 'Anthropic 接口需要填写 API Key，请到设置页补全。');
  }
}

/* ------------------------------------------------------------------ */
/* 请求头 / 请求体（纯函数，可单测）                                   */
/* ------------------------------------------------------------------ */

/**
 * 构造发给上游的请求头。
 * 注意：不再发 `anthropic-dangerous-direct-browser-access`——请求由本地代理从服务端发出，
 * 不需要浏览器直连豁免；代理只允许白名单头，因此这里也不要带 Origin / Cookie 之类。
 *
 * Anthropic 协议同时携带 `x-api-key` 与 `Authorization: Bearer`：
 * 官方接口只看 `x-api-key`，而多数 Anthropic 兼容网关（火山方舟 Ark、DeepSeek 等）
 * 使用 Bearer 鉴权（部分网关的模型列表只认 Bearer）。官方主机为避免未知头则只发 x-api-key。
 */
export function buildRequestHeaders(settings: LLMSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = settings.apiKey.trim();

  if (settings.provider === 'anthropic') {
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      if (!isOfficialAnthropicHost(settings.baseUrl)) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else if (apiKey) {
    // 本地 Ollama 等可以不填 key；此时不要发空的 Bearer 头。
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

/* ------------------------------------------------------------------ */
/* 请求体构造                                                          */
/* ------------------------------------------------------------------ */

function normalizeTemperature(value: number | undefined, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.7;
  return Math.min(max, Math.max(0, value));
}

function normalizeMaxTokens(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1024;
  return Math.min(64_000, Math.max(1, Math.floor(value)));
}

export function buildOpenAIRequestBody(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatCompleteExtOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    temperature: normalizeTemperature(options.temperature ?? settings.temperature, 2),
    max_tokens: normalizeMaxTokens(options.maxTokens ?? settings.maxTokens),
  };
  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return applyThinkingParams(body, settings, options.noThink);
}

/** 把 system 消息拆出来（Anthropic 用顶层 system 字段，messages 只能有 user/assistant）。 */
export function splitAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const rest: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
    } else {
      rest.push({ role: message.role, content: message.content });
    }
  }
  return { system: systemParts.join('\n\n'), messages: rest };
}

export function buildAnthropicRequestBody(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatCompleteExtOptions = {},
): Record<string, unknown> {
  const { system, messages: chatMessages } = splitAnthropicMessages(messages);
  if (chatMessages.length === 0) {
    throw new LLMError('config', '调用 Anthropic 需要至少一条 user 消息。');
  }

  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    max_tokens: normalizeMaxTokens(options.maxTokens ?? settings.maxTokens),
    temperature: normalizeTemperature(options.temperature ?? settings.temperature, 1),
    messages: chatMessages,
  };
  if (system) body.system = system;
  return applyThinkingParams(body, settings, options.noThink);
}

/** 按协议构造请求体（chatComplete / streamChat 共用）。 */
function buildCompletionBody(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatCompleteExtOptions,
): Record<string, unknown> {
  return settings.provider === 'anthropic'
    ? buildAnthropicRequestBody(settings, messages, options)
    : buildOpenAIRequestBody(settings, messages, options);
}

/* ------------------------------------------------------------------ */
/* 响应解析（纯函数，可单测）                                          */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function truncateText(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** 解析 OpenAI 兼容响应，返回 choices[0].message.content（兼容多段 content / 空内容）。 */
export function parseOpenAIContent(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return '';

  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    // 少数兼容实现把结果直接放顶层 content，做一手容错。
    return typeof root.content === 'string' ? root.content : '';
  }

  const first = asRecord(choices[0]);
  if (!first) return '';

  const message = asRecord(first.message);
  const content = message?.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      const record = asRecord(part);
      if (typeof record?.text === 'string') parts.push(record.text);
    }
    if (parts.length > 0) return parts.join('');
  }

  // 旧版 completion 接口的写法，仅作兜底。
  return typeof first.text === 'string' ? first.text : '';
}

/** 解析 Anthropic 响应：拼接所有 type === 'text' 的内容块。 */
export function parseAnthropicContent(payload: unknown): string {
  const root = asRecord(payload);
  if (!root) return '';
  if (typeof root.content === 'string') return root.content;
  if (!Array.isArray(root.content)) return '';

  const parts: string[] = [];
  for (const block of root.content) {
    const record = asRecord(block);
    if (record?.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('');
}

export function parseCompletionContent(provider: ProviderKind, payload: unknown): string {
  return provider === 'anthropic' ? parseAnthropicContent(payload) : parseOpenAIContent(payload);
}

/* ------------------------------------------------------------------ */
/* 模型列表解析（纯函数，可单测）                                      */
/* ------------------------------------------------------------------ */

function pushModel(models: ModelInfo[], model: ModelInfo, seen: Set<string>): void {
  if (!model.id || seen.has(model.id)) return;
  seen.add(model.id);
  models.push(model);
}

/** OpenAI 兼容 `{ data: [{ id }] }`。 */
export function parseOpenAIModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) return [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of root.data) {
    const record = asRecord(item);
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const model: ModelInfo = { id };
    const displayName = typeof record?.display_name === 'string' ? record.display_name.trim() : '';
    if (displayName) model.displayName = displayName;
    pushModel(models, model, seen);
  }
  return models;
}

/** Anthropic `{ data: [{ id, display_name, lifecycle, max_tokens }] }`（字段做兼容兜底）。 */
export function parseAnthropicModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.data)) return [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of root.data) {
    const record = asRecord(item);
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!id) continue;
    const model: ModelInfo = { id };
    const displayName = typeof record?.display_name === 'string' ? record.display_name.trim() : '';
    if (displayName) model.displayName = displayName;
    const lifecycle = record?.lifecycle ?? record?.status;
    if (typeof lifecycle === 'string' && lifecycle.trim()) model.lifecycle = lifecycle.trim();
    const maxTokens = record?.max_tokens ?? record?.max_output_tokens;
    if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
      model.maxTokens = Math.floor(maxTokens);
    }
    pushModel(models, model, seen);
  }
  return models;
}

/** Ollama `{ models: [{ name }] }`。 */
export function parseOllamaModels(payload: unknown): ModelInfo[] {
  const root = asRecord(payload);
  if (!root || !Array.isArray(root.models)) return [];
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const item of root.models) {
    const record = asRecord(item);
    const id = typeof record?.name === 'string' ? record.name.trim() : '';
    if (!id) continue;
    pushModel(models, { id }, seen);
  }
  return models;
}

/* ------------------------------------------------------------------ */
/* HTTP 错误映射（纯函数，可单测）                                     */
/* ------------------------------------------------------------------ */

/** 从服务端响应体里提取可读的错误摘要。 */
export function extractServerErrorDetail(bodyText: string, maxLength = 240): string {
  const text = bodyText.trim();
  if (!text) return '';

  try {
    const parsed: unknown = JSON.parse(text);
    const root = asRecord(parsed);
    if (root) {
      const errorRecord = asRecord(root.error);
      const detailRecord = asRecord(root.detail);
      const candidates: unknown[] = [
        errorRecord?.message,
        root.message,
        typeof root.error === 'string' ? root.error : undefined,
        detailRecord?.message,
        typeof root.detail === 'string' ? root.detail : undefined,
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          return truncateText(candidate, maxLength);
        }
      }
    }
  } catch {
    // 不是 JSON，按纯文本处理。
  }

  return truncateText(text, maxLength);
}

/** 把非 2xx 状态码映射成带 code 的 LLMError。 */
export function mapHttpStatus(status: number, bodyText: string): LLMError {
  const detail = extractServerErrorDetail(bodyText) || undefined;

  if (status === 401 || status === 403) {
    return new LLMError(
      'auth',
      `鉴权失败（HTTP ${status}）：请检查 API Key 是否正确、是否开通了该模型的权限。`,
      detail,
    );
  }
  if (status === 429) {
    return new LLMError('rate-limit', '请求过于频繁（HTTP 429），请稍后重试或降低调用频率。', detail);
  }
  if (status >= 500) {
    return new LLMError('server', `LLM 服务端错误（HTTP ${status}），请稍后重试。`, detail);
  }

  const suffix = detail ? `：${detail}` : '';
  return new LLMError('http', `LLM 接口返回错误（HTTP ${status}）${suffix}`, detail);
}

type ProxyErrorCode = 'bad-request' | 'network' | 'timeout';

const PROXY_ERROR_CODES: readonly ProxyErrorCode[] = ['bad-request', 'network', 'timeout'];

/** 识别代理自身的错误 JSON：`{"error":{"code":"…","message":"…"}}`。 */
function extractProxyError(bodyText: string): { code: ProxyErrorCode; message?: string } | null {
  try {
    const root = asRecord(JSON.parse(bodyText));
    const errorRecord = asRecord(root?.error);
    const code = errorRecord?.code;
    if (typeof code !== 'string') return null;
    const matched = PROXY_ERROR_CODES.find((item) => item === code);
    if (!matched) return null;
    const message = typeof errorRecord?.message === 'string' ? errorRecord.message.trim() : '';
    return message ? { code: matched, message } : { code: matched };
  } catch {
    return null;
  }
}

/** 代理自身错误（URL 非法 / 上游不可达 / 超时）映射为可操作 LLMError。 */
function mapProxyError(code: ProxyErrorCode, detail?: string): LLMError {
  switch (code) {
    case 'bad-request':
      return new LLMError(
        'config',
        `本地代理拒绝了请求：${detail ?? '请检查 Base URL 是否为合法的 http(s) 地址，以及模型名是否正确。'}`,
        detail,
      );
    case 'network':
      return new LLMError(
        'network',
        `本地代理无法连接上游服务：${detail ?? '请检查 Base URL 与网络连接。'}`,
        detail,
      );
    case 'timeout':
      return new LLMError(
        'timeout',
        `请求超时：${detail ?? '上游服务响应过慢，请检查网络或稍后重试。'}`,
        detail,
      );
  }
}

/**
 * 非 2xx 响应统一映射：先看是不是代理自身的错误 JSON，否则按上游状态码映射。
 * 代理与上游都复用 HTTP 状态码，只有代理错误带 `error.code` 白名单，因此可以区分。
 */
function mapForwardError(status: number, bodyText: string): LLMError {
  const proxyError = extractProxyError(bodyText);
  if (proxyError) return mapProxyError(proxyError.code, proxyError.message);
  return mapHttpStatus(status, bodyText);
}

/** 流式响应里上游错误对象（OpenAI / Anthropic 的 error event）映射。 */
function mapUpstreamErrorType(type: string, message: string): LLMError {
  const lower = type.toLowerCase();
  const detail = message || 'LLM 服务返回了错误响应。';
  if (lower.includes('rate_limit')) {
    return new LLMError('rate-limit', '请求过于频繁，请稍后重试。', detail);
  }
  if (lower.includes('auth') || lower.includes('permission') || lower.includes('api_key')) {
    return new LLMError('auth', '鉴权失败：请检查 API Key 是否正确。', detail);
  }
  if (lower.includes('timeout')) {
    return new LLMError('timeout', '上游服务响应超时，请稍后重试。', detail);
  }
  if (lower.includes('overload') || lower.includes('server') || lower.includes('api_error')) {
    return new LLMError('server', 'LLM 服务端错误，请稍后重试。', detail);
  }
  if (lower.includes('invalid_request')) {
    return new LLMError('http', `LLM 接口拒绝了请求：${detail}`, detail);
  }
  return new LLMError('http', `LLM 流式响应出错：${detail}`, detail);
}

/** 从流式 payload（SSE data 或非流式 JSON）里提取上游错误。 */
function mapStreamErrorPayload(payload: unknown): LLMError | null {
  const root = asRecord(payload);
  if (!root) return null;

  const errorRecord = asRecord(root.error);
  if (errorRecord) {
    const type =
      typeof errorRecord.type === 'string'
        ? errorRecord.type
        : typeof errorRecord.code === 'string'
          ? errorRecord.code
          : '';
    const message = typeof errorRecord.message === 'string' ? errorRecord.message.trim() : '';
    return mapUpstreamErrorType(type, message);
  }

  // Anthropic 的 error event 可能把字段直接平铺在 root 上。
  if (root.type === 'error') {
    const message = typeof root.message === 'string' ? root.message.trim() : '';
    const type = typeof root.code === 'string' ? root.code : '';
    return mapUpstreamErrorType(type, message);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 网络请求基础设施                                                    */
/* ------------------------------------------------------------------ */

interface ForwardPayload {
  /** 上游真实地址（由代理拨号，浏览器不直连）。 */
  url: string;
  /** 上游方法。 */
  method: 'GET' | 'POST';
  /** 只允许代理白名单内的头。 */
  headers: Record<string, string>;
  /** 已序列化的 JSON 文本。 */
  body?: string;
  /** true 时透传 SSE。 */
  stream?: boolean;
}

/** 单次请求的取消 / 超时控制器。 */
class RequestGuard {
  readonly controller = new AbortController();
  timedOut = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly callerSignal?: AbortSignal;
  private readonly handleCallerAbort = () => this.controller.abort();

  constructor(readonly timeoutMs: number, callerSignal?: AbortSignal) {
    this.callerSignal = callerSignal;
    if (callerSignal) {
      if (callerSignal.aborted) this.controller.abort();
      else callerSignal.addEventListener('abort', this.handleCallerAbort, { once: true });
    }
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, timeoutMs);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.callerSignal?.removeEventListener('abort', this.handleCallerAbort);
  }
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function mapTransportError(error: unknown, timedOut: boolean, timeoutMs: number): LLMError {
  if (timedOut) {
    return new LLMError(
      'timeout',
      `请求超时（${Math.round(timeoutMs / 1000)} 秒）：请检查网络，或稍后重试。`,
    );
  }
  if (isAbortError(error)) {
    return new LLMError('aborted', '生成已取消。');
  }
  return new LLMError(
    'network',
    '无法通过本地代理连接到 LLM 服务：请检查 Base URL 与网络，并确认本地代理已启动。',
    error instanceof Error ? error.message : String(error),
  );
}

/** 解析超时（非法值回落默认）。 */
function resolveTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 把请求发给同源代理；网络层错误统一映射。 */
async function sendForward(payload: ForwardPayload, guard: RequestGuard): Promise<Response> {
  try {
    return await fetch(LLM_FORWARD_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: payload.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(payload),
      signal: guard.controller.signal,
    });
  } catch (error) {
    throw mapTransportError(error, guard.timedOut, guard.timeoutMs);
  }
}

/** 读响应文本；中断 / 超时统一映射。 */
async function readResponseText(response: Response, guard: RequestGuard): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw mapTransportError(error, guard.timedOut, guard.timeoutMs);
  }
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LLMError(
      'parse',
      'LLM 接口返回的内容不是合法 JSON，无法解析。',
      truncateText(text, 240) || undefined,
    );
  }
}

/** 非 2xx 时决定是否去掉某个参数重试一次（思考参数优先，其次 jsonMode 的 response_format）。 */
function nextRetryBody(
  body: Record<string, unknown>,
  status: number,
  bodyText: string,
  jsonMode: boolean,
): Record<string, unknown> | null {
  if (status !== 400 && status !== 422) return null;
  // 代理自身错误不是参数问题，重试没有意义。
  if (extractProxyError(bodyText)) return null;

  if (hasThinkingParams(body) && mentionsThinkingParam(bodyText)) {
    return removeThinkingParams(body);
  }
  if (jsonMode && body.response_format !== undefined) {
    const retryBody = { ...body };
    delete retryBody.response_format;
    return retryBody;
  }
  return null;
}

/**
 * 发一次 JSON 请求（经代理），返回解析后的 payload。
 * - 思考参数被上游 400 点名拒绝时：去参重试一次；
 * - jsonMode 的 response_format 不被支持（400/422）时：去参重试一次。
 */
async function requestCompletionPayload(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: { jsonMode: boolean; signal?: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const guard = new RequestGuard(options.timeoutMs, options.signal);
  let currentBody = body;

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await sendForward(
        { url, method: 'POST', headers, body: JSON.stringify(currentBody) },
        guard,
      );
      const text = await readResponseText(response, guard);
      if (response.ok) return parseJsonPayload(text);

      const retryBody = nextRetryBody(currentBody, response.status, text, options.jsonMode);
      if (retryBody) {
        currentBody = retryBody;
        continue;
      }
      throw mapForwardError(response.status, text);
    }
    throw new LLMError('http', 'LLM 接口多次拒绝请求参数，已停止重试。');
  } finally {
    guard.dispose();
  }
}

/** 去掉流式标记（上游不支持 stream 参数时降级为一次性响应）。 */
function removeStreamFlag(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.stream;
  return next;
}

/**
 * 流式请求：2xx 直接返回 Response；
 * 400 点名思考参数时去思考参数重试；400 点名 stream 时去掉流式标记重试
 * （去掉后上游返回普通 JSON，由 consumeCompletionStream 的一次性兼容分支处理）。
 */
async function openStreamResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  guard: RequestGuard,
): Promise<Response> {
  let currentBody = body;

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await sendForward(
      { url, method: 'POST', headers, body: JSON.stringify(currentBody), stream: true },
      guard,
    );
    if (response.ok) return response;

    const text = await readResponseText(response, guard);
    if (attempt < 2 && response.status === 400 && !extractProxyError(text)) {
      if (hasThinkingParams(currentBody) && mentionsThinkingParam(text)) {
        currentBody = removeThinkingParams(currentBody);
        continue;
      }
      if (currentBody.stream === true && mentionsStreamParam(text)) {
        currentBody = removeStreamFlag(currentBody);
        continue;
      }
    }
    throw mapForwardError(response.status, text);
  }
  throw new LLMError('http', 'LLM 流式接口多次拒绝请求参数，已停止重试。');
}

/* ------------------------------------------------------------------ */
/* SSE 解析                                                            */
/* ------------------------------------------------------------------ */

interface SseEventOutcome {
  token?: string;
  done?: boolean;
  error?: LLMError;
}

/** 解释一条 SSE 事件（OpenAI `data:` / Anthropic `content_block_delta`）。 */
function interpretSseEvent(provider: ProviderKind, eventName: string, data: string): SseEventOutcome {
  if (provider !== 'anthropic') {
    if (data.trim() === '[DONE]') return { done: true };

    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      return {};
    }
    const root = asRecord(payload);
    if (!root) return {};

    const upstreamError = mapStreamErrorPayload(payload);
    if (upstreamError) return { error: upstreamError };

    const choices = root.choices;
    if (!Array.isArray(choices) || choices.length === 0) return {};
    const first = asRecord(choices[0]);
    const delta = asRecord(first?.delta);
    if (!delta) return {};
    // 只取正文增量；reasoning_content / reasoning 一律忽略。
    if (typeof delta.content === 'string' && delta.content) return { token: delta.content };
    return {};
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch {
    return {};
  }
  const root = asRecord(payload);
  if (!root) return {};

  const type = eventName || (typeof root.type === 'string' ? root.type : '');
  if (type === 'message_stop') return { done: true };
  if (type === 'error') {
    const upstreamError = mapStreamErrorPayload(payload);
    return { error: upstreamError ?? new LLMError('server', 'LLM 流式响应返回错误事件。') };
  }
  if (type === 'content_block_delta') {
    const delta = asRecord(root.delta);
    // 只要 text 增量，thinking_delta 等一律忽略。
    if (typeof delta?.text === 'string' && delta.text) return { token: delta.text };
  }
  return {};
}

/** 逐行 SSE 解析器：支持任意 chunk 边界与 CRLF，事件在空行处派发。 */
function createSseProcessor(provider: ProviderKind, onToken?: (token: string) => void) {
  let buffer = '';
  let full = '';
  let eventName = '';
  let dataLines: string[] = [];
  let done = false;

  const emitEvent = () => {
    if (done || dataLines.length === 0) {
      dataLines = [];
      eventName = '';
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';

    const outcome = interpretSseEvent(provider, name, data);
    if (outcome.error) throw outcome.error;
    if (outcome.token !== undefined) {
      full += outcome.token;
      onToken?.(outcome.token);
    }
    if (outcome.done) done = true;
  };

  const processLine = (line: string) => {
    if (done) return;
    if (line === '') {
      emitEvent();
      return;
    }
    if (line.startsWith(':')) return; // SSE 注释行

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry 等字段忽略
  };

  return {
    feed(chunk: string): void {
      if (!chunk || done) return;
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        processLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
        if (done) {
          buffer = '';
          return;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    },
    finish(): string {
      if (done) return full;
      if (buffer) {
        const rawLine = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        processLine(rawLine);
      }
      emitEvent();
      return full;
    },
    get done(): boolean {
      return done;
    },
  };
}

function readContentType(response: Response): string {
  try {
    return response.headers?.get?.('content-type') ?? '';
  } catch {
    return '';
  }
}

/** 读取一次 stream.read，同时响应取消 / 超时（对不感知 signal 的 mock / 老浏览器兜底）。 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }
    const handleAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => signal.removeEventListener('abort', handleAbort);

    signal.addEventListener('abort', handleAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 消费流式响应，返回拼接后的全文；SSE 每收到一段就回调 onToken。 */
async function consumeCompletionStream(
  response: Response,
  settings: LLMSettings,
  onToken: ((token: string) => void) | undefined,
  guard: RequestGuard,
): Promise<string> {
  const contentType = readContentType(response);

  // 少数上游 / 代理会把流式请求降级成普通 JSON，兼容成一次性文本。
  if (/application\/json/i.test(contentType)) {
    const text = await readResponseText(response, guard);
    const payload = parseJsonPayload(text);
    const upstreamError = mapStreamErrorPayload(payload);
    if (upstreamError) throw upstreamError;
    const content = parseCompletionContent(settings.provider, payload);
    if (content) onToken?.(content);
    return content;
  }

  const processor = createSseProcessor(settings.provider, onToken);
  const body = response.body;

  if (!body || typeof body.getReader !== 'function') {
    // 无 body 流时退化为整体文本解析（便于环境不支持 ReadableStream 时仍可工作）。
    const text = await readResponseText(response, guard);
    processor.feed(text);
    return processor.finish();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!processor.done) {
      const result = await readWithAbort(reader, guard.controller.signal);
      if (result.done) break;
      if (result.value) {
        processor.feed(decoder.decode(result.value, { stream: true }));
      }
    }
    processor.feed(decoder.decode());
    return processor.finish();
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw mapTransportError(error, guard.timedOut, guard.timeoutMs);
  } finally {
    void reader.cancel().catch(() => {
      // 已经读完 / 已取消，忽略。
    });
  }
}

/* ------------------------------------------------------------------ */
/* 对外主函数                                                          */
/* ------------------------------------------------------------------ */

/**
 * 发起一次 chat completion，返回纯文本内容（可能为空字符串，由调用方判定）。
 * 失败时抛出带 code 的 LLMError。
 */
export async function chatComplete(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatCompleteExtOptions = {},
): Promise<string> {
  assertUsableSettings(settings);
  if (options.signal?.aborted) throw new LLMError('aborted', '生成已取消。');

  const url = resolveEndpoint(settings);
  const headers = buildRequestHeaders(settings);
  const body = buildCompletionBody(settings, messages, options);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  const payload = await requestCompletionPayload(url, headers, body, {
    jsonMode: options.jsonMode === true,
    signal: options.signal,
    timeoutMs,
  });

  return parseCompletionContent(settings.provider, payload);
}

/**
 * 流式 chat completion：逐段回调 onToken，返回拼接全文。
 * 支持 OpenAI `data:` delta 与 Anthropic `content_block_delta` 两种 SSE 协议。
 */
export async function streamChat(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: StreamChatOptions = {},
): Promise<string> {
  assertUsableSettings(settings);
  if (options.signal?.aborted) throw new LLMError('aborted', '生成已取消。');

  const url = resolveEndpoint(settings);
  const headers: Record<string, string> = {
    ...buildRequestHeaders(settings),
    Accept: 'text/event-stream',
  };
  const body = {
    ...buildCompletionBody(settings, messages, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      noThink: options.noThink,
    }),
    // 上游必须收到 stream:true 才会真的流式返回；少了它，上游只回整包 JSON，
    // 客户端就退化成一次性文本（onToken 只回调一次）。
    stream: true,
  };
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const guard = new RequestGuard(timeoutMs, options.signal);

  try {
    const response = await openStreamResponse(url, headers, body, guard);
    return await consumeCompletionStream(response, settings, options.onToken, guard);
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw mapTransportError(error, guard.timedOut, guard.timeoutMs);
  } finally {
    guard.dispose();
  }
}

/** 经代理发一次 GET，返回上游模型列表 JSON。 */
async function requestModelList(
  settings: LLMSettings,
  url: string,
  kind: 'openai' | 'anthropic' | 'ollama',
): Promise<ModelInfo[]> {
  const guard = new RequestGuard(CONNECTION_TEST_TIMEOUT_MS, undefined);
  try {
    const response = await sendForward(
      {
        url,
        method: 'GET',
        headers: buildRequestHeaders(settings),
      },
      guard,
    );
    const text = await readResponseText(response, guard);
    if (!response.ok) throw mapForwardError(response.status, text);

    const payload = parseJsonPayload(text);
    if (kind === 'anthropic') return parseAnthropicModels(payload);
    if (kind === 'ollama') return parseOllamaModels(payload);
    return parseOpenAIModels(payload);
  } finally {
    guard.dispose();
  }
}

/** fetchModels 内部统一把未知错误收敛成 LLMError，便于拼中文 warning。 */
function toLLMError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  return new LLMError(
    'network',
    '获取模型列表失败：请检查网络与 Base URL，并确认本地代理已启动。',
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * 拉取模型列表（经代理 GET）。
 *
 * - OpenAI 兼容：`{base}/models`，解析 `data[].id`；
 * - Anthropic：`{base}/models`，解析 `data[].id/display_name/lifecycle/max_tokens`；
 * - vendor === 'ollama'：`/models` 失败时回落 `{origin}/api/tags`，解析 `models[].name`。
 *
 * 永不抛错：失败返回 `{ models: [], warning: 中文提示 }`。
 */
export async function fetchModels(settings: LLMSettings): Promise<FetchModelsResult> {
  if (!settings.baseUrl.trim()) {
    return { models: [], warning: '请先填写 Base URL，再获取模型列表。' };
  }
  if (settings.provider === 'anthropic' && !settings.apiKey.trim()) {
    return { models: [], warning: 'Anthropic 接口需要填写 API Key，请补全后再获取模型列表。' };
  }

  let primaryError: LLMError;
  try {
    const url = resolveModelsEndpoint(settings);
    const models = await requestModelList(settings, url, settings.provider === 'anthropic' ? 'anthropic' : 'openai');
    if (models.length === 0) {
      return { models: [], warning: '服务返回的模型列表为空，请检查接口路径或手动填写模型名。' };
    }
    return { models };
  } catch (error) {
    primaryError = toLLMError(error);
  }

  // Ollama：OpenAI 兼容 /models 不可用时回落原生 /api/tags。
  if (settings.vendor === 'ollama') {
    const tagsUrl = resolveOllamaTagsEndpoint(settings.baseUrl);
    if (tagsUrl) {
      try {
        const models = await requestModelList(settings, tagsUrl, 'ollama');
        if (models.length > 0) return { models };
        return { models: [], warning: 'Ollama 的模型列表为空，请先在本地 `ollama pull` 拉取模型。' };
      } catch (error) {
        const tagsError = toLLMError(error);
        return {
          models: [],
          warning: `获取模型列表失败：${primaryError.message} 回落 ${tagsUrl} 也失败（${tagsError.message}）。可手动填写模型名。`,
        };
      }
    }
  }

  return { models: [], warning: `获取模型列表失败：${primaryError.message} 可手动填写模型名。` };
}

/** 把 LLMError 翻译成设置页可以直接展示的中文可操作提示。 */
function connectionFailureMessage(error: LLMError): string {
  switch (error.code) {
    case 'config':
      return error.message;
    case 'auth':
      return `鉴权失败：请检查 API Key 是否正确、是否开通了该模型。${error.detail ? ` 服务端信息：${error.detail}` : ''}`;
    case 'rate-limit':
      return '请求过于频繁（HTTP 429），请稍后重试。';
    case 'timeout':
      return '请求超时：服务可能不可达或响应过慢，请检查网络与 Base URL。';
    case 'network':
      return '网络连接失败：无法通过本地代理连接上游服务，请检查 Base URL、网络，以及本地代理是否已启动。';
    case 'server':
      return `服务端错误（HTTP 5xx）：${error.detail ?? '请稍后重试。'}`;
    case 'http':
      return error.message;
    case 'parse':
      return '服务已响应，但返回格式无法解析：请确认 Base URL 指向兼容的对话接口。';
    case 'empty':
      return '服务已响应但内容为空：请确认模型名是否可用。';
    case 'aborted':
      return '连接测试已取消。';
    default:
      return error.message;
  }
}

/**
 * 发起一次极短请求测试连通性：`max_tokens: 1` + 强制关闭思考，只看响应是否成功
 * （空内容也算成功——有些模型在 1 token 下确实只回空串）。
 * 任何错误都不抛出，而是返回 ok:false + 中文可操作提示，便于设置页展示。
 */
export async function testLLMConnection(settings: LLMSettings): Promise<LLMConnectionResult> {
  const model = settings.model.trim() || undefined;
  const startedAt = Date.now();

  if (!settings.baseUrl.trim()) {
    return {
      ok: false,
      latencyMs: 0,
      message: '请先在设置页填写 Base URL，例如 https://api.deepseek.com/v1。',
      model,
    };
  }
  if (!settings.model.trim()) {
    return {
      ok: false,
      latencyMs: 0,
      message: '请先在设置页填写模型名，例如 deepseek-chat。',
      model,
    };
  }
  if (settings.provider === 'anthropic' && !settings.apiKey.trim()) {
    return {
      ok: false,
      latencyMs: 0,
      message: 'Anthropic 接口需要 API Key，请到设置页填写后再测试。',
      model,
    };
  }

  try {
    await chatComplete(
      settings,
      [
        { role: 'system', content: '你是一个连通性检测助手，只做最简回复。' },
        { role: 'user', content: '只回复 OK' },
      ],
      {
        maxTokens: 1,
        temperature: 0,
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
        jsonMode: false,
        noThink: true,
      },
    );
    const latencyMs = Date.now() - startedAt;
    return {
      ok: true,
      latencyMs,
      message: `连接成功（${latencyMs} ms），模型响应正常。`,
      model,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message =
      error instanceof LLMError
        ? connectionFailureMessage(error)
        : `连接失败：${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, latencyMs, message, model };
  }
}
