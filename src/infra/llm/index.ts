export {
  ANTHROPIC_VERSION,
  DEFAULT_TIMEOUT_MS,
  CONNECTION_TEST_TIMEOUT_MS,
  LLM_FORWARD_PATH,
  buildAnthropicRequestBody,
  buildOpenAIRequestBody,
  buildRequestHeaders,
  chatComplete,
  extractServerErrorDetail,
  fetchModels,
  hasUsableLLMConfig,
  mapHttpStatus,
  parseAnthropicContent,
  parseAnthropicModels,
  parseCompletionContent,
  parseOllamaModels,
  parseOpenAIContent,
  parseOpenAIModels,
  splitAnthropicMessages,
  streamChat,
  testLLMConnection,
} from './forward';

export { normalizeBaseUrl, resolveEndpoint } from './endpoints';
export { buildThinkingParams } from './vendors';

export {
  VENDOR_OPTIONS,
  checkBaseUrl,
  createInitialProviders,
  findActiveProvider,
  inferVendorFromBaseUrl,
  legacySettingsToProfile,
  normalizeAppShape,
  preserveApiKeys,
  providerName,
  providerSummaryText,
  resolveActiveLLMSettings,
  toLLMSettings,
  vendorLabel,
} from './providerModel';

export { FEEDBACK_PROMPT_VERSION } from './feedbackPrompts';
export {
  streamAnswerFeedback,
  streamTranslationGrade,
  localAnswerFeedback,
  localTranslationGrade,
} from './feedback';

export {
  buildQuestionLookupContext,
  clearLookupCache,
  formatLocalWordLookup,
  getCachedLookup,
  lookupCacheKey,
  normalizeLookupText,
  runLookup,
  setCachedLookup,
} from './lookup';
export type { LookupKind, LookupRequest, LookupResult } from './lookup';

export type {
  ChatCompleteExtOptions,
  ChatCompleteOptions,
  ChatMessage,
  FetchModelsResult,
  LLMConnectionResult,
  ModelInfo,
  StreamChatOptions,
} from './types';
export { LLMError } from './types';

