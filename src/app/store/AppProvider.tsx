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
  AppLocale,
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
import { createT, I18nProvider, normalizeLocale } from '@/i18n';
import { loadData, normalizeWord, saveData } from '@/infra/storage/storage';
import { appReducer } from './reducer';
import type { AppActions, AppContextValue } from './types';

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [boot] = useState(() => loadData());
  const [data, dispatch] = useReducer(appReducer, boot.data);
  const [toasts, setToasts] = useState<AppContextValue['toasts']>([]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const locale = normalizeLocale(data.locale);
  const t = useMemo(() => createT(locale), [locale]);
  const tRef = useRef(t);
  tRef.current = t;

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
      const tr = tRef.current;
      const normalized = normalizeWord(input);
      if (!normalized) return { ok: false, message: tr('actions.wordRequired') };
      const duplicate = dataRef.current.words.some(
        (word) => word.term.toLowerCase() === normalized.term.toLowerCase(),
      );
      if (duplicate) return { ok: false, message: tr('actions.duplicateWord', { term: normalized.term }) };
      dispatch({ type: 'ADD_WORD', input: normalized, now: Date.now() });
      toast(tr('actions.wordAdded', { term: normalized.term }), 'success');
      return { ok: true, message: tr('actions.wordAdded', { term: normalized.term }) };
    },
    [toast],
  );

  const updateWord = useCallback(
    (id: string, input: Partial<WordInput>) => {
      const tr = tRef.current;
      const target = dataRef.current.words.find((word) => word.id === id);
      if (!target) return { ok: false, message: tr('actions.wordNotFound') };
      const term = input.term ?? target.term;
      const duplicate = dataRef.current.words.some(
        (word) => word.id !== id && word.term.toLowerCase() === term.trim().toLowerCase(),
      );
      if (duplicate) return { ok: false, message: tr('actions.duplicateWord', { term }) };
      dispatch({ type: 'UPDATE_WORD', id, input });
      toast(tr('actions.wordSaved'), 'success');
      return { ok: true, message: tr('actions.wordSaved') };
    },
    [toast],
  );

  const deleteWord = useCallback(
    (id: string) => {
      const tr = tRef.current;
      const word = dataRef.current.words.find((item) => item.id === id);
      dispatch({ type: 'DELETE_WORD', id });
      toast(word ? tr('actions.wordDeleted', { term: word.term }) : tr('common.delete'), 'success');
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
      const tr = tRef.current;
      if (dataRef.current.providers.length >= MAX_PROVIDERS) {
        return { ok: false, message: tr('actions.providerLimit', { max: MAX_PROVIDERS }) };
      }
      if (!draft.defaultModel.trim()) return { ok: false, message: tr('actions.modelRequired') };
      const id = uid('p');
      dispatch({ type: 'ADD_PROVIDER', id, draft, now: Date.now() });
      toast(tr('actions.providerSaved'), 'success');
      return { ok: true, message: tr('actions.providerSaved'), id };
    },
    [toast],
  );

  const updateProvider = useCallback((id: string, draft: ProviderDraft) => {
    dispatch({ type: 'UPDATE_PROVIDER', id, patch: draft, now: Date.now() });
  }, []);

  const deleteProvider = useCallback(
    (id: string) => {
      const tr = tRef.current;
      const current = dataRef.current.providers.find((item) => item.id === id);
      dispatch({ type: 'DELETE_PROVIDER', id, now: Date.now() });
      toast(
        current ? tr('actions.providerDeleted', { name: current.name || tr('settings.unnamedProfile') }) : tr('common.delete'),
        'success',
      );
    },
    [toast],
  );

  const setActiveProvider = useCallback((id: string | null) => {
    dispatch({ type: 'SET_ACTIVE_PROVIDER', id, now: Date.now() });
  }, []);

  const setTheme = useCallback((theme: ThemeMode) => {
    dispatch({ type: 'SET_THEME', theme });
  }, []);

  const setLocale = useCallback((next: AppLocale) => {
    dispatch({ type: 'SET_LOCALE', locale: next });
  }, []);

  const importBackup = useCallback(
    (next: AppData) => {
      dispatch({ type: 'IMPORT_DATA', data: next, now: Date.now() });
      toast(tRef.current('actions.backupImported'), 'success');
    },
    [toast],
  );

  const resetAll = useCallback(() => {
    dispatch({ type: 'RESET_ALL', now: Date.now() });
    toast(tRef.current('actions.resetSample'), 'success');
  }, [toast]);

  const clearProgress = useCallback(() => {
    dispatch({ type: 'CLEAR_PROGRESS', now: Date.now() });
    toast(tRef.current('actions.clearProgress'), 'success');
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
      setLocale,
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
      setLocale,
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

  return (
    <AppContext.Provider value={value}>
      <I18nProvider locale={locale}>{children}</I18nProvider>
    </AppContext.Provider>
  );
}
