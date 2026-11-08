import type { LLMSettings, ProviderKind } from '@/domain/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompleteOptions {
  signal?: AbortSignal;
  /** 覆盖 settings.maxTokens */
  maxTokens?: number;
  temperature?: number;
}

/** chatComplete 的扩展参数（jsonMode / 超时 / noThink）。 */
export interface ChatCompleteExtOptions extends ChatCompleteOptions {
  /** 请求 JSON 模式（OpenAI response_format）；服务端不支持时自动去掉重试一次。 */
  jsonMode?: boolean;
  /** 覆盖默认 90s 超时。 */
  timeoutMs?: number;
  /** 强制关闭思考；默认遵 settings.thinkingMode。 */
  noThink?: boolean;
}

/** 统一的 LLM 错误，UI 根据 code 给出可操作的提示。 */
export class LLMError extends Error {
  code:
    | 'config'
    | 'network'
    | 'auth'
    | 'rate-limit'
    | 'timeout'
    | 'http'
    | 'parse'
    | 'empty'
    | 'aborted'
    | 'server';

  detail?: string;

  constructor(code: LLMError['code'], message: string, detail?: string) {
    super(message);
    this.name = 'LLMError';
    this.code = code;
    this.detail = detail;
  }
}

export interface LLMConnectionResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** 实际使用的模型名 */
  model?: string;
}

export interface ModelInfo {
  id: string;
  displayName?: string;
  lifecycle?: string;
  maxTokens?: number;
}

export interface FetchModelsResult {
  models: ModelInfo[];
  warning?: string;
}

/** 流式请求选项（讲解 / 互译判分 / chat 共用）。 */
export interface StreamChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  onToken?: (token: string) => void;
  noThink?: boolean;
  timeoutMs?: number;
}

export type { LLMSettings, ProviderKind };
