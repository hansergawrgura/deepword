/**
 * 全局状态：AppData + 所有写操作 + Toast。
 *
 * UI 组件只通过 useApp() 读数据 / 调用 actions，不直接碰 localStorage。
 * actions 会在写操作后自动 toast 并保持数据持久化。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppData,
  ExerciseSource,
  ExerciseType,
  Grade,
  MasteryRecord,
  PracticeSessionState,
  PracticeSettings,
  ProviderDraft,
  ProviderProfile,
  Skill,
  ThemeMode,
  ToastMessage,
  ToastTone,
  TranslationVerdict,
  WordInput,
} from '../types';
import { MAX_MODELS_PER_PROVIDER, MAX_PROVIDERS } from '../types';
import { VENDOR_OPTIONS, inferVendorFromBaseUrl, normalizeAppShape, preserveApiKeys } from '../lib/providerModel';
import {
  createInitialData,
  loadData,
  makeWord,
  normalizePracticeSettings,
  normalizeWord,
  resetProgress,
  saveData,
} from '../lib/storage';
import { evaluateMastery } from '../lib/mastery';
import { createCard, gradeCard, MASTERED_INTERVAL } from '../lib/srs';
import { recordDailyEvent } from '../lib/stats';
import { clamp, uid } from '../lib/utils';

const MAX_ATTEMPTS = 3_000;

type Action =
  | { type: 'GRADE_WORD'; wordId: string; grade: Grade; now: number }
  | {
      type: 'RECORD_EXERCISE';
      wordId: string;
      correct: boolean;
      exerciseType: ExerciseType;
      source: ExerciseSource;
      prompt?: string;
      /** Phase B：技能维度（薄弱分析与掌握判定用）。 */
      skill?: Skill;
      latencyMs?: number;
      verdict?: TranslationVerdict;
      aiFeedback?: string;
      aiImprovement?: string;
      aiStatus?: 'ok' | 'failed' | 'local-fallback';
      /** Phase B：所属学习轮次。 */
      roundId?: string;
      now: number;
    }
  | { type: 'ADD_WORD'; input: WordInput; now: number }
  | { type: 'UPDATE_WORD'; id: string; input: Partial<WordInput> }
  | { type: 'DELETE_WORD'; id: string }
  | { type: 'IMPORT_WORDS'; inputs: WordInput[]; now: number }
  | { type: 'ADD_PROVIDER'; id: string; draft: ProviderDraft; now: number }
  | { type: 'UPDATE_PROVIDER'; id: string; patch: ProviderDraft; now: number }
  | { type: 'DELETE_PROVIDER'; id: string; now: number }
  | { type: 'SET_ACTIVE_PROVIDER'; id: string | null; now: number }
  | { type: 'SET_THEME'; theme: ThemeMode }
  | { type: 'IMPORT_DATA'; data: AppData; now: number }
  | { type: 'RESET_ALL'; now: number }
  | { type: 'CLEAR_PROGRESS'; now: number }
  /* ---- Phase B ---- */
  | { type: 'SET_SESSION'; session: PracticeSessionState | null }
  | { type: 'SET_PRACTICE_SETTINGS'; patch: Partial<PracticeSettings> }
  | { type: 'MARK_MASTERED'; wordId: string; source: MasteryRecord['source']; now: number }
  | { type: 'UNMARK_MASTERED'; wordId: string; now: number }
  | { type: 'FLAG_REVIEW_PRIORITY'; wordId: string; now: number }
  | { type: 'CLEAR_REVIEW_PRIORITY'; wordId: string };

function ensureCard(data: AppData, wordId: string, now: number) {
  return data.srs[wordId] ?? createCard(wordId, now);
}

function registerWrong(
  data: AppData,
  wordId: string,
  now: number,
  exerciseType?: ExerciseType,
  prompt?: string,
) {
  const existing = data.mistakes[wordId];
  return {
    wordId,
    wrongCount: (existing?.wrongCount ?? 0) + 1,
    correctStreak: 0,
    firstWrongAt: existing?.firstWrongAt ?? now,
    lastWrongAt: now,
    lastAttemptAt: now,
    lastExerciseType: exerciseType ?? existing?.lastExerciseType,
    lastPrompt: prompt ?? existing?.lastPrompt,
  };
}

function registerCorrect(data: AppData, wordId: string, now: number) {
  const existing = data.mistakes[wordId];
  if (!existing) return undefined;
  return {
    ...existing,
    correctStreak: existing.correctStreak + 1,
    lastAttemptAt: now,
  };
}

function pushAttempt(data: AppData, attempt: AppData['attempts'][number]): AppData['attempts'] {
  return [attempt, ...data.attempts].slice(0, MAX_ATTEMPTS);
}

function withWordsData(data: AppData, words: AppData['words'], now: number): AppData {
  const srs = { ...data.srs };
  for (const word of words) {
    if (!srs[word.id]) srs[word.id] = createCard(word.id, now);
  }
  return { ...data, words, srs };
}

const VENDOR_VALUES = VENDOR_OPTIONS.map((item) => item.value);

/** 清洗 provider 草稿：保证字段类型、范围、去重都合规。 */
function cleanProviderDraft(draft: ProviderDraft, base?: ProviderProfile): ProviderDraft {
  const protocol = draft.protocol === 'anthropic' ? 'anthropic' : 'openai';
  const baseUrl = draft.baseUrl.trim();
  const vendor = VENDOR_VALUES.includes(draft.vendor)
    ? draft.vendor
    : inferVendorFromBaseUrl(baseUrl, protocol);
  const models = Array.isArray(draft.models)
    ? Array.from(new Set(draft.models.map((model) => model.trim()).filter(Boolean))).slice(
        0,
        MAX_MODELS_PER_PROVIDER,
      )
    : [];
  return {
    name: (draft.name ?? base?.name ?? '').trim().slice(0, 40),
    protocol,
    vendor,
    baseUrl,
    apiKey: typeof draft.apiKey === 'string' ? draft.apiKey : '',
    models,
    defaultModel: (draft.defaultModel ?? '').trim(),
    temperature: clamp(Number(draft.temperature) || 0.7, 0, 2),
    maxTokens: Math.round(clamp(Number(draft.maxTokens) || 2_500, 64, 32_000)),
    thinkingMode: draft.thinkingMode === 'provider-default' ? 'provider-default' : 'off',
  };
}

function reducer(data: AppData, action: Action): AppData {
  switch (action.type) {
    case 'GRADE_WORD': {
      const card = ensureCard(data, action.wordId, action.now);
      const wasNew = card.status === 'new';
      const nextCard = gradeCard(card, action.grade, action.now);
      const isCorrect = action.grade !== 'again';
      const attempt = {
        id: uid('a'),
        wordId: action.wordId,
        kind: 'flashcard' as const,
        grade: action.grade,
        correct: isCorrect,
        createdAt: action.now,
      };
      const mistakes = { ...data.mistakes };
      if (action.grade === 'again') {
        mistakes[action.wordId] = registerWrong(data, action.wordId, action.now);
      } else if (action.grade !== 'hard') {
        const updated = registerCorrect(data, action.wordId, action.now);
        if (updated) mistakes[action.wordId] = updated;
      }
      return {
        ...data,
        srs: { ...data.srs, [action.wordId]: nextCard },
        attempts: pushAttempt(data, attempt),
        mistakes,
        stats: recordDailyEvent(data.stats, {
          now: action.now,
          correct: isCorrect,
          learned: wasNew,
        }),
        updatedAt: action.now,
      };
    }

    case 'RECORD_EXERCISE': {
      if (!data.words.some((word) => word.id === action.wordId)) return data;
      const card = ensureCard(data, action.wordId, action.now);
      const nextCard = gradeCard(card, action.correct ? 'good' : 'again', action.now);
      const attempt = {
        id: uid('a'),
        wordId: action.wordId,
        kind: 'exercise' as const,
        correct: action.correct,
        exerciseType: action.exerciseType,
        source: action.source,
        skill: action.skill,
        latencyMs: action.latencyMs,
        verdict: action.verdict,
        aiFeedback: action.aiFeedback,
        aiImprovement: action.aiImprovement,
        aiStatus: action.aiStatus,
        roundId: action.roundId,
        createdAt: action.now,
      };
      const mistakes = { ...data.mistakes };
      if (action.correct) {
        const updated = registerCorrect(data, action.wordId, action.now);
        if (updated) mistakes[action.wordId] = updated;
      } else {
        mistakes[action.wordId] = registerWrong(
          data,
          action.wordId,
          action.now,
          action.exerciseType,
          action.prompt,
        );
      }

      const attempts = pushAttempt(data, attempt);
      // 掌握判定：满足规则则自动标记掌握（永久不再学习与复习）。
      const mastery = { ...(data.mastery ?? {}) };
      if (!mastery[action.wordId]) {
        const check = evaluateMastery({ ...data, attempts }, action.wordId, action.now);
        if (check.eligible) {
          mastery[action.wordId] = {
            wordId: action.wordId,
            masteredAt: action.now,
            source: 'rule',
          };
        }
      }
      const mastered = Boolean(mastery[action.wordId]);
      const srs = mastered
        ? {
            ...data.srs,
            [action.wordId]: {
              ...nextCard,
              status: 'mastered' as const,
              interval: Math.max(nextCard.interval, MASTERED_INTERVAL),
              dueAt: action.now + MASTERED_INTERVAL * 86_400_000,
            },
          }
        : { ...data.srs, [action.wordId]: nextCard };

      return {
        ...data,
        srs,
        attempts,
        mistakes,
        mastery,
        stats: recordDailyEvent(data.stats, { now: action.now, correct: action.correct }),
        updatedAt: action.now,
      };
    }

    case 'ADD_WORD': {
      let word;
      try {
        word = makeWord(action.input, { now: action.now });
      } catch {
        return data;
      }
      return {
        ...withWordsData(data, [...data.words, word], action.now),
        updatedAt: action.now,
      };
    }

    case 'UPDATE_WORD': {
      const target = data.words.find((word) => word.id === action.id);
      if (!target) return data;
      const normalized = normalizeWord({
        term: action.input.term ?? target.term,
        meaning: action.input.meaning ?? target.meaning,
        phonetic: action.input.phonetic ?? target.phonetic,
        partOfSpeech: action.input.partOfSpeech ?? target.partOfSpeech,
        example: action.input.example ?? target.example,
        exampleTranslation: action.input.exampleTranslation ?? target.exampleTranslation,
        tags: action.input.tags ?? target.tags,
      });
      if (!normalized) return data;
      const words = data.words.map((word) =>
        word.id === action.id
          ? {
              ...word,
              term: normalized.term,
              meaning: normalized.meaning,
              phonetic: normalized.phonetic,
              partOfSpeech: normalized.partOfSpeech,
              example: normalized.example,
              exampleTranslation: normalized.exampleTranslation,
              tags: normalized.tags ?? [],
            }
          : word,
      );
      return { ...data, words, updatedAt: Date.now() };
    }

    case 'DELETE_WORD': {
      return {
        ...data,
        words: data.words.filter((word) => word.id !== action.id),
        srs: Object.fromEntries(
          Object.entries(data.srs).filter(([wordId]) => wordId !== action.id),
        ),
        mistakes: Object.fromEntries(
          Object.entries(data.mistakes).filter(([wordId]) => wordId !== action.id),
        ),
        attempts: data.attempts.filter((attempt) => attempt.wordId !== action.id),
        updatedAt: Date.now(),
      };
    }

    case 'IMPORT_WORDS': {
      const existingTerms = new Set(data.words.map((word) => word.term.toLowerCase()));
      const created: AppData['words'] = [];
      for (const input of action.inputs) {
        const normalized = normalizeWord(input);
        if (!normalized) continue;
        if (existingTerms.has(normalized.term.toLowerCase())) continue;
        existingTerms.add(normalized.term.toLowerCase());
        try {
          created.push(makeWord(normalized, { now: action.now }));
        } catch {
          continue;
        }
        if (data.words.length + created.length >= 10_000) break;
      }
      if (created.length === 0) return data;
      return {
        ...withWordsData(data, [...data.words, ...created], action.now),
        updatedAt: action.now,
      };
    }

    case 'ADD_PROVIDER': {
      if (data.providers.length >= MAX_PROVIDERS) return data;
      const clean = cleanProviderDraft(action.draft);
      const profile: ProviderProfile = {
        ...clean,
        id: action.id,
        createdAt: action.now,
        updatedAt: action.now,
      };
      return {
        ...data,
        providers: [...data.providers, profile],
        activeProviderId: data.activeProviderId ?? profile.id,
        updatedAt: action.now,
      };
    }

    case 'UPDATE_PROVIDER': {
      const current = data.providers.find((item) => item.id === action.id);
      if (!current) return data;
      const clean = cleanProviderDraft(action.patch, current);
      return {
        ...data,
        providers: data.providers.map((item) =>
          item.id === action.id ? { ...item, ...clean, updatedAt: action.now } : item,
        ),
        updatedAt: action.now,
      };
    }

    case 'DELETE_PROVIDER': {
      if (!data.providers.some((item) => item.id === action.id)) return data;
      const providers = data.providers.filter((item) => item.id !== action.id);
      const activeProviderId =
        data.activeProviderId === action.id ? (providers[0]?.id ?? null) : data.activeProviderId;
      return { ...data, providers, activeProviderId, updatedAt: action.now };
    }

    case 'SET_ACTIVE_PROVIDER': {
      const activeProviderId =
        action.id && data.providers.some((item) => item.id === action.id)
          ? action.id
          : (data.providers[0]?.id ?? null);
      return { ...data, activeProviderId, updatedAt: action.now };
    }

    case 'SET_THEME':
      return { ...data, theme: action.theme };

    /* -------------------------- Phase B -------------------------- */

    case 'SET_SESSION':
      return { ...data, session: action.session };

    case 'SET_PRACTICE_SETTINGS': {
      const patch = action.patch ?? {};
      const next: PracticeSettings = normalizePracticeSettings({
        ...data.practice,
        ...patch,
        tts: { ...data.practice.tts, ...(patch.tts ?? {}) },
      });
      return { ...data, practice: next, updatedAt: Date.now() };
    }

    case 'MARK_MASTERED': {
      if (!data.words.some((word) => word.id === action.wordId)) return data;
      const mastery = { ...(data.mastery ?? {}) };
      mastery[action.wordId] = {
        wordId: action.wordId,
        masteredAt: action.now,
        source: action.source,
      };
      const card = ensureCard(data, action.wordId, action.now);
      const reviewPriority = { ...(data.reviewPriority ?? {}) };
      delete reviewPriority[action.wordId];
      return {
        ...data,
        mastery,
        reviewPriority,
        srs: {
          ...data.srs,
          [action.wordId]: {
            ...card,
            status: 'mastered',
            interval: Math.max(card.interval, MASTERED_INTERVAL),
            dueAt: action.now + MASTERED_INTERVAL * 86_400_000,
          },
        },
        updatedAt: action.now,
      };
    }

    case 'UNMARK_MASTERED': {
      const mastery = { ...(data.mastery ?? {}) };
      if (!mastery[action.wordId]) return data;
      delete mastery[action.wordId];
      const card = ensureCard(data, action.wordId, action.now);
      return {
        ...data,
        mastery,
        srs: {
          ...data.srs,
          [action.wordId]: {
            ...card,
            status: card.reps > 0 ? 'review' : 'new',
            interval: 0,
            dueAt: action.now,
          },
        },
        updatedAt: action.now,
      };
    }

    case 'FLAG_REVIEW_PRIORITY': {
      if (!data.words.some((word) => word.id === action.wordId)) return data;
      const reviewPriority = { ...(data.reviewPriority ?? {}) };
      reviewPriority[action.wordId] = action.now;
      return { ...data, reviewPriority, updatedAt: action.now };
    }

    case 'CLEAR_REVIEW_PRIORITY': {
      const reviewPriority = { ...(data.reviewPriority ?? {}) };
      if (!(action.wordId in reviewPriority)) return data;
      delete reviewPriority[action.wordId];
      return { ...data, reviewPriority, updatedAt: Date.now() };
    }

    case 'IMPORT_DATA': {
      const next = normalizeAppShape(action.data);
      const providers = preserveApiKeys(next.providers, data.providers);
      return { ...next, providers, updatedAt: action.now };
    }

    case 'RESET_ALL': {
      // 重置词库与进度，但保留用户已经配置好的 provider 与主题
      const fresh = createInitialData(action.now);
      return {
        ...fresh,
        providers: data.providers,
        activeProviderId: data.activeProviderId,
        practice: data.practice,
        theme: data.theme,
      };
    }

    case 'CLEAR_PROGRESS': {
      const next = resetProgress(data, action.now);
      return { ...next, stats: { daily: {} } };
    }

    default:
      return data;
  }
}

export interface AppActions {
  gradeWord: (wordId: string, grade: Grade) => void;
  recordExercise: (result: {
    wordId: string;
    correct: boolean;
    exerciseType: ExerciseType;
    source: ExerciseSource;
    prompt?: string;
    /** Phase B：技能维度（薄弱分析、掌握判定）。 */
    skill?: Skill;
    latencyMs?: number;
    verdict?: TranslationVerdict;
    aiFeedback?: string;
    aiImprovement?: string;
    aiStatus?: 'ok' | 'failed' | 'local-fallback';
    /** Phase B：所属学习轮次。 */
    roundId?: string;
  }) => void;
  addWord: (input: WordInput) => { ok: boolean; message: string };
  updateWord: (id: string, input: Partial<WordInput>) => { ok: boolean; message: string };
  deleteWord: (id: string) => void;
  importWords: (inputs: WordInput[]) => { added: number; skipped: number };
  addProvider: (draft: ProviderDraft) => { ok: boolean; message: string; id?: string };
  updateProvider: (id: string, draft: ProviderDraft) => void;
  deleteProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  importBackup: (data: AppData) => void;
  resetAll: () => void;
  clearProgress: () => void;
  /* ---- Phase B ---- */
  /** 写回当前一轮练习的进度（退出后可恢复）。 */
  setPracticeSession: (session: PracticeSessionState | null) => void;
  /** 局部更新练习设置（设置页即时生效）。 */
  setPracticeSettings: (patch: Partial<PracticeSettings>) => void;
  /** 标记掌握：source='manual' 为闪卡闸门确认，'rule' 为规则自动判定。 */
  markMastered: (wordId: string, source?: MasteryRecord['source']) => void;
  /** 取消掌握：词回到可复习状态。 */
  unmarkMastered: (wordId: string) => void;
  /** 闪卡「不认识」：排入下一轮复习优先。 */
  flagReviewPriority: (wordId: string) => void;
  clearReviewPriority: (wordId: string) => void;
  toast: (message: string, tone?: ToastTone) => void;
}

export interface AppContextValue {
  data: AppData;
  actions: AppActions;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp 必须在 AppProvider 中使用');
  return context;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(() => loadData());
  const [data, dispatch] = useReducer(reducer, boot.data);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const dataRef = useRef(data);
  dataRef.current = data;

  const toastTimers = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = uid('toast');
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      const timer = window.setTimeout(
        () => {
          setToasts((current) => current.filter((item) => item.id !== id));
          toastTimers.current.delete(id);
        },
        tone === 'error' ? 5_500 : 3_200,
      );
      toastTimers.current.set(id, timer);
    },
    [],
  );

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // 启动时若有读取警告，提示一次
  const warned = useRef(false);
  useEffect(() => {
    if (boot.warning && !warned.current) {
      warned.current = true;
      toast(boot.warning, 'error');
    }
  }, [boot.warning, toast]);

  // 主题
  useEffect(() => {
    document.documentElement.dataset.theme = data.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', data.theme === 'dark' ? '#141512' : '#f4efe3');
  }, [data.theme]);

  // 持久化（防抖），以及关闭页面前的兜底保存
  const lastStorageError = useRef('');
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const result = saveData(data);
      if (!result.ok && result.error && result.error !== lastStorageError.current) {
        lastStorageError.current = result.error;
        toast(result.error, 'error');
      }
      if (result.ok) lastStorageError.current = '';
    }, 250);
    return () => window.clearTimeout(handle);
  }, [data, toast]);

  useEffect(() => {
    const flush = () => saveData(dataRef.current);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 定期修剪旧统计在读取数据时完成（见 storage.hydrateData），此处不需要额外副作用

  const gradeWord = useCallback((wordId: string, grade: Grade) => {
    dispatch({ type: 'GRADE_WORD', wordId, grade, now: Date.now() });
  }, []);

  const recordExercise = useCallback(
    (result: {
      wordId: string;
      correct: boolean;
      exerciseType: ExerciseType;
      source: ExerciseSource;
      prompt?: string;
      skill?: Skill;
      latencyMs?: number;
      verdict?: TranslationVerdict;
      aiFeedback?: string;
      aiImprovement?: string;
      aiStatus?: 'ok' | 'failed' | 'local-fallback';
      roundId?: string;
    }) => {
      dispatch({ type: 'RECORD_EXERCISE', ...result, now: Date.now() });
    },
    [],
  );

  const addWord = useCallback(
    (input: WordInput) => {
      const normalized = normalizeWord(input);
      if (!normalized) return { ok: false, message: '单词和释义不能为空' };
      const duplicate = dataRef.current.words.some(
        (word) => word.term.toLowerCase() === normalized.term.toLowerCase(),
      );
      if (duplicate) return { ok: false, message: `「${normalized.term}」已经在词库中` };
      dispatch({ type: 'ADD_WORD', input: normalized, now: Date.now() });
      toast(`已加入「${normalized.term}」`, 'success');
      return { ok: true, message: '已添加' };
    },
    [toast],
  );

  const updateWord = useCallback(
    (id: string, input: Partial<WordInput>) => {
      const target = dataRef.current.words.find((word) => word.id === id);
      if (!target) return { ok: false, message: '单词不存在' };
      const term = input.term ?? target.term;
      const duplicate = dataRef.current.words.some(
        (word) => word.id !== id && word.term.toLowerCase() === term.trim().toLowerCase(),
      );
      if (duplicate) return { ok: false, message: `「${term}」已经在词库中` };
      dispatch({ type: 'UPDATE_WORD', id, input });
      toast('修改已保存', 'success');
      return { ok: true, message: '已保存' };
    },
    [toast],
  );

  const deleteWord = useCallback(
    (id: string) => {
      const word = dataRef.current.words.find((item) => item.id === id);
      dispatch({ type: 'DELETE_WORD', id });
      toast(word ? `已删除「${word.term}」` : '已删除', 'success');
    },
    [toast],
  );

  const importWords = useCallback(
    (inputs: WordInput[]) => {
      const existing = new Set(dataRef.current.words.map((word) => word.term.toLowerCase()));
      const accepted: WordInput[] = [];
      let skipped = 0;
      for (const input of inputs) {
        const normalized = normalizeWord(input);
        if (!normalized) {
          skipped += 1;
          continue;
        }
        const key = normalized.term.toLowerCase();
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }
        existing.add(key);
        accepted.push(normalized);
      }
      if (accepted.length > 0) {
        dispatch({ type: 'IMPORT_WORDS', inputs: accepted, now: Date.now() });
      }
      return { added: accepted.length, skipped };
    },
    [],
  );

  const addProvider = useCallback(
    (draft: ProviderDraft) => {
      if (dataRef.current.providers.length >= MAX_PROVIDERS) {
        return { ok: false, message: `最多保存 ${MAX_PROVIDERS} 份配置` };
      }
      if (!draft.defaultModel.trim()) return { ok: false, message: '请填写默认模型' };
      const id = uid('p');
      dispatch({ type: 'ADD_PROVIDER', id, draft, now: Date.now() });
      toast('模型配置已保存', 'success');
      return { ok: true, message: '已保存', id };
    },
    [toast],
  );

  const updateProvider = useCallback((id: string, draft: ProviderDraft) => {
    dispatch({ type: 'UPDATE_PROVIDER', id, patch: draft, now: Date.now() });
  }, []);

  const deleteProvider = useCallback(
    (id: string) => {
      const current = dataRef.current.providers.find((item) => item.id === id);
      dispatch({ type: 'DELETE_PROVIDER', id, now: Date.now() });
      toast(current ? `已删除「${current.name}」` : '配置已删除', 'success');
    },
    [toast],
  );

  const setActiveProvider = useCallback((id: string | null) => {
    dispatch({ type: 'SET_ACTIVE_PROVIDER', id, now: Date.now() });
  }, []);

  const setTheme = useCallback((theme: ThemeMode) => {
    dispatch({ type: 'SET_THEME', theme });
  }, []);

  const importBackup = useCallback(
    (next: AppData) => {
      // Key 继承在 reducer 内按 Base URL 匹配；备份里带了非空 Key 时以备份为准。
      dispatch({ type: 'IMPORT_DATA', data: next, now: Date.now() });
      toast('备份已导入', 'success');
    },
    [toast],
  );

  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL', now: Date.now() });
    toast('已恢复初始示例数据', 'success');
  }, [toast]);

  const clearProgress = useCallback(() => {
    dispatch({ type: 'CLEAR_PROGRESS', now: Date.now() });
    toast('学习进度已清空，词库与设置保留', 'success');
  }, [toast]);

  /* -------------------------- Phase B -------------------------- */

  const setPracticeSession = useCallback((session: PracticeSessionState | null) => {
    dispatch({ type: 'SET_SESSION', session });
  }, []);

  const setPracticeSettings = useCallback((patch: Partial<PracticeSettings>) => {
    dispatch({ type: 'SET_PRACTICE_SETTINGS', patch });
  }, []);

  const markMastered = useCallback(
    (wordId: string, source: MasteryRecord['source'] = 'manual') => {
      dispatch({ type: 'MARK_MASTERED', wordId, source, now: Date.now() });
    },
    [],
  );

  const unmarkMastered = useCallback((wordId: string) => {
    dispatch({ type: 'UNMARK_MASTERED', wordId, now: Date.now() });
  }, []);

  const flagReviewPriority = useCallback((wordId: string) => {
    dispatch({ type: 'FLAG_REVIEW_PRIORITY', wordId, now: Date.now() });
  }, []);

  const clearReviewPriority = useCallback((wordId: string) => {
    dispatch({ type: 'CLEAR_REVIEW_PRIORITY', wordId });
  }, []);

  const actions = useMemo<AppActions>(
    () => ({
      gradeWord,
      recordExercise,
      addWord,
      updateWord,
      deleteWord,
      importWords,
      addProvider,
      updateProvider,
      deleteProvider,
      setActiveProvider,
      setTheme,
      importBackup,
      resetAll,
      clearProgress,
      setPracticeSession,
      setPracticeSettings,
      markMastered,
      unmarkMastered,
      flagReviewPriority,
      clearReviewPriority,
      toast,
    }),
    [
      gradeWord,
      recordExercise,
      addWord,
      updateWord,
      deleteWord,
      importWords,
      addProvider,
      updateProvider,
      deleteProvider,
      setActiveProvider,
      setTheme,
      importBackup,
      resetAll,
      clearProgress,
      setPracticeSession,
      setPracticeSettings,
      markMastered,
      unmarkMastered,
      flagReviewPriority,
      clearReviewPriority,
      toast,
    ],
  );

  const value = useMemo<AppContextValue>(
    () => ({ data, actions, toasts, dismissToast }),
    [data, actions, toasts, dismissToast],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

