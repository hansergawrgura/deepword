/**
 * 学习页内部共享类型。
 */

import type { TranslationVerdict } from '@/domain/types';

export interface AnswerFeedbackState {
  status: 'ok' | 'failed' | 'local-fallback';
  text: string;
  improvement?: string;
  verdict?: TranslationVerdict;
  streaming: boolean;
}

export type AnswerPhase = 'idle' | 'judging' | 'retry' | 'answered';

export function isAnswering(phase: AnswerPhase): boolean {
  return phase === 'idle' || phase === 'retry';
}
