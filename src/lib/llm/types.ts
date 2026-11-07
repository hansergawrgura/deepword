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

export interface RawExercisePayload {
  exercises?: unknown;
}

export type { Exercise, ExerciseType, LLMSettings, Mistake, Word };
