import { evaluateMastery } from '@/domain/mastery';
import { recordDailyEvent } from '@/domain/stats';
import {
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  type AppData,
  type Attempt,
  type Mistake,
  type ProviderDraft,
  type ProviderProfile,
  type Skill,
} from '@/domain/types';
import { clamp, uid } from '@/domain/utils';
import { VENDOR_OPTIONS, inferVendorFromBaseUrl, normalizeAppShape, preserveApiKeys } from '@/infra/llm/providerModel';
import {
  MAX_ATTEMPTS,
  MAX_WORDS,
  createInitialData,
  makeWord,
  normalizePracticeSettings,
  normalizeWord,
  resetProgress,
} from '@/infra/storage/storage';
import type { AppAction } from './types';

const VENDOR_VALUES = VENDOR_OPTIONS.map((item) => item.value);

function pushAttempt(data: AppData, attempt: Attempt): AppData['attempts'] {
  return [attempt, ...data.attempts].slice(0, MAX_ATTEMPTS);
}

function registerWrong(
  data: AppData,
  wordId: string,
  now: number,
  skill?: Skill,
  prompt?: string,
): Mistake {
  const existing = data.mistakes[wordId];
  return {
    wordId,
    wrongCount: (existing?.wrongCount ?? 0) + 1,
    correctStreak: 0,
    firstWrongAt: existing?.firstWrongAt ?? now,
    lastWrongAt: now,
    lastAttemptAt: now,
    lastSkill: skill ?? existing?.lastSkill,
    lastPrompt: prompt ?? existing?.lastPrompt,
  };
}

function registerCorrect(data: AppData, wordId: string, now: number): Mistake | undefined {
  const existing = data.mistakes[wordId];
  if (!existing) return undefined;
  return {
    ...existing,
    correctStreak: existing.correctStreak + 1,
    lastAttemptAt: now,
  };
}

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

export function appReducer(data: AppData, action: AppAction): AppData {
  switch (action.type) {
    case 'RECORD_ATTEMPT': {
      if (!data.words.some((word) => word.id === action.wordId)) return data;
      const attempt: Attempt = {
        id: uid('a'),
        wordId: action.wordId,
        skill: action.skill,
        correct: action.correct,
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
          action.skill,
          action.prompt,
        );
      }

      const attempts = pushAttempt(data, attempt);
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

      return {
        ...data,
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
        ...data,
        words: [...data.words, word],
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
      const mastery = { ...(data.mastery ?? {}) };
      delete mastery[action.id];
      return {
        ...data,
        words: data.words.filter((word) => word.id !== action.id),
        mistakes: Object.fromEntries(
          Object.entries(data.mistakes).filter(([wordId]) => wordId !== action.id),
        ),
        attempts: data.attempts.filter((attempt) => attempt.wordId !== action.id),
        mastery,
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
        if (data.words.length + created.length >= MAX_WORDS) break;
      }
      if (created.length === 0) return data;
      return {
        ...data,
        words: [...data.words, ...created],
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

    case 'SET_SESSION':
      return { ...data, session: action.session };

    case 'SET_PRACTICE_SETTINGS': {
      const patch = action.patch ?? {};
      const next = normalizePracticeSettings({
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
      return {
        ...data,
        mastery,
        updatedAt: action.now,
      };
    }

    case 'UNMARK_MASTERED': {
      const mastery = { ...(data.mastery ?? {}) };
      if (!mastery[action.wordId]) return data;
      delete mastery[action.wordId];
      return {
        ...data,
        mastery,
        updatedAt: action.now,
      };
    }

    case 'IMPORT_DATA': {
      const next = normalizeAppShape(action.data);
      const providers = preserveApiKeys(next.providers, data.providers);
      return { ...next, providers, updatedAt: action.now };
    }

    case 'RESET_ALL': {
      const fresh = createInitialData(action.now);
      return {
        ...fresh,
        providers: data.providers,
        activeProviderId: data.activeProviderId,
        practice: data.practice,
        theme: data.theme,
      };
    }

    case 'CLEAR_PROGRESS':
      return resetProgress(data, action.now);

    default:
      return data;
  }
}
