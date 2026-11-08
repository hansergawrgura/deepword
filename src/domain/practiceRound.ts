import type {
  AppData,
  PracticeResult,
  PracticeSessionState,
  PracticeSettings,
  Question,
  Skill,
  Word,
} from './types';
import { buildMixedQuestions, buildQuestions, checkAnswer, isTranslation } from './practice';
import { MAX_REVIEW_WORDS, MIN_REVIEW_WORDS } from './rounds';
import { uid } from './utils';

export { MIN_REVIEW_WORDS as REVIEW_WORD_MIN, MAX_REVIEW_WORDS as REVIEW_WORD_MAX };

export const NEW_QUESTION_MIN = 4;
export const NEW_QUESTION_MAX = 8;

export type RoundStage = 'gate' | 'new' | 'review' | 'done';

export interface RoundContext {
  /** 全库词条（出题干扰项来源）。 */
  words: Word[];
  /** 本轮练习设置。 */
  settings: PracticeSettings;
  /** 浏览器是否有可用英文语音；无 → 不出听音题。 */
  ttsAvailable: boolean;
  /** 是否配置了可用 AI；无 → 不出互译题。 */
  aiAvailable: boolean;
  /** 薄弱技能优先（用于复习阶段选题）。 */
  weakSkills?: Skill[];
}

/** 一轮的新词题量：每词 4~8，默认 6。 */
export function newQuestionCount(settings: PracticeSettings): number {
  const value = Math.round(settings.questionsPerNewWord);
  if (!Number.isFinite(value)) return 6;
  return Math.min(NEW_QUESTION_MAX, Math.max(NEW_QUESTION_MIN, value));
}

/** 一轮的复习题量：落在 [复习词数, 2×复习词数]，默认 10。 */
export function reviewQuestionCount(settings: PracticeSettings, wordCount: number): number {
  const words = Math.max(1, wordCount);
  const upper = words * 2;
  const value = Math.round(settings.reviewQuestionsPerRound);
  if (!Number.isFinite(value)) return Math.min(upper, 10);
  return Math.min(upper, Math.max(words, value));
}

/* ------------------------------------------------------------------ */
/* 会话构造                                                            */
/* ------------------------------------------------------------------ */

/** 新建一轮会话（gate 阶段）。 */
export function createSession(
  plan: { newWord?: Word | null; newWords?: Word[]; reviewWords: Word[] },
  options: { roundNo: number; now?: number } = { roundNo: 1 },
): PracticeSessionState {
  const now = options.now ?? Date.now();
  const newWords = plan.newWords?.length
    ? plan.newWords
    : plan.newWord
      ? [plan.newWord]
      : [];
  const first = newWords[0] ?? null;
  return {
    id: uid('round'),
    startedAt: now,
    stage: first ? 'gate' : 'review',
    newWordIds: newWords.map((word) => word.id),
    completedNewWordIds: [],
    reviewWordIds: plan.reviewWords.map((word) => word.id),
    answered: 0,
    targetQuestions: 0,
    roundNo: options.roundNo,
    gate: first ? 'ask' : null,
    currentWordId: first?.id,
    questions: [],
    questionIndex: 0,
    results: [],
  };
}

/** 本轮还没处理的新词 id（按计划顺序）。 */
export function pendingNewWordIds(session: PracticeSessionState): string[] {
  const done = new Set(session.completedNewWordIds ?? []);
  return (session.newWordIds ?? []).filter((id) => !done.has(id));
}

/**
 * 切换到下一个新词的闸门；没有下一个时返回 null（应进入复习阶段）。
 */
export function nextNewWordGate(session: PracticeSessionState): PracticeSessionState | null {
  const pending = pendingNewWordIds(session);
  if (pending.length === 0) return null;
  const nextId = pending[0];
  return {
    ...session,
    stage: 'gate',
    gate: 'ask',
    currentWordId: nextId,
    questions: [],
    questionIndex: 0,
  };
}

/** 为新词生成题目，并切换到 new 阶段。 */
export function startNewStage(
  session: PracticeSessionState,
  word: Word,
  context: RoundContext,
): PracticeSessionState {
  const count = newQuestionCount(context.settings);
  const questions = buildQuestions(word, {
    words: context.words,
    settings: context.settings,
    ttsAvailable: context.ttsAvailable,
    aiAvailable: context.aiAvailable,
    count,
    isNewWord: true,
  });
  return {
    ...session,
    stage: 'new',
    gate: null,
    currentWordId: word.id,
    questions,
    questionIndex: 0,
    targetQuestions: session.targetQuestions + questions.length,
  };
}

/** 新词闸门：点「掌握」→ 翻面显示释义并追问确认。 */
export function confirmGate(session: PracticeSessionState): PracticeSessionState {
  if (session.stage !== 'gate') return session;
  return { ...session, gate: 'confirm' };
}

/** 新词闸门：点「不认识」→ 直接出题（无独立教学卡）。 */
export function rejectGate(
  session: PracticeSessionState,
  word: Word,
  context: RoundContext,
): PracticeSessionState {
  return startNewStage({ ...session, gate: null }, word, context);
}

/** 复习阶段：按薄弱度生成题目。 */
export function startReviewStage(
  session: PracticeSessionState,
  words: Word[],
  context: RoundContext,
): PracticeSessionState {
  const count = reviewQuestionCount(context.settings, words.length);
  const questions = buildMixedQuestions(words, {
    words: context.words,
    settings: context.settings,
    ttsAvailable: context.ttsAvailable,
    aiAvailable: context.aiAvailable,
    count,
    skills: context.weakSkills,
  });
  return {
    ...session,
    stage: 'review',
    gate: null,
    currentWordId: undefined,
    questions,
    questionIndex: 0,
    targetQuestions: session.targetQuestions + questions.length,
  };
}

/* ------------------------------------------------------------------ */
/* 题目推进                                                            */
/* ------------------------------------------------------------------ */

export function currentQuestion(session: PracticeSessionState): Question | undefined {
  if (!session.questions || session.questionIndex === undefined) return undefined;
  return session.questions[session.questionIndex];
}

/** 记录一题作答，返回更新后的会话（含讲解，便于小结回看）。 */
export function applyAnswer(
  session: PracticeSessionState,
  question: Question,
  response: string,
  result: {
    correct: boolean;
    verdict?: PracticeResult['verdict'];
    aiFeedback?: string;
    aiImprovement?: string;
    aiStatus?: PracticeResult['aiStatus'];
    latencyMs?: number;
  },
  now = Date.now(),
): PracticeSessionState {
  const entry: PracticeResult = {
    questionId: question.id,
    wordId: question.wordId,
    skill: question.skill ?? 'en2zh',
    prompt: question.prompt,
    response,
    answer: question.answer,
    correct: result.correct,
    verdict: result.verdict,
    aiFeedback: result.aiFeedback,
    aiImprovement: result.aiImprovement,
    aiStatus: result.aiStatus,
    latencyMs: result.latencyMs,
    answeredAt: now,
  };
  const results = [...(session.results ?? []), entry];
  const answered = session.answered + 1;

  // 新词阶段结束时把该词记入「已完成」，供小结与选词使用。
  const completedNewWordIds =
    session.stage === 'new' &&
    session.currentWordId &&
    !session.completedNewWordIds.includes(session.currentWordId)
      ? [...session.completedNewWordIds, session.currentWordId]
      : session.completedNewWordIds;

  // 注意：这里不推进 questionIndex —— 反馈要留在当前题上，等用户点「下一题」再走。
  return {
    ...session,
    answered,
    results,
    completedNewWordIds,
  };
}

/** 推进到下一题。 */
export function advanceQuestion(session: PracticeSessionState): PracticeSessionState {
  return { ...session, questionIndex: (session.questionIndex ?? 0) + 1 };
}

/** 本地判分（互译题由 LLM 判分，UI 传入 verdict 覆盖）。 */
export function judgeQuestion(question: Question, response: string): boolean {
  if (isTranslation(question)) return false;
  return checkAnswer(question, response);
}

/** 本轮是否已完成全部题目（按已答数判断，与 questionIndex 解耦）。 */
export function isRoundComplete(session: PracticeSessionState): boolean {
  const questions = session.questions ?? [];
  if (questions.length === 0) return false;
  // 只统计「本阶段题目」的作答：results 会跨阶段累加，不能直接比长度。
  const ids = new Set(questions.map((question) => question.id));
  const answered = (session.results ?? []).filter((result) => ids.has(result.questionId)).length;
  return answered >= questions.length;
}

/** 本阶段已作答题数（用于倒计时与进度展示）。 */
export function answeredInStage(session: PracticeSessionState): number {
  const ids = new Set((session.questions ?? []).map((question) => question.id));
  return (session.results ?? []).filter((result) => ids.has(result.questionId)).length;
}

/** 从作答记录里取本轮的统计，用于小结。 */
export function summarizeSession(session: PracticeSessionState): {
  total: number;
  correct: number;
  accuracy: number;
  bySkill: Record<Skill, { total: number; correct: number }>;
} {
  const results = session.results ?? [];
  const bySkill = {} as Record<Skill, { total: number; correct: number }>;
  for (const result of results) {
    const bucket = bySkill[result.skill] ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (result.correct) bucket.correct += 1;
    bySkill[result.skill] = bucket;
  }
  const correct = results.filter((result) => result.correct).length;
  return {
    total: results.length,
    correct,
    accuracy: results.length > 0 ? Math.round((correct / results.length) * 100) : 0,
    bySkill,
  };
}

/** 是否已经有可恢复的会话（进入页面时用于「继续上一轮」）。 */
export function hasResumableSession(data: AppData): boolean {
  const session = data.session;
  if (!session) return false;
  if (session.stage === 'done') return false;
  return (session.questions?.length ?? 0) > 0 || session.stage === 'gate';
}
