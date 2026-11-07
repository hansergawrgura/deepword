/**
 * LLM 出题层的类型契约（由 Lead 维护，实现方只读）。
 */

import type {
  DifficultyPreference,
  Exercise,
  ExerciseType,
  LLMSettings,
  Mistake,
  SrsStatus,
  Word,
} from '../../types';

/** 交给 LLM 的单个单词上下文，包含它为什么值得被针对性出题。 */
export interface ExerciseTarget {
  word: Word;
  wrongCount: number;
  correctStreak: number;
  srsStatus?: SrsStatus;
  lastExerciseType?: ExerciseType;
  lastMistakeAt?: number;
  /** 最近 10 次该词的答对率 [0,1]，无记录时为 undefined */
  recentAccuracy?: number;
}

export interface ExerciseRequest {
  targets: ExerciseTarget[];
  /** 期望题量（实现层应尽量满足，最终以实际校验通过的为准） */
  count: number;
  difficulty: DifficultyPreference;
  settings: LLMSettings;
  signal?: AbortSignal;
  /** 生成阶段文案回调，用于 UI 展示「正在为错词命题…」 */
  onProgress?: (stage: string) => void;
}

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

/* ------------------------------------------------------------------ */
/* 模型列表（Provider 管理用）                                          */
/* ------------------------------------------------------------------ */

export interface ModelInfo {
  /** model id，例如 gpt-4o-mini */
  id: string;
  /** 服务商给的展示名（Anthropic 有；OpenAI 兼容通常没有） */
  displayName?: string;
  /** Anthropic lifecycle：active / deprecated / retired；其他服务商可能没有 */
  lifecycle?: string;
  /** 服务商声明的最大输出 tokens（Anthropic 有） */
  maxTokens?: number;
}

export interface FetchModelsResult {
  models: ModelInfo[];
  /** 非致命提示，例如返回为空时引导手动填写 */
  warning?: string;
}

/** 流式请求选项（讲解 / 互译判分 / 未来 chat 共用）。 */
export interface StreamChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** 每收到一段文本就回调一次 */
  onToken?: (token: string) => void;
  /** 强制关闭思考（讲解 / 判分用）；默认遵 from settings.thinkingMode */
  noThink?: boolean;
  /** 覆盖默认超时 */
  timeoutMs?: number;
}

export interface RawExercisePayload {
  exercises?: unknown;
}

export type { Exercise, ExerciseType, LLMSettings, Mistake, Word };
