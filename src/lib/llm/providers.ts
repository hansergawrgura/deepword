/**
 * LLM 传输层：构造并发送 OpenAI 兼容 / Anthropic 请求，并把各种失败映射为 LLMError。
 *
 * 设计原则：
 * - 纯函数（URL 规范化、请求体构造、响应解析、HTTP 状态映射）与网络调用分离，便于单测；
 * - 所有失败都抛带 code 的 LLMError，UI 据此给出可操作提示或回退本地题库；
 * - 浏览器直连要求服务端允许 CORS；Anthropic 额外需要
 *   `anthropic-dangerous-direct-browser-access: true` 头。
 */

import type { LLMSettings, ProviderKind } from '../../types';
import type { ChatCompleteOptions, ChatMessage, LLMConnectionResult } from './types';
import { LLMError } from './types';

/** 普通请求默认超时：90 秒。 */
export const DEFAULT_TIMEOUT_MS = 90_000;
/** 连通性测试用较短超时，避免设置页卡太久。 */
export const CONNECTION_TEST_TIMEOUT_MS = 20_000;
/** Anthropic API 版本头。 */
export const ANTHROPIC_VERSION = '2023-06-01';
/** 让 Anthropic 允许浏览器直连（否则请求会被 CORS/权限拒绝）。 */
export const ANTHROPIC_BROWSER_ACCESS_HEADER = 'anthropic-dangerous-direct-browser-access';

/**
 * chatComplete 的扩展参数。
 * 类型契约里的 ChatCompleteOptions 由 Lead 维护、只读，因此在这里做本地扩展。
 */
export interface ChatCompleteExtOptions extends ChatCompleteOptions {
  /** 请求 JSON 模式（OpenAI response_format）；服务端不支持时自动去掉重试一次。 */
  jsonMode?: boolean;
  /** 覆盖默认 90s 超时。 */
  timeoutMs?: number;
}

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
/* URL 规范化（纯函数，可单测）                                        */
/* ------------------------------------------------------------------ */

/** 去掉首尾空白与末尾斜杠。 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 去掉协议与主机后，是否还有非根路径。 */
function hasNonRootPath(baseUrl: string): boolean {
  const withoutOrigin = normalizeBaseUrl(baseUrl).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.length > 0;
}

/**
 * 解析最终请求地址：
 * - OpenAI 兼容：`https://api.deepseek.com/v1` → `.../v1/chat/completions`；
 *   只填主机（如 `http://localhost:11434`）时补 `/v1/chat/completions`；
 *   已包含 `/chat/completions` 时原样使用，避免重复拼接。
 * - Anthropic：`https://api.anthropic.com` → `.../v1/messages`；
 *   已填 `/v1` 补 `/messages`；已包含 `/messages` 时原样使用。
 */
export function resolveEndpoint(settings: Pick<LLMSettings, 'provider' | 'baseUrl'>): string {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) {
    throw new LLMError('config', '尚未填写 Base URL，请到设置页补全（例如 https://api.deepseek.com/v1）。');
  }

  if (settings.provider === 'anthropic') {
    if (/\/messages$/i.test(base)) return base;
    if (/\/v1$/i.test(base)) return `${base}/messages`;
    if (!hasNonRootPath(base)) return `${base}/v1/messages`;
    return `${base}/messages`;
  }

  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (!hasNonRootPath(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

/* ------------------------------------------------------------------ */
/* 请求头 / 请求体（纯函数，可单测）                                   */
/* ------------------------------------------------------------------ */

export function buildRequestHeaders(settings: LLMSettings): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = settings.apiKey.trim();

  if (settings.provider === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    headers[ANTHROPIC_BROWSER_ACCESS_HEADER] = 'true';
  } else if (apiKey) {
    // 本地 Ollama 等可以不填 key；此时不要发空的 Bearer 头。
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

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
  return body;
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
  return body;
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

/* ------------------------------------------------------------------ */
/* 网络请求                                                            */
/* ------------------------------------------------------------------ */

interface TransportOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

/** 内部错误：携带状态码与响应体，供 jsonMode 重试逻辑判断。 */
class HttpStatusError extends Error {
  readonly status: number;
  readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.bodyText = bodyText;
  }
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
    '无法连接到 LLM 服务：请检查 Base URL 与网络；浏览器直连时还需服务端允许跨域（CORS）。',
    error instanceof Error ? error.message : String(error),
  );
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: TransportOptions,
): Promise<unknown> {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) throw new LLMError('aborted', '生成已取消。');

  const controller = new AbortController();
  let timedOut = false;
  const handleCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', handleCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapTransportError(error, timedOut, timeoutMs);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw mapTransportError(error, timedOut, timeoutMs);
    }

    if (!response.ok) throw new HttpStatusError(response.status, text);

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LLMError(
        'parse',
        'LLM 接口返回的内容不是合法 JSON，无法解析。',
        truncateText(text, 240) || undefined,
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', handleCallerAbort);
  }
}

/** jsonMode 不兼容时（400/422）自动去掉 response_format 重试一次。 */
async function requestPayload(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  options: TransportOptions & { jsonMode: boolean },
): Promise<unknown> {
  try {
    return await fetchJson(url, headers, body, options);
  } catch (error) {
    if (!(error instanceof HttpStatusError)) throw error;

    const includedJsonMode = body.response_format !== undefined;
    if (options.jsonMode && includedJsonMode && (error.status === 400 || error.status === 422)) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      try {
        return await fetchJson(url, headers, retryBody, options);
      } catch (retryError) {
        if (retryError instanceof HttpStatusError) {
          throw mapHttpStatus(retryError.status, retryError.bodyText);
        }
        throw retryError;
      }
    }

    throw mapHttpStatus(error.status, error.bodyText);
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
  const body =
    settings.provider === 'anthropic'
      ? buildAnthropicRequestBody(settings, messages, options)
      : buildOpenAIRequestBody(settings, messages, options);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const payload = await requestPayload(url, headers, body, {
    signal: options.signal,
    timeoutMs,
    jsonMode: options.jsonMode === true,
  });

  return parseCompletionContent(settings.provider, payload);
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
      return '网络连接失败：请检查 Base URL、网络与代理；浏览器直连时服务端必须允许 CORS。';
    case 'server':
      return `服务端错误（HTTP 5xx）：${error.detail ?? '请稍后重试。'}`;
    case 'http':
      return error.message;
    case 'parse':
      return '服务已响应，但返回格式无法解析：请确认 Base URL 指向 OpenAI 兼容的接口。';
    case 'empty':
      return '服务已响应但内容为空：请确认模型名是否可用。';
    case 'aborted':
      return '连接测试已取消。';
    default:
      return error.message;
  }
}

/**
 * 发起一次极短请求测试连通性。
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
    const content = await chatComplete(
      settings,
      [
        { role: 'system', content: '你是一个连通性检测助手，只做最简回复。' },
        { role: 'user', content: '只回复 OK' },
      ],
      {
        maxTokens: 8,
        temperature: 0,
        timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
        jsonMode: false,
      },
    );
    const latencyMs = Date.now() - startedAt;
    const reply = content.trim();
    if (!reply) {
      return {
        ok: true,
        latencyMs,
        message: '连接成功，但模型没有返回内容，请确认模型名是否可用。',
        model,
      };
    }
    return {
      ok: true,
      latencyMs,
      message: `连接成功（${latencyMs} ms），模型已正常返回内容。`,
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
