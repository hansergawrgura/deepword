/**
 * 学习页 —— Phase B 的学习流程。
 *
 * 单页流程：新词闸门（认识 / 掌握）→ 新词出题 → 复习出题 → 小结 → 继续下一轮。
 *
 * 一轮的进度持久化在 `data.session`（PracticeSessionState），中途退出可恢复；
 * 所有数据写入都走 useApp() 的 actions，不直接触碰 localStorage。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Exercise,
  PracticeResult,
  PracticeSessionState,
  Skill,
  ViewProps,
  Word,
} from '@/types';
import { useApp } from '@/state/AppState';
import { hasUsableLLMConfig } from '@/lib/llm';
import { resolveActiveLLMSettings } from '@/lib/providerModel';
import { isTranslation } from '@/lib/practice';
import {
  advanceQuestion,
  applyAnswer,
  confirmGate,
  createSession,
  currentQuestion,
  hasResumableSession,
  isRoundComplete,
  judgeExercise,
  newQuestionCount,
  nextNewWordGate,
  rejectGate,
  reviewQuestionCount,
  startReviewStage,
  summarizeSession,
  type RoundContext,
} from '@/lib/practiceRound';
import { countAvailable, planRound } from '@/lib/rounds';
import { getSkillStats } from '@/lib/weakness';
import {
  EXPLANATION_MAX,
  encouragement,
  localAnswerFeedback,
  streamAnswerFeedback,
  streamTranslationGrade,
} from '@/lib/feedback';
import { cancelSpeech, speak as speakText, useEnglishVoices } from '@/lib/tts';
import { dayKey, percent, weekdayName } from '@/lib/utils';
import { IconBook, IconHome } from '../ui/icons';
import Flashcard from './Flashcard';
import QuestionCard from './QuestionCard';
import RoundSummary from './RoundSummary';
import type { AnswerFeedbackState, AnswerPhase } from './types';
import './StudyView.css';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 工具条上阶段名的悬浮说明。 */
const STUDY_HINT = '新词 → 复习 → 小结，一轮一轮往前走。';

/** 一次作答的落库内容（讲解可能在判分之后才补齐）。 */
interface PendingRecord {
  wordId: string;
  correct: boolean;
  exerciseType: Exercise['type'];
  prompt: string;
  skill?: Skill;
  latencyMs: number;
  verdict?: AnswerFeedbackState['verdict'];
  aiFeedback?: string;
  aiImprovement?: string;
  aiStatus?: AnswerFeedbackState['status'];
  roundId: string;
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export default function StudyView({ navigate }: ViewProps) {
  const { data, actions } = useApp();
  const [phase, setPhase] = useState<AnswerPhase>('idle');
  const [feedback, setFeedback] = useState<AnswerFeedbackState | null>(null);
  const [masteredThisRound, setMasteredThisRound] = useState<string | null>(null);
  const [nudge, setNudge] = useState(0);
  /** 计划屏：进页先看本轮计划；存在未完成的一轮时提示「继续上一轮」。 */
  const [planVisible, setPlanVisible] = useState(
    () => !data.session || hasResumableSession(data),
  );
  /** 答对后的自动跳转倒计时（时间戳）。 */
  const [advanceDeadline, setAdvanceDeadline] = useState<number | null>(null);
  /** 倒计时的重绘节拍。 */
  const [, setTick] = useState(0);
  /** 正在生成 AI 讲解（「让 AI 讲讲」）。 */
  const [explaining, setExplaining] = useState(false);
  /** 本题是否需要手动点「让 AI 讲讲」（答错且讲解未自动生成）。 */
  const [needsExplain, setNeedsExplain] = useState(false);

  const session = data.session ?? null;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const questionStartedAt = useRef(Date.now());
  const advanceTimer = useRef<number | null>(null);
  /** 自动跳转要调用「下一题」；用 ref 避免回调互相依赖。 */
  const handleNextRef = useRef<(() => void) | null>(null);
  /** 待落库的作答（讲解补齐后再写，保证记录与界面一致）。 */
  const pendingRecord = useRef<PendingRecord | null>(null);
  /** 最近一次作答内容，供「让 AI 讲讲」重放。 */
  const lastResponse = useRef('');

  const now = new Date();
  const nowTs = now.getTime();
  const todayStat = data.stats.daily[dayKey(nowTs)];
  const todayReviewed = todayStat?.reviewed ?? 0;

  /* ------------------------------ 上下文 ------------------------------ */

  const llmSettings = useMemo(() => resolveActiveLLMSettings(data), [data]);
  const aiAvailable = Boolean(llmSettings && hasUsableLLMConfig(llmSettings));
  // 语音列表在部分浏览器里是异步就绪的，用 Hook 订阅 voiceschanged。
  const englishVoices = useEnglishVoices();
  const ttsAvailable = englishVoices.length > 0;

  /** 薄弱技能优先：练过且正确率最低的排前面。 */
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

  /** 本轮计划（新词 / 复习词 / 题量）。 */
  const plan = useMemo(
    () => planRound(data, data.practice, { now: nowTs }),
    [data, nowTs],
  );
  /** 掌握度：已掌握词占词库的比例。 */
  const masteryRate = useMemo(
    () => (data.words.length > 0 ? percent(available.mastered, data.words.length) : 0),
    [available.mastered, data.words.length],
  );
  /** 上一轮还没结束？（进页时的「继续上一轮」提示） */
  const resumable = useMemo(
    () => (hasResumableSession(data) ? (data.session ?? null) : null),
    [data],
  );

  /** 朗读英文；slow = true 时慢速。 */
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

  /* ------------------------------ 流程 ------------------------------ */

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

  /** 落库一次作答（讲解截断到 EXPLANATION_MAX）。 */
  const flushRecord = useCallback(() => {
    const pending = pendingRecord.current;
    if (!pending) return;
    pendingRecord.current = null;
    actions.recordExercise({
      wordId: pending.wordId,
      correct: pending.correct,
      exerciseType: pending.exerciseType,
      // 题目全部本地生成，AI 只负责判分与讲解。
      source: 'local',
      prompt: pending.prompt,
      skill: pending.skill,
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

  /** 把后到的讲解补写进本轮最后一条作答结果（小结可回看）。 */
  const patchLastResult = useCallback(
    (patch: Partial<PracticeResult>) => {
      const current = sessionRef.current;
      if (!current?.results?.length) return;
      const results = current.results.slice();
      results[results.length - 1] = { ...results[results.length - 1], ...patch };
      const next = { ...current, results };
      sessionRef.current = next;
      actions.setPracticeSession(next);
    },
    [actions],
  );

  /** 进入复习阶段（新一轮或新词阶段结束后）。 */
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
      // 极端情况下（词条缺释义/例句）可能一道题都出不来：直接收束到小结，避免卡住。
      if ((next.questions?.length ?? 0) === 0) {
        actions.setPracticeSession({ ...next, stage: 'done', questionIndex: 0 });
        return;
      }
      actions.setPracticeSession(next);
    },
    [actions, context, wordMap],
  );

  const startRound = useCallback(() => {
    const plan = planRound(data, data.practice, { now: Date.now() });
    let next = createSession(plan, { roundNo: plan.roundNo, now: Date.now() });
    if (!plan.newWord) {
      if (plan.reviewWords.length === 0) {
        actions.toast('暂时没有可安排的词，先去词库添加或换个时候再来。', 'info');
        actions.setPracticeSession(null);
        return;
      }
      next = startReviewStage(next, plan.reviewWords, context);
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
      if (!(current.questions?.length)) {
        // 题面丢失（版本变化或数据损坏）：重开一轮。
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

  /* ---------------------------- 闸门（新词） ---------------------------- */

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
    // 还有新词没走闸门 → 先去下一个新词；否则进入复习阶段。
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
    // 「不认识 / 不记得了」= 排进下一轮复习优先。
    actions.flagReviewPriority(word.id);
    resetFeedback();
    const next = rejectGate(current, word, context);
    if ((next.questions?.length ?? 0) === 0) {
      // 这个词条出不了题（缺释义等）：跳过新词练习，直接进入复习。
      beginReview(next);
      return;
    }
    actions.setPracticeSession(next);
  }, [actions, beginReview, context, gateWord, resetFeedback]);

  /* ------------------------------ 作答 ------------------------------ */

  const handleSubmit = useCallback(
    async (response: string) => {
      const current = sessionRef.current;
      if (!current) return;
      const item = currentQuestion(current);
      if (!item) return;
      const word = wordMap.get(item.wordId);
      if (!word) return;

      const latencyMs = Math.max(0, Date.now() - questionStartedAt.current);
      setPhase('judging');
      setFeedback(null);
      lastResponse.current = response;

      let correct = false;
      let verdict: AnswerFeedbackState['verdict'];
      let aiFeedback: string | undefined;
      let aiImprovement: string | undefined;
      let aiStatus: AnswerFeedbackState['status'] | undefined;
      /** 讲解是否已经定稿（定稿即可落库）。 */
      let settled = false;

      if (isTranslation(item) && llmSettings && aiAvailable) {
        const grade = await streamTranslationGrade(
          { word, exercise: item, response },
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
              setFeedback((prev) => ({ ...(prev ?? { status: 'ok', text: '', streaming: true }), verdict: value })),
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
      } else {
        // 本地判分（choice / spell / listen / sentence）。
        correct = judgeExercise(item, response);
        if (correct) {
          settled = true;
          setFeedback({
            status: 'ok',
            text: encouragement(current.answered),
            streaming: false,
          });
        } else {
          const local = localAnswerFeedback({ word, exercise: item, response });
          if (data.practice.autoExplain && llmSettings && aiAvailable) {
            // 自动讲解：答错立刻流式生成错因 / 记忆点 / 改进，不自动跳题。
            const streamed = await streamAnswerFeedback(
              { word, exercise: item, response },
              llmSettings,
              {
                onToken: (chunk) =>
                  setFeedback((prev) => ({
                    status: 'ok',
                    text: prev?.text ? `${prev.text}${chunk}` : chunk,
                    streaming: true,
                  })),
              },
            );
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
            // 未配置 AI，或关闭了「自动讲解」：先给本地解析（local-fallback 角标），
            // 需要时可点「让 AI 讲讲」手动请求。
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
        }
      }

      pendingRecord.current = {
        wordId: word.id,
        correct,
        exerciseType: item.type,
        prompt: item.prompt,
        skill: item.skill,
        latencyMs,
        verdict,
        aiFeedback,
        aiImprovement,
        aiStatus,
        roundId: current.id,
      };
      setNeedsExplain(!settled && !correct);

      const next = applyAnswer(
        current,
        item,
        response,
        {
          correct,
          verdict,
          aiFeedback,
          aiImprovement,
          aiStatus,
          latencyMs,
        },
        Date.now(),
      );
      // 先同步 ref：用户可能立刻点「下一题」，不能读到 reducer 还没落地的旧会话。
      sessionRef.current = next;
      actions.setPracticeSession(next);
      setPhase('answered');

      // 讲解已定稿 → 立刻落库；否则等「让 AI 讲讲」补齐或用户点「继续」时再落。
      if (settled) flushRecord();

      // 答对：本地鼓励语 + 按设置自动下一题（0 = 手动）。
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
      wordMap,
    ],
  );

  /** 「让 AI 讲讲」：手动补一段讲解（关闭「自动讲解」时用）。 */
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
      { word, exercise: item, response: lastResponse.current },
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

    // 回填待落库的记录与本轮结果（讲解可回看）。
    if (pendingRecord.current) {
      pendingRecord.current.aiFeedback = streamed.explanation;
      pendingRecord.current.aiImprovement = streamed.improvement;
      pendingRecord.current.aiStatus = streamed.status;
    }
    patchLastResult({
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
  }, [aiAvailable, feedback?.verdict, llmSettings, patchLastResult, wordMap]);

  const handleNext = useCallback(() => {
    clearAdvanceTimer();
    // 兜底落库：讲解没定稿的题，在离开前也要记下来。
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
    // 本阶段题目答完：新词阶段 → 下一个新词或复习阶段；复习阶段 → 小结。
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

  /* ------------------------------ 副作用 ------------------------------ */

  // 换题时重置反馈与计时
  useEffect(() => {
    setFeedback(null);
    setPhase('idle');
    setNeedsExplain(false);
    questionStartedAt.current = Date.now();
  }, [question?.id]);

  // 自动跳转倒计时：每 200ms 重绘一次，剩余时间归零时由定时器推进。
  useEffect(() => {
    if (advanceDeadline === null) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 200);
    return () => window.clearInterval(timer);
  }, [advanceDeadline]);

  /** 答对后的自动跳转倒计时（null = 手动）。 */
  const autoAdvance =
    advanceDeadline === null
      ? null
      : {
          remaining: Math.max(0, advanceDeadline - Date.now()),
          total: data.practice.feedbackAutoAdvanceMs,
        };

  // 听音题自动播放（可在设置里关闭）
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

  // 离开页面时收掉朗读与自动跳转
  useEffect(
    () => () => {
      clearAdvanceTimer();
      cancelSpeech();
    },
    [clearAdvanceTimer],
  );

  // 空格翻面（新词闸门）
  useEffect(() => {
    if (stage !== 'gate') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, a, input, textarea, select')) return;
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        setNudge((value) => value + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stage]);

  /* ------------------------------ 渲染数据 ------------------------------ */

  const summary = session ? summarizeSession(session) : null;
  const gateFlipped = session?.gate === 'confirm';

  /** 顶部工具条上的阶段名：取代原先两层重复的大标题。 */
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
  /* ------------------------------ 渲染 ------------------------------ */

  return (
    <div className="study">
      {/* 轮次进度条放在最上面：一行进度 + 一行紧凑元信息 */}
      {roundQuestions > 0 ? (
        <div className="study-progress study-progress--top">
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={roundQuestions}
            aria-valuenow={roundIndex}
            aria-label="本轮进度"
          >
            <div
              className="progress__bar"
              style={{ width: `${percent(session?.questionIndex ?? 0, roundQuestions)}%` }}
            />
          </div>
          <div className="study-progress__meta">
            <span>
              第 {session?.roundNo ?? 1} 轮 · {planVisible ? '待继续' : stageLabel} · 第{' '}
              {roundIndex} / {roundQuestions} 题
            </span>
            <span>
              已答 {session?.answered ?? 0} 题
              {summary ? ` · 正确率 ${summary.accuracy}%` : ''}
            </span>
          </div>
        </div>
      ) : null}

      {/* 单行工具条：阶段 / 唯一动作，取代两层 view-head */}
      <div className="study-bar">
        <span className="study-bar__stage" title={STUDY_HINT}>
          {weekdayName(nowTs)} · {stageLabel}
        </span>
        <div className="study-bar__actions">
          {session && !planVisible ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={finishRound}>
              {stage === 'done' ? <IconHome size={14} /> : null}
              {stage === 'done' ? '回概览' : '结束本轮'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => navigate('wordbook')}
            >
              <IconBook size={14} />
              去词库
            </button>
          )}
        </div>
      </div>

      {/* ==================================================================
          固定的中间舞台：计划 / 闸门 / 答题 / 小结 / 概览 全部共用
          同一个 .view-stage--fixed + .view-stage__inner。四边留白、宽度与
          高度只在 styles/ui.css 的「固定几何舞台」一处定义；任何状态、任何
          题型都进入同一个外框，切换时不改宽度、不改高度、不位移。
          ================================================================== */}
      <div className="view-stage view-stage--fixed">
        <div className="view-stage__inner">
          {planVisible ? (
            <section className="study-sheet enter-up" aria-label="本轮计划">
              <span className="seal study-sheet__seal" aria-hidden="true">
                温
              </span>
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">本轮计划</h2>
                  <p className="study-sheet__sub">
                    第 {plan.roundNo} 轮 · 一轮 = {plan.newWords.length} 个新词 +{' '}
                    {plan.reviewWords.length} 个复习词；今日已学 {todayReviewed} 次。
                  </p>
                </header>

                {data.words.length === 0 ? (
                  <div className="study-empty">
                    <div className="empty-state">
                      <span className="empty-state__mark" aria-hidden="true">
                        空
                      </span>
                      <h2 className="empty-state__title">词库还是空的</h2>
                      <p className="empty-state__desc">先收几个想记的词，再回来温故。</p>
                      <div className="study-empty__actions">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => navigate('wordbook')}
                        >
                          <IconBook size={16} />
                          去词库添加
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {resumable ? (
                      <div className="study-resume" role="status">
                        <p className="study-resume__title">上一轮还没结束</p>
                        <p className="study-resume__desc">
                          第 {resumable.roundNo ?? 1} 轮，已答 {resumable.answered ?? 0} 题
                          {resumable.stage === 'gate'
                            ? '，还停在新词闸门'
                            : resumable.stage === 'new'
                              ? '，还在新词练习'
                              : '，还在复习'}
                          。继续会回到原来的位置。
                        </p>
                        <div className="study-resume__actions">
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={resumeRound}
                          >
                            继续上一轮
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={startRound}
                          >
                            重新开始一轮
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="study-figures">
                      <div className="study-figure">
                        <span className="study-figure__label">新词</span>
                        <span className="study-figure__value">
                          {plan.newWords.length}
                          <em>个</em>
                        </span>
                        <span className="study-figure__note">
                          本轮 {plan.newWords.length > 0 ? newQuestionCount(data.practice) : 0} 题 / 词
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">复习</span>
                        <span className="study-figure__value">
                          {plan.reviewWords.length}
                          <em>个</em>
                        </span>
                        <span className="study-figure__note">
                          本轮 {reviewQuestionCount(data.practice, Math.max(1, plan.reviewWords.length))} 题
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">掌握度</span>
                        <span className="study-figure__value">
                          {masteryRate}
                          <em>%</em>
                        </span>
                        <span className="study-figure__note">已掌握 {available.mastered} 词</span>
                      </div>
                    </div>

                    <div className="study-setup">
                      <div className="study-setup__mode">
                        <span className="study-setup__label">这一轮怎么走</span>
                        <ol className="study-flow">
                          <li>新词先过闸门：认识就出题，掌握就永久记住。</li>
                          <li>
                            {data.practice.newWordsPerRound} 个新词，每个{' '}
                            {data.practice.questionsPerNewWord} 题，覆盖 6 个技能。
                          </li>
                          <li>
                            复习 {data.practice.reviewWordsPerRound} 个词（
                            {data.practice.reviewQuestionsPerRound} 题），按薄弱度优先。
                          </li>
                          <li>小结之后点「继续」，进入下一轮。</li>
                        </ol>
                      </div>

                      <div className="study-setup__cta">
                        <span className="study-setup__count">
                          {available.newWords > 0 || available.reviewWords > 0
                            ? '准备好了就开始'
                            : '今天没有待学的词'}
                        </span>
                        <button
                          type="button"
                          className="btn btn--primary btn--lg"
                          disabled={available.newWords === 0 && available.reviewWords === 0}
                          onClick={startRound}
                        >
                          开始一轮
                        </button>
                        <span className="study-setup__key">
                          {aiAvailable ? '互译题可用' : '未配置 AI · 互译题不出'}
                          {ttsAvailable ? '' : ' · 无英文语音，听音题不出'}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          ) : stage === 'done' && session ? (
            <RoundSummary
              session={session}
              words={data.words}
              elapsedMs={Math.max(0, Date.now() - session.startedAt)}
              masteredWordId={masteredThisRound}
              onContinue={startRound}
              onFinish={finishRound}
            />
          ) : stage === 'gate' && gateWord ? (
            <div className="view-stage__pane">
              <Flashcard
                word={gateWord}
                card={data.srs[gateWord.id] ?? { wordId: gateWord.id, status: 'new', ease: 2.5, interval: 0, dueAt: Date.now(), reps: 0, lapses: 0 }}
                isNew
                isDue={false}
                flipped={gateFlipped}
                nudge={nudge}
                onFlip={handleGateMasterIntent}
                onSpeak={() => speak(gateWord.term)}
              />

              {gateFlipped ? (
                <div className="practice-gate">
                  <p className="practice-gate__ask">确认已经掌握这个词？</p>
                  <p className="practice-gate__hint">
                    确认后它将永久退出学习与复习队列；点「再想想」继续出题。
                  </p>
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={handleGateUnknown}>
                      再想想
                    </button>
                    <button type="button" className="btn btn--primary" onClick={handleGateConfirm}>
                      确认掌握
                    </button>
                  </div>
                </div>
              ) : (
                <div className="practice-gate" role="group" aria-label="新词闸门">
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={handleGateUnknown}>
                      不认识
                    </button>
                    <button type="button" className="btn btn--primary" onClick={handleGateMasterIntent}>
                      掌握
                    </button>
                  </div>
                  <p className="practice-gate__hint">
                    点「掌握」会翻面显示释义，并再问你一次；确定才作数。
                  </p>
                </div>
              )}
            </div>
          ) : question ? (
            <QuestionCard
              question={question}
              word={wordMap.get(question.wordId) ?? data.words[0]}
              index={session?.questionIndex ?? 0}
              total={session?.questions?.length ?? 0}
              phase={phase}
              feedback={feedback}
              showWordInfo={stage === 'new' && (session?.questionIndex ?? 0) === 0}
              mustReadExplanation={feedback?.verdict === 'poor'}
              autoAdvance={autoAdvance}
              onAskExplain={
                needsExplain && aiAvailable && llmSettings ? handleAskExplain : undefined
              }
              explaining={explaining}
              onSubmit={(response) => void handleSubmit(response)}
              onNext={handleNext}
              onSpeak={speak}
            />
          ) : (
            <section className="study-sheet enter-up" aria-label="本轮概览">
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">这一轮已经排好了</h2>
                  <p className="study-sheet__sub">点「开始一轮」继续下一轮学习。</p>
                </header>
                <div className="study-setup">
                  <div className="study-setup__cta">
                    <button type="button" className="btn btn--primary" onClick={resumeRound}>
                      继续这一轮
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={startRound}>
                      重开一轮
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
