/**
 * LLM 出题层对外唯一入口（纯 barrel）。
 *
 * 函数签名与类型导出由契约锁定，学习页 / 设置页与测试依赖这些入口；
 * 结构调整时请保持本文件导出的函数名与类型名不变。
 */

export { generateExercises } from './generate';
export { chatComplete, fetchModels, hasUsableLLMConfig, streamChat, testLLMConnection } from './providers';
export { PROMPT_VERSION } from './prompts';
export { FEEDBACK_PROMPT_VERSION } from './feedbackPrompts';

export type {
  ChatCompleteOptions,
  ChatMessage,
  ExerciseRequest,
  ExerciseTarget,
  FetchModelsResult,
  LLMConnectionResult,
  ModelInfo,
  StreamChatOptions,
} from './types';
export { LLMError } from './types';
