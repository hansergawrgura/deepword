/**
 * localStorage 持久化层。
 *
 * - 首次打开：用内置词库生成初始数据；
 * - 读取时做完整的字段清洗与兜底，损坏数据会备份后重建；
 * - 导入/导出使用带元信息的 JSON；默认导出不含 API Key；
 * - 所有写入都可能因配额失败，调用方需处理 { ok: false }。
 */

import { SEED_WORDS } from '../data/wordbank';
import type {
  AppData,
  Attempt,
  DailyStat,
  LearningStats,
  LLMSettings,
  Mistake,
  SrsCard,
  SrsStatus,
  Word,
  WordInput,
} from '../types';
import { DATA_VERSION } from '../types';
import { createCard } from './srs';
import { clamp, uid } from './utils';
import { pruneDaily } from './stats';

export const STORAGE_KEY = 'deepword:data:v1';
export const MAX_WORDS = 10_000;
export const MAX_ATTEMPTS = 3_000;

export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2_500,
};

export const PROVIDER_PRESETS = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '适用于 OpenAI、DeepSeek、Moonshot、硅基流动、Ollama 等兼容 /chat/completions 的服务',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    hint: '使用 Anthropic Messages API，浏览器直连会自动添加所需请求头',
  },
} as const;

const SRS_STATUSES: SrsStatus[] = ['new', 'learning', 'review', 'mastered'];
const ATTEMPT_GRADES = ['again', 'hard', 'good', 'easy'] as const;
const EXERCISE_TYPES = ['choice', 'fill', 'usage', 'correction'] as const;

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

function cleanString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function cleanOptionalString(value: unknown): string | undefined {
  const text = cleanString(value);
  return text ? text : undefined;
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

/** 首次使用的初始数据：内置词库 + 空学习记录。 */
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

  return {
    version: DATA_VERSION,
    words,
    srs,
    attempts: [],
    mistakes: {},
    settings: { ...DEFAULT_LLM_SETTINGS },
    theme: 'light',
    stats: { daily: {} },
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizeSettings(raw: unknown): LLMSettings {
  const source = (raw ?? {}) as Partial<LLMSettings>;
  const provider = source.provider === 'anthropic' ? 'anthropic' : 'openai';
  const preset = PROVIDER_PRESETS[provider];
  return {
    provider,
    baseUrl: cleanString(source.baseUrl) || preset.baseUrl,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey : '',
    model: cleanString(source.model) || preset.model,
    temperature:
      typeof source.temperature === 'number' && Number.isFinite(source.temperature)
        ? clamp(source.temperature, 0, 2)
        : DEFAULT_LLM_SETTINGS.temperature,
    maxTokens:
      typeof source.maxTokens === 'number' && Number.isFinite(source.maxTokens)
        ? Math.round(clamp(source.maxTokens, 64, 32_000))
        : DEFAULT_LLM_SETTINGS.maxTokens,
  };
}

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

function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Attempt>;
  if (typeof source.wordId !== 'string' || !source.wordId) return null;
  const kind = source.kind === 'exercise' ? 'exercise' : 'flashcard';
  const grade = ATTEMPT_GRADES.includes(source.grade as (typeof ATTEMPT_GRADES)[number])
    ? source.grade
    : undefined;
  return {
    id: cleanString(source.id, uid('a')),
    wordId: source.wordId,
    kind,
    grade: kind === 'flashcard' ? grade : undefined,
    correct: Boolean(source.correct),
    exerciseType: EXERCISE_TYPES.includes(source.exerciseType as never)
      ? source.exerciseType
      : undefined,
    source: source.source === 'llm' || source.source === 'local' ? source.source : undefined,
    createdAt:
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? source.createdAt
        : Date.now(),
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
    lastExerciseType: EXERCISE_TYPES.includes(source.lastExerciseType as never)
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

/**
 * 把任意来源的对象清洗成 AppData。用于读取 localStorage 与导入备份。
 * 结构性错误会抛错，方便导入时提示用户。
 */
export function hydrateData(
  raw: unknown,
  options: { now?: number; requireWords?: boolean } = {},
): AppData {
  const now = options.now ?? Date.now();
  if (!raw || typeof raw !== 'object') throw new Error('数据格式不正确');
  const source = raw as Partial<AppData>;

  // 结构存在但类型错误（例如 words: "oops"）说明数据已损坏，必须走损坏恢复流程，
  // 不能静默重置，否则用户会在不知情时丢掉现有进度。
  if (source.words !== undefined && !Array.isArray(source.words)) {
    throw new Error('单词列表格式不正确');
  }

  const rawWords = Array.isArray(source.words) ? source.words : null;
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
  for (const word of words) {
    srs[word.id] = sanitizeCard(
      (source.srs as Record<string, unknown> | undefined)?.[word.id],
      word.id,
      now,
    );
  }

  const wordIds = new Set(words.map((word) => word.id));

  const attempts: Attempt[] = [];
  if (Array.isArray(source.attempts)) {
    for (const rawAttempt of source.attempts) {
      const attempt = sanitizeAttempt(rawAttempt);
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

  return {
    version: DATA_VERSION,
    words,
    srs,
    attempts: attempts.slice(0, MAX_ATTEMPTS),
    mistakes,
    settings: sanitizeSettings(source.settings),
    theme: source.theme === 'dark' ? 'dark' : 'light',
    stats: sanitizeStats(source.stats, now),
    createdAt:
      typeof source.createdAt === 'number' && Number.isFinite(source.createdAt)
        ? source.createdAt
        : now,
    updatedAt: now,
  };
}

export interface LoadResult {
  data: AppData;
  warning?: string;
}

/** 从 localStorage 读取数据；损坏时备份原始内容并重建示例数据。 */
export function loadData(now = Date.now()): LoadResult {
  const initial = createInitialData(now);
  if (!storageAvailable()) {
    return { data: initial, warning: '当前浏览器无法使用 localStorage，学习进度将无法保存。' };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return { data: initial };

  try {
    const parsed = JSON.parse(raw) as unknown;
    const data = hydrateData(parsed, { now });
    if (data.words.length === 0) {
      return {
        data,
        warning: '词库为空，可在「词库」页添加单词或重新载入示例词库。',
      };
    }
    return { data };
  } catch (error) {
    try {
      window.localStorage.setItem(`${STORAGE_KEY}:corrupt:${Date.now()}`, raw);
    } catch {
      /* 备份失败也不阻塞启动 */
    }
    return {
      data: initial,
      warning: `本地数据读取失败（${error instanceof Error ? error.message : '未知错误'}），已载入示例词库，原数据已尝试备份。`,
    };
  }
}

/** 保存到 localStorage。配额满时返回错误信息。 */
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

/** 导出备份（默认不含 API Key）。 */
export function exportBackup(data: AppData, options: { includeApiKey?: boolean } = {}): string {
  const settings = options.includeApiKey
    ? data.settings
    : { ...data.settings, apiKey: '' };
  return JSON.stringify(
    {
      app: 'deepword',
      scheme: 'deepword-backup',
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      data: { ...data, settings },
    },
    null,
    2,
  );
}

/** 解析备份文件，接受「导出包装」或裸 AppData 两种格式。 */
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

/** 清空进度但保留词库与设置。 */
export function resetProgress(data: AppData, now = Date.now()): AppData {
  const srs: Record<string, SrsCard> = {};
  for (const word of data.words) srs[word.id] = createCard(word.id, now);
  return {
    ...data,
    srs,
    attempts: [],
    mistakes: {},
    stats: { daily: {} },
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
    updatedAt: now,
  };
}

/** 估算 localStorage 使用量，用于设置页展示。 */
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

export function clearStoredData(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
