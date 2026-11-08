import type {
  AppData,
  AppLocale,
  MasteryRecord,
  PracticeSessionState,
  PracticeSettings,
  ProviderDraft,
  Skill,
  ThemeMode,
  ToastMessage,
  ToastTone,
  TranslationVerdict,
  WordInput,
} from '@/domain/types';

export type AppAction =
  | {
      type: 'RECORD_ATTEMPT';
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
  | { type: 'SET_LOCALE'; locale: AppLocale }
  | { type: 'IMPORT_DATA'; data: AppData; now: number }
  | { type: 'RESET_ALL'; now: number }
  | { type: 'CLEAR_PROGRESS'; now: number }
  | { type: 'SET_SESSION'; session: PracticeSessionState | null }
  | { type: 'SET_PRACTICE_SETTINGS'; patch: Partial<PracticeSettings> }
  | { type: 'MARK_MASTERED'; wordId: string; source: MasteryRecord['source']; now: number }
  | { type: 'UNMARK_MASTERED'; wordId: string; now: number };

export interface AppActions {
  recordAttempt: (result: {
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
  }) => void;
  addWord: (input: WordInput) => { ok: boolean; message: string };
  updateWord: (id: string, input: Partial<WordInput>) => { ok: boolean; message: string };
  deleteWord: (id: string) => void;
  importWords: (inputs: WordInput[]) => { added: number; skipped: number };
  parseWordsJson: (
    raw: string,
  ) => { ok: true; inputs: WordInput[]; total: number } | { ok: false; error: string };
  addProvider: (draft: ProviderDraft) => { ok: boolean; message: string; id?: string };
  updateProvider: (id: string, draft: ProviderDraft) => void;
  deleteProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  setLocale: (locale: AppLocale) => void;
  exportBackupJson: (options?: { includeApiKey?: boolean }) => string;
  parseBackup: (raw: string) => AppData;
  applyBackup: (data: AppData) => void;
  getStorageUsage: () => { bytes: number; human: string };
  resetAll: () => void;
  clearProgress: () => void;
  setPracticeSession: (session: PracticeSessionState | null) => void;
  setPracticeSettings: (patch: Partial<PracticeSettings>) => void;
  markMastered: (wordId: string, source?: MasteryRecord['source']) => void;
  unmarkMastered: (wordId: string) => void;
  toast: (message: string, tone?: ToastTone) => void;
}

export interface AppContextValue {
  data: AppData;
  actions: AppActions;
  toasts: ToastMessage[];
  dismissToast: (id: string) => void;
}
