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

/**
 * 一道题的作答阶段。判定「是否还能继续作答」只看 phase，题型内部不再各自判断。
 *
 * - idle    未作答：选项 / 输入框可操作；
 * - judging 判分中：本地判分瞬时完成，互译等 AI 判分期间短暂停留；
 * - retry   本次作答错误：反馈照常展示，但题目**不锁**，可继续作答直到答对；
 * - answered 已答对（或互译已判分）：题目锁定，可进入下一题。
 */
export type AnswerPhase = 'idle' | 'judging' | 'retry' | 'answered';

/** 题目是否仍可继续作答（retry 与 idle 都可）。 */
export function isAnswering(phase: AnswerPhase): boolean {
  return phase === 'idle' || phase === 'retry';
}
