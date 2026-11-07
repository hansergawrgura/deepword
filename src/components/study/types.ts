/**
 * 学习页（Phase B）内部共享类型。
 */

import type { TranslationVerdict } from '@/types';

/** 当前题的反馈状态（流式讲解 / 本地鼓励语）。 */
export interface AnswerFeedbackState {
  /** ok = AI 讲解；local-fallback = 本地解析降级；failed = AI 失败但仍展示本地解析。 */
  status: 'ok' | 'failed' | 'local-fallback';
  /** 讲解正文（流式过程中会不断增长）。 */
  text: string;
  /** 「改进：」段落。 */
  improvement?: string;
  /** 互译三档判分。 */
  verdict?: TranslationVerdict;
  /** 是否仍在流式输出。 */
  streaming: boolean;
}

/** 一道题的作答阶段。 */
export type AnswerPhase = 'idle' | 'judging' | 'answered';
