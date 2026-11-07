/**
 * 词渊 DeepWord —— 全局领域类型。
 *
 * 这是全项目唯一的类型契约来源：
 * - 负责 UI 的同事只从本文件与 state/AppState 导入类型；
 * - 负责 LLM 的同事使用 lib/llm/types.ts 中的请求/响应类型；
 * - 存储层负责把 AppData 持久化到 localStorage。
 */

/** 应用内的五个主视图。 */
export type ViewId = 'dashboard' | 'study' | 'drill' | 'wordbook' | 'settings';

export type ThemeMode = 'light' | 'dark';

/* ------------------------------------------------------------------ */
/* 单词                                                                */
/* ------------------------------------------------------------------ */

export interface Word {
  id: string;
  /** 词条本身，例如 "abandon" */
  term: string;
  /** 音标，例如 "/əˈbændən/" */
  phonetic?: string;
  /** 词性，例如 "v." */
  partOfSpeech?: string;
  /** 中文释义，可含多个义项，用 "；" 分隔 */
  meaning: string;
  /** 英文例句，目标词需完整出现 */
  example?: string;
  /** 例句翻译 */
  exampleTranslation?: string;
  /** 标签，例如 ["CET-4", "核心"] */
  tags: string[];
  createdAt: number;
}

/** 新建单词时由用户提供的字段（其余由系统补齐）。 */
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
/* 间隔重复（SRS）                                                     */
/* ------------------------------------------------------------------ */

export type SrsStatus = 'new' | 'learning' | 'review' | 'mastered';

/** 自评四档：again=没记住，hard=模糊，good=记住了，easy=太简单 */
export type Grade = 'again' | 'hard' | 'good' | 'easy';

export interface SrsCard {
  wordId: string;
  status: SrsStatus;
  /** 难度系数，SM-2 风格，范围 [1.3, 3.0] */
  ease: number;
  /** 当前间隔（天），0 表示尚未排期 */
  interval: number;
  /** 下次到期时间戳（毫秒） */
  dueAt: number;
  /** 复习次数 */
  reps: number;
  /** 遗忘次数 */
  lapses: number;
  lastReviewedAt?: number;
}

/* ------------------------------------------------------------------ */
/* 练习 / 错题                                                         */
/* ------------------------------------------------------------------ */

/**
 * 练习题类型，全部可自动判分：
 * - choice：含义/用法四选一，answer 为正确选项原文
 * - fill：填空，answer 为应填内容，可提供 acceptableAnswers
 * - usage：选出用法正确的句子（选择题），answer 为正确选项原文
 * - correction：选出修正后的句子（选择题），answer 为正确选项原文
 */
export type ExerciseType = 'choice' | 'fill' | 'usage' | 'correction';

export type ExerciseSource = 'llm' | 'local';

export interface Exercise {
  id: string;
  /** 关联的单词 id */
  wordId: string;
  type: ExerciseType;
  /** 题干；fill 类型用 ____ 表示空格 */
  prompt: string;
  /** 选择题的选项（3~4 个，不含序号），非选择题为空 */
  options?: string[];
  /** 正确答案；选择题为正确选项的完整原文 */
  answer: string;
  /** 填空的等价答案（大小写、单复数等容错） */
  acceptableAnswers?: string[];
  /** 中文解析，讲清为什么 */
  explanation: string;
  /** 1~5，越大越难 */
  difficulty: number;
  source: ExerciseSource;
}

/** 一次答题结果：闪卡自评或练习题作答。 */
export interface Attempt {
  id: string;
  wordId: string;
  kind: 'flashcard' | 'exercise';
  /** 闪卡自评档位；练习题没有 */
  grade?: Grade;
  /** 闪卡：grade !== 'again' 记为正确；练习题为实际判分 */
  correct: boolean;
  exerciseType?: ExerciseType;
  source?: ExerciseSource;
  createdAt: number;
}

/** 单个单词的错题档案。 */
export interface Mistake {
  wordId: string;
  /** 累计答错次数 */
  wrongCount: number;
  /** 连续答对次数（用于判定是否摆脱错题） */
  correctStreak: number;
  firstWrongAt: number;
  lastWrongAt: number;
  /** 最近一次相关作答时间 */
  lastAttemptAt: number;
  /** 最近一次答错时的题型，供 LLM 出题时参考 */
  lastExerciseType?: ExerciseType;
  /** 最近一次答错时的题干，供 LLM 避免重复出题 */
  lastPrompt?: string;
}

/* ------------------------------------------------------------------ */
/* LLM 设置                                                            */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'openai' | 'anthropic';

export interface LLMSettings {
  /** openai 表示所有 OpenAI 兼容接口（OpenAI、DeepSeek、Moonshot、Ollama 等） */
  provider: ProviderKind;
  /** 例如 https://api.openai.com/v1 或 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/* ------------------------------------------------------------------ */
/* 每日统计                                                            */
/* ------------------------------------------------------------------ */

export interface DailyStat {
  /** 当日完成的复习/练习次数 */
  reviewed: number;
  /** 当日答对次数 */
  correct: number;
  /** 当日答错次数 */
  wrong: number;
  /** 当日新学单词数 */
  learned: number;
}

export interface LearningStats {
  /** key 为本地日期 YYYY-MM-DD */
  daily: Record<string, DailyStat>;
}

/* ------------------------------------------------------------------ */
/* 应用数据                                                            */
/* ------------------------------------------------------------------ */

export const DATA_VERSION = 1;

export interface AppData {
  version: number;
  words: Word[];
  /** wordId -> 卡片，理论上每个 word 都有一张卡，读取时做兜底 */
  srs: Record<string, SrsCard>;
  /** 最近若干次作答，倒序由 UI 处理 */
  attempts: Attempt[];
  mistakes: Record<string, Mistake>;
  settings: LLMSettings;
  theme: ThemeMode;
  stats: LearningStats;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 学习会话                                                            */
/* ------------------------------------------------------------------ */

export type StudyMode = 'review' | 'new' | 'mixed';

export interface StudyItem {
  word: Word;
  card: SrsCard;
  isNew: boolean;
  /** 是否属于到期复习 */
  isDue: boolean;
}

export interface StudyQueue {
  items: StudyItem[];
  dueCount: number;
  newCount: number;
}

/* ------------------------------------------------------------------ */
/* 通用 UI                                                             */
/* ------------------------------------------------------------------ */

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastMessage {
  id: string;
  message: string;
  tone: ToastTone;
}

/** 页面组件统一接收的导航能力。 */
export interface ViewProps {
  navigate: (view: ViewId) => void;
}

export type DifficultyPreference = 'adaptive' | 'foundation' | 'challenge';
