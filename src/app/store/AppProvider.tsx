/**
 * v3 全局状态：AppData + 写操作 + Toast。
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
  MasteryRecord,
  PracticeSessionState,
  PracticeSettings,
  ProviderDraft,
  Skill,
  ThemeMode,
  ToastTone,
  TranslationVerdict,
  WordInput,
} from '@/domain/types';
import { MAX_PROVIDERS } from '@/domain/types';
import { uid } from '@/domain/utils';
import { loadData, normalizeWord, saveData } from '@/infra/storage/storage';
import { appReducer } from './reducer';
import type { AppActions, AppContextValue } from './types';

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp 必须在 AppProvider 中使用');
  return context;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(() => loadData());
  const [data, dispatch] = useReducer(appReducer, boot.data);
  const [toasts, setToasts] = useState<AppContextValue['toasts']>([]);
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

  const warned = useRef(false);
  useEffect(() => {
    if (boot.warning && !warned.current) {
      warned.current = true;
      toast(boot.warning, 'error');
    }
  }, [boot.warning, toast]);

  useEffect(() => {
    document.documentElement.dataset.theme = data.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute('content', data.theme === 'dark' ? '#141512' : '#f4efe3');
  }, [data.theme]);

  const lastStorageError = useRef('');
  const skipInitialPersist = useRef(true);
  useEffect(() => {
    if (skipInitialPersist.current) {
      skipInitialPersist.current = false;
      return;
    }
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

  const recordAttempt = useCallback(
    (result: {
      wordId: string;
      skill: Skill;
      correct: boolean;
      prompt?: string;
      latencyMs?: number;
      verdict?: TranslationVerdict;
      aiFeedback?: string;
      aiImprovement?: string;
      aiStatus?: 'ok' | 'failed' | 'local-fallback';
      roundId?: string;
    }) => {
      dispatch({ type: 'RECORD_ATTEMPT', ...result, now: Date.now() });
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

  const importWords = useCallback((inputs: WordInput[]) => {
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
  }, []);

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

  const actions = useMemo<AppActions>(
    () => ({
      recordAttempt,
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
      toast,
    }),
    [
      recordAttempt,
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
      toast,
    ],
  );

  const value = useMemo<AppContextValue>(
    () => ({ data, actions, toasts, dismissToast }),
    [data, actions, toasts, dismissToast],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
