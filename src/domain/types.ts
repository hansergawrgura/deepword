export type ViewId = 'dashboard' | 'study' | 'wordbook' | 'settings';

export type ThemeMode = 'light' | 'dark';

export type AppLocale = 'en' | 'zh-CN';

/* ------------------------------------------------------------------ */
/* 单词                                                                */
/* ------------------------------------------------------------------ */

export interface Word {
  id: string;
  term: string;
  phonetic?: string;
  partOfSpeech?: string;
  meaning: string;
  example?: string;
  exampleTranslation?: string;
  tags: string[];
  createdAt: number;
}

export interface WordInput {
  term: string;
  phonetic?: string;
  partOfSpeech?: string;
  meaning: string;
  example?: string;
  exampleTranslation?: string;
  tags?: string[];
}

/* ------------------------------------------------------------------ */
/* 练习                                                                */
/* ------------------------------------------------------------------ */

export type Skill = 'en2zh' | 'zh2en' | 'spell' | 'listen' | 'sentence' | 'translate';

export type TranslationVerdict = 'perfect' | 'good' | 'poor';

/** 一道本地生成的练习题（v3 以 Skill 为唯一题型维度）。 */
export interface Question {
  id: string;
  wordId: string;
  skill: Skill;
  prompt: string;
  options?: string[];
  answer: string;
  acceptableAnswers?: string[];
  explanation: string;
  difficulty: number;
  /** 听音题 */
  audio?: boolean;
  /** 互译方向 */
  direction?: 'en2zh' | 'zh2en';
}

export interface Attempt {
  id: string;
  wordId: string;
  skill: Skill;
  correct: boolean;
  verdict?: TranslationVerdict;
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: 'ok' | 'failed' | 'local-fallback';
  latencyMs?: number;
  roundId?: string;
  createdAt: number;
}

export interface Mistake {
  wordId: string;
  wrongCount: number;
  correctStreak: number;
  firstWrongAt: number;
  lastWrongAt: number;
  lastAttemptAt: number;
  lastSkill?: Skill;
  lastPrompt?: string;
}

/* ------------------------------------------------------------------ */
/* LLM                                                                 */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'openai' | 'anthropic';

export type Vendor =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'qwen'
  | 'ollama'
  | 'kimi'
  | 'glm'
  | 'siliconflow'
  | 'minimax'
  | 'volcengine'
  | 'custom';

export type ThinkingMode = 'off' | 'provider-default';

export interface ProviderProfile {
  id: string;
  name: string;
  protocol: ProviderKind;
  vendor: Vendor;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  thinkingMode: ThinkingMode;
  createdAt: number;
  updatedAt: number;
}

export type ProviderDraft = Omit<ProviderProfile, 'id' | 'createdAt' | 'updatedAt'>;

export const MAX_PROVIDERS = 20;
export const MAX_MODELS_PER_PROVIDER = 300;

export interface LLMSettings {
  /** openai 表示所有 OpenAI 兼容接口（OpenAI、DeepSeek、Moonshot、Ollama 等） */
  provider: ProviderKind;
  /** 厂商，决定思考参数映射；缺省按 custom（不发思考参数）处理。 */
  vendor?: Vendor;
  thinkingMode?: ThinkingMode;
  /** 例如 https://api.openai.com/v1 或 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** v1 旧数据的 settings 形状，仅用于迁移。 */
export interface LegacyLLMSettings {
  provider: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/* ------------------------------------------------------------------ */
/* 练习设置 / 一轮会话                                                  */
/* ------------------------------------------------------------------ */

export interface TtsSettings {
  rate: number;
  voiceUri: string;
  autoPlay: boolean;
}

export interface PracticeSettings {
  newWordsPerRound: number;
  questionsPerNewWord: number;
  reviewWordsPerRound: number;
  reviewQuestionsPerRound: number;
  feedbackAutoAdvanceMs: number;
  autoExplain: boolean;
  tts: TtsSettings;
}

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = {
  newWordsPerRound: 1,
  questionsPerNewWord: 6,
  reviewWordsPerRound: 6,
  reviewQuestionsPerRound: 10,
  feedbackAutoAdvanceMs: 3_000,
  autoExplain: true,
  tts: { rate: 1, voiceUri: '', autoPlay: true },
};

export interface PracticeResult {
  questionId: string;
  wordId: string;
  skill: Skill;
  prompt: string;
  response: string;
  answer: string;
  correct: boolean;
  verdict?: TranslationVerdict;
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: 'ok' | 'failed' | 'local-fallback';
  latencyMs?: number;
  answeredAt: number;
}

export interface PracticeSessionState {
  id: string;
  startedAt: number;
  stage: 'gate' | 'new' | 'review' | 'done';
  newWordIds: string[];
  completedNewWordIds: string[];
  reviewWordIds: string[];
  answered: number;
  targetQuestions: number;
  roundNo?: number;
  gate?: 'ask' | 'confirm' | null;
  currentWordId?: string;
  questions?: Question[];
  questionIndex?: number;
  results?: PracticeResult[];
}

export interface MasteryRecord {
  wordId: string;
  masteredAt: number;
  source: 'manual' | 'rule';
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface DailyStat {
  reviewed: number;
  correct: number;
  wrong: number;
  learned: number;
}

export interface LearningStats {
  daily: Record<string, DailyStat>;
}

/* ------------------------------------------------------------------ */
/* 应用数据 v3                                                         */
/* ------------------------------------------------------------------ */

export const DATA_VERSION = 3;

export interface AppData {
  version: typeof DATA_VERSION;
  words: Word[];
  providers: ProviderProfile[];
  activeProviderId: string | null;
  practice: PracticeSettings;
  session?: PracticeSessionState | null;
  mastery?: Record<string, MasteryRecord>;
  attempts: Attempt[];
  mistakes: Record<string, Mistake>;
  theme: ThemeMode;
  /** UI locale; omitted in older payloads → default `en`. */
  locale?: AppLocale;
  stats: LearningStats;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
}

export interface ViewProps {
  navigate: (view: ViewId) => void;
}
