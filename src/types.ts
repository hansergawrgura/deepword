/**
 * 词渊 DeepWord —— 全局领域类型。
 *
 * 这是全项目唯一的类型契约来源：
 * - 负责 UI 的同事只从本文件与 state/AppState 导入类型；
 * - 负责 LLM 的同事使用 lib/llm/types.ts 中的请求/响应类型；
 * - 存储层负责把 AppData 持久化到 localStorage。
 */

/** 应用内的五个主视图。 */
export type ViewId = 'dashboard' | 'study' | 'wordbook' | 'settings';

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
export type ExerciseType = 'choice' | 'fill' | 'spell' | 'translate' | 'sentence' | 'usage' | 'correction';

/** 记忆练习的 6 个技能维度（Phase B 使用）。 */
export type Skill = 'en2zh' | 'zh2en' | 'spell' | 'listen' | 'sentence' | 'translate';

/** 互译三档判定。 */
export type TranslationVerdict = 'perfect' | 'good' | 'poor';

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
  /** 记忆练习的技能维度（Phase B 使用）；早期历史记录可不填。 */
  skill?: Skill;
  /** 题干带音频（听音题）时为 true。 */
  audio?: boolean;
  /** 互译方向（translate 题使用）。 */
  direction?: 'en2zh' | 'zh2en';
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
  /** 记忆练习的技能维度（Phase B；闪卡/旧题不填）。 */
  skill?: Skill;
  /** 本题耗时（毫秒）。 */
  latencyMs?: number;
  /** 互译判分三档（Phase B）。 */
  verdict?: TranslationVerdict;
  /** AI 讲解与改进建议（截断 ≤400），用于历史回看。 */
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: 'ok' | 'failed' | 'local-fallback';
  /** 所属学习轮次（Phase B）：掌握判定要求作答分布在 ≥2 轮次。 */
  roundId?: string;
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

/** 厂商提示：只用于选择「思考开关」参数与预设，不影响协议本身。 */
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

/** off = 尽量关闭推理/思考输出；provider-default = 交给服务商默认。 */
export type ThinkingMode = 'off' | 'provider-default';

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

/** 一份可保存的 provider 配置；同时只有一个 active。 */
export interface ProviderProfile {
  id: string;
  name: string;
  protocol: ProviderKind;
  vendor: Vendor;
  baseUrl: string;
  apiKey: string;
  /** 勾选保留的 model id 白名单；defaultModel 允许不在其中（自定义 model id）。 */
  models: string[];
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  thinkingMode: ThinkingMode;
  createdAt: number;
  updatedAt: number;
}

/** 新建或编辑 provider 时由 UI 提供的字段（id / 时间戳由状态层补齐）。 */
export type ProviderDraft = Omit<ProviderProfile, 'id' | 'createdAt' | 'updatedAt'>;

/** 上限：provider 数量与单个 provider 的模型白名单长度。 */
export const MAX_PROVIDERS = 20;
export const MAX_MODELS_PER_PROVIDER = 300;

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
/* 记忆练习设置（Phase B 使用，Phase A 只落结构）                       */
/* ------------------------------------------------------------------ */

export interface TtsSettings {
  /** 语速 0.5~2，默认 1。 */
  rate: number;
  /** 选中的 voice URI，空串表示自动选英文语音。 */
  voiceUri: string;
  autoPlay: boolean;
}

export interface PracticeSettings {
  /** 每轮新词数，默认 1。 */
  newWordsPerRound: number;
  /** 每词题量，默认 6，范围 4~8。 */
  questionsPerNewWord: number;
  /** 每轮复习词数，默认 6。 */
  reviewWordsPerRound: number;
  /** 每轮复习题量，默认 10，约束 [词数, 2×词数]。 */
  reviewQuestionsPerRound: number;
  /** 答对类反馈自动跳转时长（ms），0 = 手动。 */
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

/** 一轮练习中一道题的作答结果；随 PracticeSessionState 持久化，供小结回看讲解。 */
export interface PracticeResult {
  questionId: string;
  wordId: string;
  skill: Skill;
  exerciseType: ExerciseType;
  prompt: string;
  /** 用户给出的答案（选择题选项原文 / 填空原文 / 互译原文） */
  response: string;
  /** 正确答案或互译参考译文 */
  answer: string;
  correct: boolean;
  verdict?: TranslationVerdict;
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: 'ok' | 'failed' | 'local-fallback';
  latencyMs?: number;
  answeredAt: number;
}

/** 一轮练习的进度；Phase B 使用，Phase A 只落结构。 */
export interface PracticeSessionState {
  id: string;
  startedAt: number;
  stage: 'gate' | 'new' | 'review' | 'done';
  newWordIds: string[];
  completedNewWordIds: string[];
  reviewWordIds: string[];
  answered: number;
  targetQuestions: number;
  /* ---- Phase B 新增（可选，旧数据与旧结构保持缺省） ---- */
  /** 轮次序号（第几轮），用于成绩单与掌握判定。 */
  roundNo?: number;
  /** 新词闸门子阶段：ask=待选择认识/掌握，confirm=已点掌握、待确认。 */
  gate?: 'ask' | 'confirm' | null;
  /** 当前正在处理的词（gate/new 阶段）。 */
  currentWordId?: string;
  /** 当前阶段（new 或 review）的题目集。 */
  questions?: Exercise[];
  /** 当前题目下标。 */
  questionIndex?: number;
  /** 本轮已答题目（含讲解），供小结回看。 */
  results?: PracticeResult[];
}

/** 掌握标记：存在即表示该词已掌握（永久不再学习与复习，可手动取消）。 */
export interface MasteryRecord {
  wordId: string;
  masteredAt: number;
  /** manual = 闪卡闸门手动确认；rule = 满足掌握判定规则后自动标记。 */
  source: 'manual' | 'rule';
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

export const DATA_VERSION = 2;

export interface AppData {
  version: number;
  words: Word[];
  /** 保存的 provider 配置；同时只有 activeProviderId 指向的那份生效。 */
  providers: ProviderProfile[];
  activeProviderId: string | null;
  /** Phase B 的练习设置（Phase A 起就落盘，迁移时填默认值）。 */
  practice: PracticeSettings;
  /** 未完成的一轮练习（Phase B 使用）。 */
  session?: PracticeSessionState | null;
  /** wordId -> 掌握标记；存在即已掌握（卡片状态同步为 mastered）。 */
  mastery?: Record<string, MasteryRecord>;
  /** wordId -> 标记时间；闪卡 tab 点「不认识」的词在下一轮复习中优先出现。 */
  reviewPriority?: Record<string, number>;
  /** wordId -> 卡片，理论上每个 word 都有一张卡，读取时做兜底 */
  srs: Record<string, SrsCard>;
  /** 最近若干次作答，倒序由 UI 处理 */
  attempts: Attempt[];
  mistakes: Record<string, Mistake>;
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
