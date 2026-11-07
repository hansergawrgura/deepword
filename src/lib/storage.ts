/**
 * localStorage 持久化层（数据版本 v2）。
 *
 * - 首次打开：用内置词库生成初始数据（示例词库 + 1 份默认 provider + 默认练习设置）；
 * - 读取时做完整的字段清洗与兜底；旧版 v1 数据会自动迁移到 v2；
 * - 损坏的 v2 数据会备份到 `deepword:data:v2:corrupt:<ts>` 后降级重建；
 * - 导入/导出使用带元信息的 JSON；默认导出不含 API Key；
 * - 所有写入都可能因配额失败，调用方需处理 { ok: false }。
 */

import { SEED_WORDS } from '../data/wordbank';
import {
  DATA_VERSION,
  DEFAULT_PRACTICE_SETTINGS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  type AppData,
  type Attempt,
  type DailyStat,
  type Exercise,
  type ExerciseType,
  type LearningStats,
  type LegacyLLMSettings,
  type MasteryRecord,
  type Mistake,
  type PracticeResult,
  type PracticeSessionState,
  type PracticeSettings,
  type ProviderKind,
  type ProviderProfile,
  type Skill,
  type SrsCard,
  type SrsStatus,
  type ThinkingMode,
  type TranslationVerdict,
  type TtsSettings,
  type Vendor,
  type Word,
  type WordInput,
} from '../types';
import {
  VENDOR_OPTIONS,
  createInitialProviders,
  inferVendorFromBaseUrl,
  legacySettingsToProfile,
} from './providerModel';
import { createCard } from './srs';
import { pruneDaily } from './stats';
import { clamp, uid } from './utils';

/** v2 数据键。 */
export const STORAGE_KEY = 'deepword:data:v2';
/** v1 旧数据键；迁移后保留，不清除。 */
export const LEGACY_STORAGE_KEY = 'deepword:data:v1';

export const MAX_WORDS = 10_000;
export const MAX_ATTEMPTS = 3_000;

const SRS_STATUSES: SrsStatus[] = ['new', 'learning', 'review', 'mastered'];
const ATTEMPT_GRADES = ['again', 'hard', 'good', 'easy'] as const;
const EXERCISE_TYPES: ExerciseType[] = [
  'choice',
  'fill',
  'spell',
  'translate',
  'sentence',
  'usage',
  'correction',
];
const SKILLS: Skill[] = ['en2zh', 'zh2en', 'spell', 'listen', 'sentence', 'translate'];
const VERDICTS: TranslationVerdict[] = ['perfect', 'good', 'poor'];
const AI_STATUSES = ['ok', 'failed', 'local-fallback'] as const;
const VENDOR_VALUES = VENDOR_OPTIONS.map((item) => item.value);

export function storageAvailable(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const probe = '__deepword_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 基础清洗工具                                                         */
/* ------------------------------------------------------------------ */

function cleanString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function cleanOptionalString(value: unknown): string | undefined {
  const text = cleanString(value);
  return text ? text : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = cleanNumber(value);
  return numeric === undefined ? fallback : clamp(numeric, min, max);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = cleanNumber(value);
  const candidate = numeric === undefined ? fallback : Math.round(numeric);
  return Math.round(clamp(candidate, min, max));
}

function timestamp(value: unknown, fallback: number): number {
  return cleanNumber(value) ?? fallback;
}

function defaultPracticeSettings(): PracticeSettings {
  return { ...DEFAULT_PRACTICE_SETTINGS, tts: { ...DEFAULT_PRACTICE_SETTINGS.tts } };
}

export function seedWordId(term: string): string {
  const slug = term
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `w_seed_${slug || uid('w')}`;
}

function normalizeWordInput(input: WordInput): WordInput | null {
  const term = cleanString(input?.term);
  const meaning = cleanString(input?.meaning);
  if (!term || !meaning) return null;
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((tag) => cleanString(tag)).filter(Boolean))].slice(0, 6)
    : [];
  return {
    term: term.slice(0, 64),
    meaning: meaning.slice(0, 300),
    phonetic: cleanOptionalString(input.phonetic)?.slice(0, 80),
    partOfSpeech: cleanOptionalString(input.partOfSpeech)?.slice(0, 24),
    example: cleanOptionalString(input.example)?.slice(0, 600),
    exampleTranslation: cleanOptionalString(input.exampleTranslation)?.slice(0, 600),
    tags: tags.length > 0 ? tags : undefined,
  };
}

export function makeWord(input: WordInput, options: { id?: string; now?: number } = {}): Word {
  const normalized = normalizeWordInput(input);
  if (!normalized) throw new Error('单词和释义不能为空');
  return {
    id: options.id ?? uid('w'),
    term: normalized.term,
    meaning: normalized.meaning,
    phonetic: normalized.phonetic,
    partOfSpeech: normalized.partOfSpeech,
    example: normalized.example,
    exampleTranslation: normalized.exampleTranslation,
    tags: normalized.tags ?? [],
    createdAt: options.now ?? Date.now(),
  };
}

/** 新建单词输入清洗结果；无效时返回 null。 */
export function normalizeWord(input: WordInput): WordInput | null {
  return normalizeWordInput(input);
}

/* ------------------------------------------------------------------ */
/* 初始数据                                                             */
/* ------------------------------------------------------------------ */

/** 首次使用的初始数据：内置词库 + 1 份默认 provider + 默认练习设置。 */
export function createInitialData(now = Date.now()): AppData {
  const words: Word[] = [];
  const srs: Record<string, SrsCard> = {};
  const seen = new Set<string>();

  for (const seed of SEED_WORDS) {
    const normalized = normalizeWordInput(seed);
    if (!normalized) continue;
    const dedupeKey = normalized.term.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    let id = seedWordId(normalized.term);
    while (words.some((word) => word.id === id)) id = uid('w');
    const word: Word = {
      id,
      term: normalized.term,
      meaning: normalized.meaning,
      phonetic: normalized.phonetic,
      partOfSpeech: normalized.partOfSpeech,
      example: normalized.example,
      exampleTranslation: normalized.exampleTranslation,
      tags: normalized.tags ?? [],
      createdAt: now,
    };
    words.push(word);
    srs[id] = createCard(id, now);
    if (words.length >= MAX_WORDS) break;
  }

  const providers = createInitialProviders(now);

  return {
    version: DATA_VERSION,
    words,
    srs,
    attempts: [],
    mistakes: {},
    providers,
    activeProviderId: providers[0]?.id ?? null,
    practice: defaultPracticeSettings(),
    session: null,
    mastery: {},
    reviewPriority: {},
    theme: 'light',
    stats: { daily: {} },
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* provider 清洗                                                        */
/* ------------------------------------------------------------------ */

/** 单份 provider 清洗；Base URL 为空的配置直接丢弃。 */
function sanitizeProvider(raw: unknown, now: number): ProviderProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<ProviderProfile>;
  const baseUrl = cleanString(source.baseUrl);
  if (!baseUrl) return null;

  const protocol: ProviderKind = source.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const vendor: Vendor = VENDOR_VALUES.includes(source.vendor as Vendor)
    ? (source.vendor as Vendor)
    : inferVendorFromBaseUrl(baseUrl, protocol);
  const models = Array.isArray(source.models)
    ? Array.from(new Set(source.models.map((model) => cleanString(model)).filter(Boolean))).slice(
        0,
        MAX_MODELS_PER_PROVIDER,
      )
    : [];
  const defaultModel = cleanString(source.defaultModel) || models[0] || '';
  const thinkingMode: ThinkingMode =
    source.thinkingMode === 'provider-default' ? 'provider-default' : 'off';

  return {
    id: cleanString(source.id, uid('p')).slice(0, 80),
    name: cleanString(source.name).slice(0, 40),
    protocol,
    vendor,
    baseUrl: baseUrl.slice(0, 400),
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    models,
    defaultModel: defaultModel.slice(0, 200),
    temperature: clampNumber(source.temperature, 0.7, 0, 2),
    maxTokens: Math.round(clampNumber(source.maxTokens, 2_500, 64, 32_000)),
    thinkingMode,
    createdAt: timestamp(source.createdAt, now),
    updatedAt: timestamp(source.updatedAt, now),
  };
}

/** provider 列表清洗：丢弃非法条目、按 id 去重、截断到 MAX_PROVIDERS。 */
function sanitizeProviders(raw: unknown, now: number): ProviderProfile[] {
  if (!Array.isArray(raw)) return [];
  const providers: ProviderProfile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const profile = sanitizeProvider(item, now);
    if (!profile) continue;
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    providers.push(profile);
    if (providers.length >= MAX_PROVIDERS) break;
  }
  return providers;
}

/** activeProviderId 必须存在，否则回退首条；列表为空则 null。 */
function sanitizeActiveProviderId(raw: unknown, providers: ProviderProfile[]): string | null {
  if (typeof raw === 'string' && raw && providers.some((item) => item.id === raw)) return raw;
  return providers[0]?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* 练习设置 / 会话清洗                                                   */
/* ------------------------------------------------------------------ */

function sanitizePractice(raw: unknown): PracticeSettings {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<PracticeSettings>;
  const defaults = DEFAULT_PRACTICE_SETTINGS;

  const newWordsPerRound = clampInt(source.newWordsPerRound, defaults.newWordsPerRound, 1, 10);
  const questionsPerNewWord = clampInt(
    source.questionsPerNewWord,
    defaults.questionsPerNewWord,
    4,
    8,
  );
  const reviewWordsPerRound = clampInt(
    source.reviewWordsPerRound,
    defaults.reviewWordsPerRound,
    1,
    12,
  );
  // 复习题量必须落在 [词数, 2×词数] 区间内。
  const reviewQuestionsPerRound = clampInt(
    source.reviewQuestionsPerRound,
    defaults.reviewQuestionsPerRound,
    reviewWordsPerRound,
    reviewWordsPerRound * 2,
  );
  // 自动跳转：0 = 手动；其余限制在 1000~10000 ms。
  const advanceSource = cleanNumber(source.feedbackAutoAdvanceMs);
  const feedbackAutoAdvanceMs =
    advanceSource === undefined
      ? defaults.feedbackAutoAdvanceMs
      : advanceSource <= 0
        ? 0
        : Math.round(clamp(advanceSource, 1_000, 10_000));

  const ttsSource = (
    source.tts && typeof source.tts === 'object' ? source.tts : {}
  ) as Partial<TtsSettings>;

  return {
    newWordsPerRound,
    questionsPerNewWord,
    reviewWordsPerRound,
    reviewQuestionsPerRound,
    feedbackAutoAdvanceMs,
    autoExplain:
      typeof source.autoExplain === 'boolean' ? source.autoExplain : defaults.autoExplain,
    tts: {
      rate: clampNumber(ttsSource.rate, defaults.tts.rate, 0.5, 2),
      voiceUri: cleanString(ttsSource.voiceUri).slice(0, 400),
      autoPlay: typeof ttsSource.autoPlay === 'boolean' ? ttsSource.autoPlay : defaults.tts.autoPlay,
    },
  };
}

function sanitizeIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const id = cleanString(item).slice(0, 80);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_WORDS) break;
  }
  return result;
}

/** 对外暴露的练习设置清洗：状态层更新设置时复用同一套口径。 */
export function normalizePracticeSettings(raw: unknown): PracticeSettings {
  return sanitizePractice(raw);
}

const MAX_OPTION_COUNT = 4;

/** 会话内的题目清洗（宽松：字段不合法则丢弃整题，交给 UI 重新生成）。 */
function sanitizeSessionQuestion(raw: unknown): Exercise | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Exercise>;
  const wordId = cleanString(source.wordId);
  if (!wordId) return null;
  if (!EXERCISE_TYPES.includes(source.type as ExerciseType)) return null;
  const prompt = cleanString(source.prompt).slice(0, 500);
  if (!prompt) return null;
  const answer = cleanString(source.answer).slice(0, 500);
  if (!answer) return null;
  const options = Array.isArray(source.options)
    ? Array.from(new Set(source.options.map((item) => cleanString(item)).filter(Boolean))).slice(
        0,
        MAX_OPTION_COUNT,
      )
    : [];
  const acceptableAnswers = Array.isArray(source.acceptableAnswers)
    ? Array.from(
        new Set(source.acceptableAnswers.map((item) => cleanString(item)).filter(Boolean)),
      ).slice(0, 8)
    : [];
  return {
    id: cleanString(source.id, uid('ex')).slice(0, 80),
    wordId,
    type: source.type as ExerciseType,
    prompt,
    options: options.length > 0 ? options : undefined,
    answer,
    acceptableAnswers: acceptableAnswers.length > 0 ? acceptableAnswers : undefined,
    explanation: cleanString(source.explanation).slice(0, 400),
    difficulty: clampInt(source.difficulty, 3, 1, 5),
    source: 'local',
    skill: SKILLS.includes(source.skill as Skill) ? (source.skill as Skill) : undefined,
    audio: source.audio === true ? true : undefined,
    direction:
      source.direction === 'en2zh' || source.direction === 'zh2en'
        ? source.direction
        : undefined,
  };
}

/** 会话内的单题作答结果清洗。 */
function sanitizePracticeResult(raw: unknown): PracticeResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<PracticeResult>;
  const wordId = cleanString(source.wordId);
  if (!wordId) return null;
  if (!SKILLS.includes(source.skill as Skill)) return null;
  const prompt = cleanString(source.prompt).slice(0, 500);
  const answer = cleanString(source.answer).slice(0, 500);
  const response = cleanString(source.response).slice(0, 500);
  const latency = cleanNumber(source.latencyMs);
  return {
    questionId: cleanString(source.questionId, uid('ex')).slice(0, 80),
    wordId,
    skill: source.skill as Skill,
    exerciseType: EXERCISE_TYPES.includes(source.exerciseType as ExerciseType)
      ? (source.exerciseType as ExerciseType)
      : 'choice',
    prompt,
    response,
    answer,
    correct: Boolean(source.correct),
    verdict: VERDICTS.includes(source.verdict as TranslationVerdict)
      ? (source.verdict as TranslationVerdict)
      : undefined,
    aiFeedback: cleanOptionalString(source.aiFeedback)?.slice(0, 400),
    aiImprovement: cleanOptionalString(source.aiImprovement)?.slice(0, 400),
    aiStatus: (AI_STATUSES as readonly string[]).includes(source.aiStatus as string)
      ? (source.aiStatus as PracticeResult['aiStatus'])
      : undefined,
    latencyMs: latency === undefined ? undefined : Math.round(clamp(latency, 0, 86_400_000)),
    answeredAt: timestamp(source.answeredAt, Date.now()),
  };
}

function sanitizeSession(raw: unknown, now: number): PracticeSessionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<PracticeSessionState>;
  const stage: PracticeSessionState['stage'] =
    source.stage === 'gate'
      ? 'gate'
      : source.stage === 'review' || source.stage === 'done'
        ? source.stage
        : 'new';
  const answered = Math.max(0, Math.round(cleanNumber(source.answered) ?? 0));
  const targetQuestions = Math.max(0, Math.round(cleanNumber(source.targetQuestions) ?? 0));
  const session: PracticeSessionState = {
    id: cleanString(source.id, uid('s')).slice(0, 80),
    startedAt: timestamp(source.startedAt, now),
    stage,
    newWordIds: sanitizeIdList(source.newWordIds),
    completedNewWordIds: sanitizeIdList(source.completedNewWordIds),
    reviewWordIds: sanitizeIdList(source.reviewWordIds),
    answered,
    targetQuestions,
  };

  // Phase B 可选字段：仅当来源里出现时才写回，保持旧结构（旧备份/旧测试）原样。
  if ('roundNo' in source) {
    const roundNo = cleanNumber(source.roundNo);
    if (roundNo !== undefined) session.roundNo = Math.max(1, Math.round(roundNo));
  }
  if ('gate' in source) {
    session.gate =
      source.gate === 'ask' || source.gate === 'confirm' ? source.gate : null;
  }
  if ('currentWordId' in source) {
    const wordId = cleanString(source.currentWordId).slice(0, 80);
    if (wordId) session.currentWordId = wordId;
  }
  if ('questionIndex' in source) {
    const index = cleanNumber(source.questionIndex);
    if (index !== undefined) session.questionIndex = Math.max(0, Math.round(index));
  }
  if ('questions' in source && Array.isArray(source.questions)) {
    session.questions = source.questions
      .map((item) => sanitizeSessionQuestion(item))
      .filter((item): item is Exercise => item !== null)
      .slice(0, 64);
  }
  if ('results' in source && Array.isArray(source.results)) {
    session.results = source.results
      .map((item) => sanitizePracticeResult(item))
      .filter((item): item is PracticeResult => item !== null)
      .slice(0, 64);
  }
  return session;
}

/** 掌握标记清洗：id 必须存在于词库（调用方按 wordIds 过滤）。 */
function sanitizeMastery(raw: unknown, now: number): Record<string, MasteryRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, MasteryRecord> = {};
  for (const [wordId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const source = value as Partial<MasteryRecord>;
    const id = cleanString(source.wordId, wordId).slice(0, 80);
    if (!id) continue;
    result[wordId] = {
      wordId: id,
      masteredAt: timestamp(source.masteredAt, now),
      source: source.source === 'manual' ? 'manual' : 'rule',
    };
  }
  return result;
}

/** 闪卡「不认识」优先级清洗（值 = 标记时间戳）。 */
function sanitizeReviewPriority(raw: unknown, _now: number): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [wordId, value] of Object.entries(raw as Record<string, unknown>)) {
    const ts = cleanNumber(value);
    if (ts === undefined) continue;
    result[wordId] = Math.max(0, Math.round(ts));
  }
  return result;
}


/* ------------------------------------------------------------------ */
/* 卡片 / 单词 / 作答 / 错题 / 统计清洗                                  */
/* ------------------------------------------------------------------ */

function sanitizeCard(raw: unknown, wordId: string, now: number): SrsCard {
  const source = (raw ?? {}) as Partial<SrsCard>;
  const fallback = createCard(wordId, now);
  const status = SRS_STATUSES.includes(source.status as SrsStatus)
    ? (source.status as SrsStatus)
    : fallback.status;
  const interval =
    typeof source.interval === 'number' && Number.isFinite(source.interval)
      ? clamp(source.interval, 0, 3650)
      : 0;
  return {
    wordId,
    status,
    ease:
      typeof source.ease === 'number' && Number.isFinite(source.ease)
        ? clamp(source.ease, 1.3, 3)
        : fallback.ease,
    interval,
    dueAt:
      typeof source.dueAt === 'number' && Number.isFinite(source.dueAt)
        ? source.dueAt
        : fallback.dueAt,
    reps:
      typeof source.reps === 'number' && Number.isFinite(source.reps)
        ? Math.max(0, Math.round(source.reps))
        : 0,
    lapses:
      typeof source.lapses === 'number' && Number.isFinite(source.lapses)
        ? Math.max(0, Math.round(source.lapses))
        : 0,
    lastReviewedAt:
      typeof source.lastReviewedAt === 'number' && Number.isFinite(source.lastReviewedAt)
        ? source.lastReviewedAt
        : undefined,
  };
}

function sanitizeWord(raw: unknown, now: number): Word | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Word>;
  const normalized = normalizeWordInput(source as WordInput);
  if (!normalized) return null;
  const id = cleanString(source.id, uid('w')).slice(0, 80);
  return {
    id,
    term: normalized.term,
    meaning: normalized.meaning,
    phonetic: normalized.phonetic,
    partOfSpeech: normalized.partOfSpeech,
    example: normalized.example,
    exampleTranslation: normalized.exampleTranslation,
    tags: normalized.tags ?? [],
    createdAt:
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? source.createdAt
        : now,
  };
}

function sanitizeAttempt(raw: unknown, now: number): Attempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Attempt>;
  if (typeof source.wordId !== 'string' || !source.wordId) return null;
  const kind = source.kind === 'exercise' ? 'exercise' : 'flashcard';
  const grade = ATTEMPT_GRADES.includes(source.grade as (typeof ATTEMPT_GRADES)[number])
    ? source.grade
    : undefined;
  const latency = cleanNumber(source.latencyMs);
  const aiFeedback = cleanOptionalString(source.aiFeedback)?.slice(0, 400);
  const aiImprovement = cleanOptionalString(source.aiImprovement)?.slice(0, 400);
  return {
    id: cleanString(source.id, uid('a')),
    wordId: source.wordId,
    kind,
    grade: kind === 'flashcard' ? grade : undefined,
    correct: Boolean(source.correct),
    exerciseType: EXERCISE_TYPES.includes(source.exerciseType as ExerciseType)
      ? source.exerciseType
      : undefined,
    source: source.source === 'llm' || source.source === 'local' ? source.source : undefined,
    skill: SKILLS.includes(source.skill as Skill) ? source.skill : undefined,
    latencyMs: latency === undefined ? undefined : Math.round(clamp(latency, 0, 86_400_000)),
    verdict: VERDICTS.includes(source.verdict as TranslationVerdict) ? source.verdict : undefined,
    aiFeedback,
    aiImprovement,
    aiStatus: (AI_STATUSES as readonly string[]).includes(source.aiStatus as string)
      ? source.aiStatus
      : undefined,
    roundId: cleanOptionalString(source.roundId)?.slice(0, 80),
    createdAt:
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? source.createdAt
        : now,
  };
}

function sanitizeMistake(raw: unknown, wordId: string): Mistake | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Mistake>;
  const now = Date.now();
  const wrongCount =
    typeof source.wrongCount === 'number' && Number.isFinite(source.wrongCount)
      ? Math.max(0, Math.round(source.wrongCount))
      : 0;
  if (wrongCount <= 0) return null;
  return {
    wordId,
    wrongCount,
    correctStreak:
      typeof source.correctStreak === 'number' && Number.isFinite(source.correctStreak)
        ? Math.max(0, Math.round(source.correctStreak))
        : 0,
    firstWrongAt:
      typeof source.firstWrongAt === 'number' && Number.isFinite(source.firstWrongAt)
        ? source.firstWrongAt
        : now,
    lastWrongAt:
      typeof source.lastWrongAt === 'number' && Number.isFinite(source.lastWrongAt)
        ? source.lastWrongAt
        : now,
    lastAttemptAt:
      typeof source.lastAttemptAt === 'number' && Number.isFinite(source.lastAttemptAt)
        ? source.lastAttemptAt
        : now,
    lastExerciseType: EXERCISE_TYPES.includes(source.lastExerciseType as ExerciseType)
      ? source.lastExerciseType
      : undefined,
    lastPrompt: cleanOptionalString(source.lastPrompt)?.slice(0, 300),
  };
}

function sanitizeStats(raw: unknown, now: number): LearningStats {
  const source = (raw ?? {}) as Partial<LearningStats>;
  if (!source.daily || typeof source.daily !== 'object') return { daily: {} };
  const daily: Record<string, DailyStat> = {};
  for (const [key, value] of Object.entries(source.daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
    const entry = value as Partial<DailyStat>;
    daily[key] = {
      reviewed: Math.max(0, Math.round(Number(entry.reviewed) || 0)),
      correct: Math.max(0, Math.round(Number(entry.correct) || 0)),
      wrong: Math.max(0, Math.round(Number(entry.wrong) || 0)),
      learned: Math.max(0, Math.round(Number(entry.learned) || 0)),
    };
  }
  return pruneDaily({ daily }, 400, now);
}

/** 旧数据判定：显式 version 1，或「没有 providers 却带着旧 settings」。 */
function looksLegacy(source: Record<string, unknown>): boolean {
  const hasProviders = Array.isArray(source.providers) && source.providers.length > 0;
  const hasLegacySettings =
    source.settings !== undefined &&
    source.settings !== null &&
    typeof source.settings === 'object';
  return source.version === 1 || (!hasProviders && hasLegacySettings);
}

/**
 * v1 → v2 结构迁移（纯函数，不修改入参）。
 *
 * 只负责字段映射与补默认值；所有字段的类型/范围清洗仍由 `hydrateData` 完成。
 */
export function migrateV1ToV2(raw: unknown, now = Date.now()): AppData {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  let providers: ProviderProfile[];
  if (Array.isArray(source.providers) && source.providers.length > 0) {
    providers = source.providers as ProviderProfile[];
  } else if (
    source.settings &&
    typeof source.settings === 'object' &&
    !Array.isArray(source.settings)
  ) {
    providers = [legacySettingsToProfile(source.settings as LegacyLLMSettings, now)];
  } else {
    providers = [];
  }

  const activeProviderId =
    typeof source.activeProviderId === 'string'
      ? source.activeProviderId
      : (providers[0]?.id ?? null);

  const migrated: Record<string, unknown> = { ...source };
  delete migrated.settings;
  return {
    ...migrated,
    version: DATA_VERSION,
    providers,
    activeProviderId,
    practice: source.practice ?? defaultPracticeSettings(),
    session: (source.session as PracticeSessionState | null | undefined) ?? null,
    mastery: (source.mastery as Record<string, MasteryRecord> | undefined) ?? {},
    reviewPriority: (source.reviewPriority as Record<string, number> | undefined) ?? {},
  } as AppData;
}

/* ------------------------------------------------------------------ */
/* 读取清洗                                                             */
/* ------------------------------------------------------------------ */

/**
 * 把任意来源的对象清洗成 AppData（v2）。用于读取 localStorage 与导入备份。
 * - v1 数据（version===1 或「无 providers 但有 settings」）自动迁移；
 * - 结构性错误（例如 words 类型错误）会抛错，方便导入时提示用户 / 走损坏恢复。
 */
export function hydrateData(
  raw: unknown,
  options: { now?: number; requireWords?: boolean } = {},
): AppData {
  const now = options.now ?? Date.now();
  if (!raw || typeof raw !== 'object') throw new Error('数据格式不正确');
  const source = raw as Record<string, unknown>;

  // 结构存在但类型错误（例如 words: "oops"）说明数据已损坏，必须走损坏恢复流程，
  // 不能静默重置，否则用户会在不知情时丢掉现有进度。
  if (source.words !== undefined && !Array.isArray(source.words)) {
    throw new Error('单词列表格式不正确');
  }

  if (looksLegacy(source)) {
    return hydrateData(migrateV1ToV2(source, now), { now, requireWords: options.requireWords });
  }

  const rawWords = Array.isArray(source.words) ? (source.words as unknown[]) : null;
  if (!rawWords) {
    if (options.requireWords) throw new Error('备份中缺少单词列表');
    return createInitialData(now);
  }

  const words: Word[] = [];
  const seenTerms = new Set<string>();
  const seenIds = new Set<string>();
  for (const item of rawWords.slice(0, MAX_WORDS)) {
    const word = sanitizeWord(item, now);
    if (!word) continue;
    const key = word.term.toLowerCase();
    if (seenTerms.has(key) || seenIds.has(word.id)) continue;
    seenTerms.add(key);
    seenIds.add(word.id);
    words.push(word);
  }

  const srs: Record<string, SrsCard> = {};
  const rawSrs = source.srs as Record<string, unknown> | undefined;
  for (const word of words) {
    srs[word.id] = sanitizeCard(rawSrs?.[word.id], word.id, now);
  }

  const wordIds = new Set(words.map((word) => word.id));

  const attempts: Attempt[] = [];
  if (Array.isArray(source.attempts)) {
    for (const rawAttempt of source.attempts as unknown[]) {
      const attempt = sanitizeAttempt(rawAttempt, now);
      if (attempt && wordIds.has(attempt.wordId)) attempts.push(attempt);
    }
  }
  attempts.sort((a, b) => b.createdAt - a.createdAt);

  const mistakes: Record<string, Mistake> = {};
  if (source.mistakes && typeof source.mistakes === 'object') {
    for (const [wordId, rawMistake] of Object.entries(source.mistakes)) {
      if (!wordIds.has(wordId)) continue;
      const mistake = sanitizeMistake(rawMistake, wordId);
      if (mistake) mistakes[wordId] = mistake;
    }
  }

  const providers = sanitizeProviders(source.providers, now);
  const activeProviderId = sanitizeActiveProviderId(source.activeProviderId, providers);

  const mastery: Record<string, MasteryRecord> = {};
  if (source.mastery && typeof source.mastery === 'object') {
    for (const [wordId, record] of Object.entries(sanitizeMastery(source.mastery, now))) {
      if (!wordIds.has(wordId)) continue;
      mastery[wordId] = record;
    }
  }

  const reviewPriority: Record<string, number> = {};
  if (source.reviewPriority && typeof source.reviewPriority === 'object') {
    for (const [wordId, at] of Object.entries(sanitizeReviewPriority(source.reviewPriority, now))) {
      if (!wordIds.has(wordId)) continue;
      reviewPriority[wordId] = at;
    }
  }

  return {
    version: DATA_VERSION,
    words,
    srs,
    attempts: attempts.slice(0, MAX_ATTEMPTS),
    mistakes,
    providers,
    activeProviderId,
    practice: sanitizePractice(source.practice),
    session: sanitizeSession(source.session, now),
    mastery,
    reviewPriority,
    theme: source.theme === 'dark' ? 'dark' : 'light',
    stats: sanitizeStats(source.stats, now),
    createdAt: timestamp(source.createdAt, now),
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* 本地存储读写                                                         */
/* ------------------------------------------------------------------ */

export interface LoadResult {
  data: AppData;
  warning?: string;
}

function backupCorrupt(storageKey: string, raw: string): void {
  try {
    window.localStorage.setItem(`${storageKey}:corrupt:${Date.now()}`, raw);
  } catch {
    /* 备份失败也不阻塞启动 */
  }
}

/** 从 localStorage 读取数据；优先 v2，缺失时迁移 v1；v2 损坏时备份并降级。 */
export function loadData(now = Date.now()): LoadResult {
  const initial = createInitialData(now);
  if (!storageAvailable()) {
    return { data: initial, warning: '当前浏览器无法使用 localStorage，学习进度将无法保存。' };
  }

  const rawV2 = window.localStorage.getItem(STORAGE_KEY);
  if (rawV2) {
    try {
      const parsed = JSON.parse(rawV2) as unknown;
      const data = hydrateData(parsed, { now });
      if (data.words.length === 0) {
        return {
          data,
          warning: '词库为空，可在「词库」页添加单词或重新载入示例词库。',
        };
      }
      return { data };
    } catch (error) {
      backupCorrupt(STORAGE_KEY, rawV2);
      return {
        data: initial,
        warning: `本地数据读取失败（${error instanceof Error ? error.message : '未知错误'}），已载入示例词库，原数据已尝试备份。`,
      };
    }
  }

  const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacyRaw) {
    try {
      const parsed = JSON.parse(legacyRaw) as unknown;
      const data = hydrateData(parsed, { now });
      // 迁移成功后立即写入 v2；v1 键保留，便于降级排查。
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {
        /* 写满配额时仍返回内存中的迁移结果 */
      }
      if (data.words.length === 0) {
        return {
          data,
          warning: '词库为空，可在「词库」页添加单词或重新载入示例词库。',
        };
      }
      return { data };
    } catch (error) {
      backupCorrupt(LEGACY_STORAGE_KEY, legacyRaw);
      return {
        data: initial,
        warning: `本地数据读取失败（${error instanceof Error ? error.message : '未知错误'}），已载入示例词库，原数据已尝试备份。`,
      };
    }
  }

  return { data: initial };
}

/** 保存到 localStorage（v2 键）。配额满时返回错误信息。 */
export function saveData(data: AppData): { ok: boolean; error?: string } {
  if (!storageAvailable()) return { ok: false, error: '浏览器不支持 localStorage' };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok: true };
  } catch (error) {
    const isQuota =
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      error: isQuota
        ? '本地存储空间已满，请导出备份后清理部分练习记录。'
        : '保存失败，请检查浏览器隐私设置。',
    };
  }
}

/* ------------------------------------------------------------------ */
/* 备份导入导出                                                         */
/* ------------------------------------------------------------------ */

/** 导出备份（默认不含 provider 的 API Key）。 */
export function exportBackup(data: AppData, options: { includeApiKey?: boolean } = {}): string {
  const providers = data.providers.map((profile) =>
    options.includeApiKey ? profile : { ...profile, apiKey: '' },
  );
  return JSON.stringify(
    {
      app: 'deepword',
      scheme: 'deepword-backup',
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      data: { ...data, version: DATA_VERSION, providers },
    },
    null,
    2,
  );
}

/**
 * 解析备份文件：接受 v2/v1 的导出包装，或裸 v1/v2 AppData。
 * v1 数据会自动迁移（由 hydrateData 完成）；缺少单词列表时抛错。
 */
export function parseBackup(raw: string): AppData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('文件不是合法的 JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('备份内容为空或格式不正确');
  const record = parsed as Record<string, unknown>;
  const payload = 'data' in record ? record.data : parsed;
  if (!payload || typeof payload !== 'object') throw new Error('备份中缺少 data 字段');
  return hydrateData(payload, { requireWords: true });
}

/* ------------------------------------------------------------------ */
/* 重置                                                                 */
/* ------------------------------------------------------------------ */

/** 清空进度但保留词库、provider 配置与练习设置；未完成会话置空。 */
export function resetProgress(data: AppData, now = Date.now()): AppData {
  const srs: Record<string, SrsCard> = {};
  for (const word of data.words) srs[word.id] = createCard(word.id, now);
  return {
    ...data,
    srs,
    attempts: [],
    mistakes: {},
    stats: { daily: {} },
    session: null,
    mastery: {},
    reviewPriority: {},
    updatedAt: now,
  };
}

export function resetWordsToSeed(data: AppData, now = Date.now()): AppData {
  const seed = createInitialData(now);
  return {
    ...data,
    words: seed.words,
    srs: seed.srs,
    attempts: [],
    mistakes: {},
    session: null,
    mastery: {},
    reviewPriority: {},
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* 存储用量 / 清理                                                       */
/* ------------------------------------------------------------------ */

/** 估算 localStorage 使用量（v2 键），用于设置页展示。 */
export function getStorageUsage(): { bytes: number; human: string } {
  if (!storageAvailable()) return { bytes: 0, human: '不可用' };
  const raw = window.localStorage.getItem(STORAGE_KEY) ?? '';
  let bytes = raw.length * 2;
  try {
    bytes = new Blob([raw]).size;
  } catch {
    /* ignore */
  }
  const human =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return { bytes, human };
}

/** 清空本地数据：同时删除 v1 与 v2 键。 */
export function clearStoredData(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
