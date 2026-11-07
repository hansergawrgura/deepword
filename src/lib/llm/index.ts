/**
 * LLM 出题层对外唯一入口（纯 barrel）。
 *
 * 函数签名与类型导出由 Lead 的契约锁定，App / DrillView 依赖这些入口；
 * 结构调整时请保持这 4 个函数与 LLMError / 请求响应类型不变。
 */

export { generateExercises } from './generate';
export { hasUsableLLMConfig, testLLMConnection } from './providers';
export { PROMPT_VERSION } from './prompts';

export type {
  ChatCompleteOptions,
  ChatMessage,
  ExerciseRequest,
  ExerciseTarget,
  LLMConnectionResult,
} from './types';
export { LLMError } from './types';
