/**
 * 学习页控制器：作答、AI 流式讲解、TTS、一轮状态与持久化。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/store';
import type {
  PracticeResult,
  PracticeSessionState,
  Skill,
  Word,
} from '@/domain/types';
import { isTranslation } from '@/domain/practice';
import {
  advanceQuestion,
  applyAnswer,
  confirmGate,
  createSession,
  currentQuestion,
  hasResumableSession,
  isRoundComplete,
  judgeQuestion,
  nextNewWordGate,
  rejectGate,
  startReviewStage,
  summarizeSession,
  type RoundContext,
} from '@/domain/practiceRound';
import { countAvailable, planRound } from '@/domain/rounds';
import { getSkillStats } from '@/domain/weakness';
import { dayKey, percent } from '@/domain/utils';
import {
  EXPLANATION_MAX,
  encouragement,
  localAnswerFeedback,
  streamAnswerFeedback,
  streamTranslationGrade,
} from '@/infra/llm/feedback';
import { hasUsableLLMConfig, resolveActiveLLMSettings } from '@/infra/llm';
import { cancelSpeech, speak as speakText, useEnglishVoices } from '@/infra/tts';
import type { AnswerFeedbackState, AnswerPhase } from './types';

const STUDY_HINT = '新词 → 复习 → 小结，一轮一轮往前走。';

interface PendingRecord {
  wordId: string;
  skill: Skill;
  correct: boolean;
  prompt: string;
  latencyMs: number;
  verdict?: AnswerFeedbackState['verdict'];
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: AnswerFeedbackState['status'];
  roundId: string;
}

export function useStudyController() {
  const { data, actions } = useApp();
  const [phase, setPhase] = useState<AnswerPhase>('idle');
  const [feedback, setFeedback] = useState<AnswerFeedbackState | null>(null);
  const [masteredThisRound, setMasteredThisRound] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  const [planVisible, setPlanVisible] = useState(
    () => !data.session || hasResumableSession(data),
  );
  const [advanceDeadline, setAdvanceDeadline] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const [explaining, setExplaining] = useState(false);
  const [needsExplain, setNeedsExplain] = useState(false);

  const session = data.session ?? null;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const questionStartedAt = useRef(Date.now());
  const advanceTimer = useRef<number | null>(null);
  const handleNextRef = useRef<(() => void) | null>(null);
  const pendingRecord = useRef<PendingRecord | null>(null);
  const lastResponse = useRef('');
  const attemptSeq = useRef(0);

  const now = new Date();
  const nowTs = now.getTime();
  const todayStat = data.stats.daily[dayKey(nowTs)];
  const todayReviewed = todayStat?.reviewed ?? 0;

  const llmSettings = useMemo(() => resolveActiveLLMSettings(data), [data]);
  const aiAvailable = Boolean(llmSettings && hasUsableLLMConfig(llmSettings));
  const englishVoices = useEnglishVoices();
  const ttsAvailable = englishVoices.length > 0;

  const weakSkills = useMemo(() => {
    const stats = getSkillStats(data, nowTs).filter((item) => item.attempts > 0);
    return stats
      .sort((a, b) => (a.accuracy ?? 101) - (b.accuracy ?? 101))
      .map((item) => item.skill);
  }, [data, nowTs]);

  const context: RoundContext = useMemo(
    () => ({
      words: data.words,
      settings: data.practice,
      ttsAvailable,
      aiAvailable,
      weakSkills,
    }),
    [data.words, data.practice, ttsAvailable, aiAvailable, weakSkills],
  );

  const available = useMemo(() => countAvailable(data, nowTs), [data, nowTs]);
  const wordMap = useMemo(
    () => new Map(data.words.map((word) => [word.id, word])),
    [data.words],
  );

  const plan = useMemo(() => planRound(data, data.practice, { now: nowTs }), [data, nowTs]);
  const masteryRate = useMemo(
    () => (data.words.length > 0 ? percent(available.mastered, data.words.length) : 0),
    [available.mastered, data.words.length],
  );
  const resumable = useMemo(
    () => (hasResumableSession(data) ? (data.session ?? null) : null),
    [data],
  );

  const speak = useCallback(
    (text: string, slow = false) => {
      const rate = data.practice.tts.rate || 1;
      speakText(text, {
        rate: slow ? Math.max(0.5, rate * 0.55) : rate,
        voiceUri: data.practice.tts.voiceUri || undefined,
      });
    },
    [data.practice.tts.rate, data.practice.tts.voiceUri],
  );

  const stage = session?.stage ?? 'overview';
  const question =
    session && (stage === 'new' || stage === 'review') ? currentQuestion(session) : undefined;
  const gateWord = stage === 'gate' ? wordMap.get(session?.currentWordId ?? '') : undefined;

  const clearAdvanceTimer = useCallback(() => {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
    setAdvanceDeadline(null);
  }, []);

  const resetFeedback = useCallback(() => {
    clearAdvanceTimer();
    setFeedback(null);
    setPhase('idle');
    setExplaining(false);
    pendingRecord.current = null;
    questionStartedAt.current = Date.now();
  }, [clearAdvanceTimer]);

  const flushRecord = useCallback(() => {
    const pending = pendingRecord.current;
    if (!pending) return;
    pendingRecord.current = null;
    actions.recordAttempt({
      wordId: pending.wordId,
      skill: pending.skill,
      correct: pending.correct,
      prompt: pending.prompt,
      latencyMs: pending.latencyMs,
      verdict: pending.verdict,
      aiFeedback: pending.aiFeedback ? pending.aiFeedback.slice(0, EXPLANATION_MAX) : undefined,
      aiImprovement: pending.aiImprovement
        ? pending.aiImprovement.slice(0, EXPLANATION_MAX)
        : undefined,
      aiStatus: pending.aiStatus,
      roundId: pending.roundId,
    });
  }, [actions]);

  const patchResult = useCallback(
    (questionId: string, patch: Partial<PracticeResult>) => {
      const current = sessionRef.current;
      if (!current?.results?.length) return;
      const index = current.results.findIndex((result) => result.questionId === questionId);
      if (index < 0) return;
      const results = current.results.slice();
      results[index] = { ...results[index], ...patch };
      const next = { ...current, results };
      sessionRef.current = next;
      actions.setPracticeSession(next);
    },
    [actions],
  );

  const beginReview = useCallback(
    (current: NonNullable<typeof session>) => {
      const words = (current.reviewWordIds ?? [])
        .map((id) => wordMap.get(id))
        .filter(Boolean) as Word[];
      if (words.length === 0) {
        actions.setPracticeSession({ ...current, stage: 'done', questions: [], questionIndex: 0 });
        return;
      }
      const next = startReviewStage(current, words, context);
      if ((next.questions?.length ?? 0) === 0) {
        actions.setPracticeSession({ ...next, stage: 'done', questionIndex: 0 });
        return;
      }
      actions.setPracticeSession(next);
    },
    [actions, context, wordMap],
  );

  const startRound = useCallback(() => {
    const nextPlan = planRound(data, data.practice, { now: Date.now() });
    let next = createSession(nextPlan, { roundNo: nextPlan.roundNo, now: Date.now() });
    if (!nextPlan.newWord) {
      if (nextPlan.reviewWords.length === 0) {
        actions.toast('暂时没有可安排的词，先去词库添加或换个时候再来。', 'info');
        actions.setPracticeSession(null);
        return;
      }
      next = startReviewStage(next, nextPlan.reviewWords, context);
      if ((next.questions?.length ?? 0) === 0) {
        actions.toast('这一轮没有能出的题，先去词库补充词条信息吧。', 'info');
        actions.setPracticeSession({ ...next, stage: 'done', questionIndex: 0 });
        return;
      }
    }
    setMasteredThisRound(null);
    resetFeedback();
    setPlanVisible(false);
    actions.setPracticeSession(next);
  }, [actions, context, data, resetFeedback]);

  const resumeRound = useCallback(() => {
    resetFeedback();
    const current = sessionRef.current;
    if (!current) return;
    setPlanVisible(false);
    if (current.stage === 'new' || current.stage === 'review') {
      if (!current.questions?.length) {
        startRound();
        return;
      }
      actions.setPracticeSession({ ...current });
      return;
    }
    if (current.stage === 'gate') {
      actions.setPracticeSession({ ...current });
    }
  }, [actions, resetFeedback, startRound]);

  const finishRound = useCallback(() => {
    resetFeedback();
    setPlanVisible(true);
    actions.setPracticeSession(null);
  }, [actions, resetFeedback]);

  const handleGateMasterIntent = useCallback(() => {
    const current = sessionRef.current;
    if (!current) return;
    actions.setPracticeSession(confirmGate(current));
  }, [actions]);

  const handleGateConfirm = useCallback(() => {
    const current = sessionRef.current;
    const word = gateWord;
    if (!current || !word) return;
    actions.markMastered(word.id, 'manual');
    setMasteredThisRound(word.id);
    resetFeedback();
    const advanced: NonNullable<typeof session> = {
      ...current,
      completedNewWordIds: current.completedNewWordIds.includes(word.id)
        ? current.completedNewWordIds
        : [...current.completedNewWordIds, word.id],
    };
    const nextGate = nextNewWordGate(advanced);
    if (nextGate) {
      resetFeedback();
      actions.setPracticeSession(nextGate);
      return;
    }
    beginReview(advanced);
  }, [actions, beginReview, gateWord, resetFeedback]);

  const handleGateUnknown = useCallback(() => {
    const current = sessionRef.current;
    const word = gateWord;
    if (!current || !word) return;
    resetFeedback();
    const next = rejectGate(current, word, context);
    if ((next.questions?.length ?? 0) === 0) {
      beginReview(next);
      return;
    }
    actions.setPracticeSession(next);
  }, [actions, beginReview, context, gateWord, resetFeedback]);

  const handleSubmit = useCallback(
    async (response: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const item = currentQuestion(current);
      if (!item) return;
      const word = wordMap.get(item.wordId);
      if (!word) return;

      const latencyMs = Math.max(0, Date.now() - questionStartedAt.current);
      const firstAttempt = !(current.results ?? []).some(
        (result) => result.questionId === item.id,
      );
      const seq = ++attemptSeq.current;

      setPhase('judging');
      setFeedback(null);
      lastResponse.current = response;

      let correct = false;
      let verdict: AnswerFeedbackState['verdict'];
      let aiFeedback: string | undefined;
      let aiImprovement: string | undefined;
      let aiStatus: AnswerFeedbackState['status'] | undefined;
      let settled = false;
      let nextPhase: AnswerPhase = 'answered';

      const commit = (result: {
        correct: boolean;
        verdict?: AnswerFeedbackState['verdict'];
        aiFeedback?: string;
        aiImprovement?: string;
        aiStatus?: AnswerFeedbackState['status'];
      }) => {
        if (!firstAttempt) return;
        pendingRecord.current = {
          wordId: word.id,
          skill: item.skill,
          correct: result.correct,
          prompt: item.prompt,
          latencyMs,
          verdict: result.verdict,
          aiFeedback: result.aiFeedback,
          aiImprovement: result.aiImprovement,
          aiStatus: result.aiStatus,
          roundId: current.id,
        };
        const next = applyAnswer(current, item, response, { ...result, latencyMs }, Date.now());
        sessionRef.current = next;
        actions.setPracticeSession(next);
      };

      if (isTranslation(item) && llmSettings && aiAvailable) {
        const grade = await streamTranslationGrade(
          { word, question: item, response },
          llmSettings,
          {
            onToken: (chunk) =>
              setFeedback((prev) => ({
                status: 'ok',
                text: prev?.text ? `${prev.text}${chunk}` : chunk,
                verdict: prev?.verdict,
                streaming: true,
              })),
            onVerdict: (value) =>
              setFeedback((prev) => ({
                ...(prev ?? { status: 'ok', text: '', streaming: true }),
                verdict: value,
              })),
          },
        );
        verdict = grade.verdict;
        aiFeedback = grade.explanation;
        aiImprovement = grade.improvement;
        aiStatus = grade.status;
        correct = grade.verdict === 'perfect' || grade.verdict === 'good';
        settled = true;
        setFeedback({
          status: grade.status,
          text: grade.explanation,
          improvement: grade.improvement,
          verdict: grade.verdict,
          streaming: false,
        });
        commit({ correct, verdict, aiFeedback, aiImprovement, aiStatus });
      } else {
        correct = judgeQuestion(item, response);
        if (correct) {
          settled = true;
          commit({ correct: true });
          setFeedback({
            status: 'ok',
            text: encouragement(current.answered),
            streaming: false,
          });
        } else {
          nextPhase = 'retry';
          commit({ correct: false });
          setPhase('retry');

          const local = localAnswerFeedback({ word, question: item, response });
          if (data.practice.autoExplain && llmSettings && aiAvailable) {
            const streamed = await streamAnswerFeedback(
              { word, question: item, response },
              llmSettings,
              {
                onToken: (chunk) => {
                  if (attemptSeq.current !== seq) return;
                  setFeedback((prev) => ({
                    status: 'ok',
                    text: prev?.text ? `${prev.text}${chunk}` : chunk,
                    streaming: true,
                  }));
                },
              },
            );
            if (attemptSeq.current !== seq) return;
            aiFeedback = streamed.explanation;
            aiImprovement = streamed.improvement;
            aiStatus = streamed.status;
            settled = true;
            setFeedback({
              status: streamed.status,
              text: streamed.explanation,
              improvement: streamed.improvement,
              streaming: false,
            });
          } else {
            aiFeedback = local.explanation;
            aiImprovement = local.improvement;
            aiStatus = local.status;
            setFeedback({
              status: local.status,
              text: local.explanation,
              improvement: local.improvement,
              streaming: false,
            });
          }

          if (firstAttempt) patchResult(item.id, { aiFeedback, aiImprovement, aiStatus });
        }
      }

      setNeedsExplain(!settled && !correct);
      setPhase(nextPhase);

      if (settled) flushRecord();

      if (correct) {
        const delay = data.practice.feedbackAutoAdvanceMs;
        if (delay > 0) {
          setAdvanceDeadline(Date.now() + delay);
          advanceTimer.current = window.setTimeout(() => {
            advanceTimer.current = null;
            setAdvanceDeadline(null);
            handleNextRef.current?.();
          }, delay);
        }
      }
    },
    [
      actions,
      aiAvailable,
      data.practice.autoExplain,
      data.practice.feedbackAutoAdvanceMs,
      flushRecord,
      llmSettings,
      patchResult,
      wordMap,
    ],
  );

  const handleAskExplain = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || !llmSettings || !aiAvailable) return;
    const item = currentQuestion(current);
    if (!item) return;
    const word = wordMap.get(item.wordId);
    if (!word) return;

    setExplaining(true);
    setFeedback((prev) => ({
      status: 'ok',
      text: '',
      verdict: prev?.verdict,
      streaming: true,
    }));

    const streamed = await streamAnswerFeedback(
      { word, question: item, response: lastResponse.current },
      llmSettings,
      {
        onToken: (chunk) =>
          setFeedback((prev) => ({
            status: 'ok',
            text: prev?.text ? `${prev.text}${chunk}` : chunk,
            verdict: prev?.verdict,
            streaming: true,
          })),
      },
    );

    if (pendingRecord.current) {
      pendingRecord.current.aiFeedback = streamed.explanation;
      pendingRecord.current.aiImprovement = streamed.improvement;
      pendingRecord.current.aiStatus = streamed.status;
    }
    patchResult(item.id, {
      aiFeedback: streamed.explanation,
      aiImprovement: streamed.improvement,
      aiStatus: streamed.status,
    });
    setFeedback({
      status: streamed.status,
      text: streamed.explanation,
      improvement: streamed.improvement,
      verdict: feedback?.verdict,
      streaming: false,
    });
    setNeedsExplain(false);
    setExplaining(false);
    flushRecord();
  }, [aiAvailable, feedback?.verdict, flushRecord, llmSettings, patchResult, wordMap]);

  const handleNext = useCallback(() => {
    clearAdvanceTimer();
    flushRecord();
    const current = sessionRef.current;
    if (!current) return;
    if (!isRoundComplete(current)) {
      setFeedback(null);
      setPhase('idle');
      setNeedsExplain(false);
      questionStartedAt.current = Date.now();
      const advanced = advanceQuestion(current);
      sessionRef.current = advanced;
      actions.setPracticeSession(advanced);
      return;
    }
    if (current.stage === 'new') {
      resetFeedback();
      const nextGate = nextNewWordGate(current);
      if (nextGate) {
        actions.setPracticeSession(nextGate);
        return;
      }
      beginReview(current);
      return;
    }
    resetFeedback();
    const done: PracticeSessionState = { ...current, stage: 'done' };
    sessionRef.current = done;
    actions.setPracticeSession(done);
  }, [actions, beginReview, clearAdvanceTimer, flushRecord, resetFeedback]);

  handleNextRef.current = handleNext;

  useEffect(() => {
    setFeedback(null);
    setPhase('idle');
    setNeedsExplain(false);
    questionStartedAt.current = Date.now();
  }, [question?.id]);

  useEffect(() => {
    if (advanceDeadline === null) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 200);
    return () => window.clearInterval(timer);
  }, [advanceDeadline]);

  const autoAdvance =
    advanceDeadline === null
      ? null
      : {
          remaining: Math.max(0, advanceDeadline - Date.now()),
          total: data.practice.feedbackAutoAdvanceMs,
        };

  useEffect(() => {
    if (!question?.audio) return;
    if (!data.practice.tts.autoPlay) return;
    const word = wordMap.get(question.wordId);
    if (!word) return;
    const timer = window.setTimeout(() => {
      speak(word.term);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [question?.audio, question?.id, wordMap, data.practice.tts.autoPlay, speak]);

  useEffect(
    () => () => {
      clearAdvanceTimer();
      cancelSpeech();
    },
    [clearAdvanceTimer],
  );

  useEffect(() => {
    if (stage !== 'gate') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, a, input, textarea, select'))
        return;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        setNudge((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stage]);

  const summary = session ? summarizeSession(session) : null;
  const gateFlipped = session?.gate === 'confirm';

  const stageLabel = planVisible
    ? '本轮计划'
    : stage === 'done'
      ? '本轮小结'
      : stage === 'gate'
        ? '新词闸门'
        : stage === 'new'
          ? '新词练习'
          : stage === 'review'
            ? '复习'
            : '本轮概览';

  const roundQuestions = session?.questions?.length ?? 0;
  const roundIndex = Math.min((session?.questionIndex ?? 0) + 1, Math.max(1, roundQuestions));

  return {
    studyHint: STUDY_HINT,
    data,
    phase,
    feedback,
    masteredThisRound,
    nudge,
    planVisible,
    session,
    stage,
    question,
    gateWord,
    gateFlipped,
    nowTs,
    todayReviewed,
    plan,
    masteryRate,
    resumable,
    available,
    wordMap,
    aiAvailable,
    ttsAvailable,
    llmSettings,
    explaining,
    needsExplain,
    autoAdvance,
    summary,
    stageLabel,
    roundQuestions,
    roundIndex,
    speak,
    startRound,
    resumeRound,
    finishRound,
    handleGateMasterIntent,
    handleGateConfirm,
    handleGateUnknown,
    handleSubmit,
    handleAskExplain,
    handleNext,
  };
}
