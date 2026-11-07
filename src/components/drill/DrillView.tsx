/**
 * AI 错题特训页。
 *
 * 四个阶段：
 *   setup      —— 选错词、选题量/难度、查看 LLM 状态
 *   generating —— 组卷中，按 onProgress 文案落墨，可取消
 *   quiz       —— 一次一题，即时判分，答完立即写回学习记录
 *   result     —— 成绩单、错题复盘、再来一组
 * 组卷失败时进入 error 阶段：可重试、可改用本地题库。
 *
 * 数据与写操作只走 useApp()；LLM 层与本地兜底出题器的接口以
 * lib/llm/types.ts / lib/fallbackExercises.ts 的契约为准。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DifficultyPreference, Exercise, ViewProps } from '@/types';
import type { ExerciseTarget } from '@/lib/llm';
import { generateExercises, hasUsableLLMConfig, LLMError } from '@/lib/llm';
import { buildLocalExercises } from '@/lib/fallbackExercises';
import { getMistakeList, getWordProgressList } from '@/lib/stats';
import type { WordProgress } from '@/lib/stats';
import { useApp } from '@/state/AppState';
import { cx, normalizeAnswer, sample } from '@/lib/utils';
import SetupStage from './SetupStage';
import GeneratingStage from './GeneratingStage';
import FailureStage from './FailureStage';
import QuizStage from './QuizStage';
import ResultStage from './ResultStage';
import { DIFFICULTY_LABEL, isRemoteEndpoint, llmErrorHint } from './meta';
import type { AnswerRecord, DrillErrorInfo, DrillMode, DrillStage } from './types';
import './DrillView.css';

/** 默认勾选的错词数量。 */
const DEFAULT_TARGETS = 8;
/** 无错题时「随机抽词」抽取的数量。 */
const RANDOM_PICK = 8;
/** 本地兜底保留一点点停顿，让「组卷」这一步被看见。 */
const LOCAL_DRAFT_DELAY = 360;

function toFailure(error: unknown, mode: DrillMode): DrillErrorInfo {
  if (error instanceof LLMError) {
    return {
      mode,
      message: error.message,
      hint: llmErrorHint(error.code),
      detail: error.detail,
    };
  }
  const message =
    error instanceof Error && error.message ? error.message : '出题过程出了点意外。';
  return {
    mode,
    message,
    hint:
      mode === 'llm'
        ? '可以重试一次，或改用本地题库继续。'
        : '换几个词再试，或先去词库补充单词。',
  };
}

export default function DrillView({ navigate }: ViewProps) {
  const { data, actions } = useApp();
  const mistakeList = useMemo(() => getMistakeList(data), [data]);

  const [stage, setStage] = useState<DrillStage>('setup');
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    getMistakeList(data)
      .slice(0, DEFAULT_TARGETS)
      .map((item) => item.word.id),
  );
  const [count, setCount] = useState<number>(6);
  const [difficulty, setDifficulty] = useState<DifficultyPreference>('adaptive');
  const [fallbackPool, setFallbackPool] = useState<WordProgress[] | null>(null);

  const [mode, setMode] = useState<DrillMode>('llm');
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [index, setIndex] = useState(0);
  const [selection, setSelection] = useState<number | null>(null);
  const [fillValue, setFillValue] = useState('');
  const [graded, setGraded] = useState(false);
  const [isCorrect, setIsCorrect] = useState(false);
  const [answers, setAnswers] = useState<AnswerRecord[]>([]);

  const [stageLog, setStageLog] = useState<string[]>([]);
  const [currentStage, setCurrentStage] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<DrillErrorInfo | null>(null);
  const [finishedAt, setFinishedAt] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const gradedRef = useRef(false);
  const startedAtRef = useRef(0);
  const quizTopRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  const llmReady = hasUsableLLMConfig(data.settings);
  const missingKey =
    llmReady && !data.settings.apiKey.trim() && isRemoteEndpoint(data.settings.baseUrl);

  const pool = fallbackPool ?? mistakeList;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedPool = useMemo(
    () => pool.filter((item) => selectedSet.has(item.word.id)),
    [pool, selectedSet],
  );
  const wordMap = useMemo(
    () => new Map(data.words.map((word) => [word.id, word])),
    [data.words],
  );

  // 卸载时取消仍在进行的请求，避免 setState 落到已卸载的组件上。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // 组卷计时。
  useEffect(() => {
    if (stage !== 'generating') return;
    const timer = window.setInterval(() => {
      setElapsed((value) => value + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [stage]);

  // 换题时把卷面带回视野。
  useEffect(() => {
    if (stage !== 'quiz') return;
    quizTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [stage, index]);

  function resetQuestion() {
    gradedRef.current = false;
    setSelection(null);
    setFillValue('');
    setGraded(false);
    setIsCorrect(false);
  }

  function toggleWord(wordId: string) {
    setSelectedIds((current) =>
      current.includes(wordId)
        ? current.filter((id) => id !== wordId)
        : [...current, wordId],
    );
  }

  function selectAll() {
    setSelectedIds(pool.map((item) => item.word.id));
  }

  function clearSelection() {
    setSelectedIds([]);
  }

  function pickRandomWords() {
    const progress = getWordProgressList(data);
    if (progress.length === 0) {
      actions.toast('词库还是空的，先去添加单词', 'info');
      return;
    }
    const picked = sample(progress, Math.min(RANDOM_PICK, progress.length));
    setFallbackPool(picked);
    setSelectedIds(picked.map((item) => item.word.id));
    actions.toast(`已从词库随机抽 ${picked.length} 个词`, 'info');
  }

  async function startGeneration(nextMode: DrillMode) {
    if (stage === 'generating') return;
    const targetsPool = selectedPool;
    if (targetsPool.length === 0) {
      actions.toast('先选择要特训的单词', 'info');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setMode(nextMode);
    setFailure(null);
    setExercises([]);
    setAnswers([]);
    setIndex(0);
    resetQuestion();
    setStageLog([]);
    setCurrentStage(
      nextMode === 'llm' ? '正在整理错词与错因…' : '正在从本地题库组卷…',
    );
    setElapsed(0);
    setStage('generating');

    try {
      let result: Exercise[];
      if (nextMode === 'llm') {
        const targets: ExerciseTarget[] = targetsPool.map((item) => ({
          word: item.word,
          wrongCount: item.wrongCount,
          correctStreak: item.correctStreak,
          srsStatus: item.card.status,
          lastExerciseType: item.mistake?.lastExerciseType,
          lastMistakeAt: item.mistake?.lastWrongAt,
          recentAccuracy:
            item.accuracy === null ? undefined : Math.round(item.accuracy) / 100,
        }));
        result = await generateExercises({
          targets,
          count,
          difficulty,
          settings: dataRef.current.settings,
          signal: controller.signal,
          onProgress: (text) => {
            if (controller.signal.aborted || !mountedRef.current) return;
            setCurrentStage(text);
            setStageLog((log) => (log[log.length - 1] === text ? log : [...log, text].slice(-5)));
          },
        });
      } else {
        await new Promise<void>((resolve) => window.setTimeout(resolve, LOCAL_DRAFT_DELAY));
        if (controller.signal.aborted) return;
        result = buildLocalExercises(
          targetsPool.map((item) => item.word),
          dataRef.current.mistakes,
          count,
        );
      }

      if (controller.signal.aborted || !mountedRef.current) return;

      const liveWordIds = new Set(dataRef.current.words.map((word) => word.id));
      const valid = result.filter((exercise) => liveWordIds.has(exercise.wordId));
      if (valid.length === 0) {
        setFailure({
          mode: nextMode,
          message:
            nextMode === 'llm'
              ? '模型这次没有给出可用的题目。'
              : '本地题库没能组出可用的题目。',
          hint:
            nextMode === 'llm'
              ? '可以重试一次，或改用本地题库继续。'
              : '换几个词再试，或先去词库补充单词。',
        });
        setStage('error');
        return;
      }

      startedAtRef.current = Date.now();
      setExercises(valid);
      setIndex(0);
      setStage('quiz');
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setFailure(toFailure(error, nextMode));
      setStage('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function cancelGeneration() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStage('setup');
    setStageLog([]);
    setCurrentStage('');
    actions.toast('已取消命题', 'info');
  }

  function gradeCurrent() {
    if (gradedRef.current) return;
    const exercise = exercises[index];
    if (!exercise) return;
    const options = exercise.options ?? [];
    const hasOptions = options.length > 0;

    let response: string;
    let right: boolean;
    if (hasOptions) {
      if (selection === null) return;
      response = options[selection] ?? '';
      right = normalizeAnswer(response) === normalizeAnswer(exercise.answer);
    } else {
      response = fillValue.trim();
      if (!response) return;
      const accepted = [exercise.answer, ...(exercise.acceptableAnswers ?? [])];
      right = accepted.some(
        (candidate) => normalizeAnswer(candidate) === normalizeAnswer(response),
      );
    }

    gradedRef.current = true;
    setIsCorrect(right);
    setGraded(true);
    setAnswers((current) => [...current, { exercise, response, correct: right }]);
    actions.recordExercise({
      wordId: exercise.wordId,
      correct: right,
      exerciseType: exercise.type,
      source: exercise.source,
      prompt: exercise.prompt,
    });
  }

  function finishRound() {
    if (answers.length === 0) {
      setStage('setup');
      actions.toast('这一轮还没有作答，已回到选词', 'info');
      return;
    }
    setFinishedAt(Date.now());
    setStage('result');
  }

  function goNext() {
    if (!gradedRef.current) return;
    const nextIndex = index + 1;
    if (nextIndex >= exercises.length) {
      resetQuestion();
      finishRound();
      return;
    }
    resetQuestion();
    setIndex(nextIndex);
  }

  function backToSetup() {
    abortRef.current?.abort();
    abortRef.current = null;
    const liveMistakes = getMistakeList(dataRef.current);
    // 上一轮如果是「从词库随机抽词」且词库里仍无错题，保留这批抽词，
    // 免得用户点「再练一组」又落回空状态。
    const keepFallback = fallbackPool !== null && liveMistakes.length === 0;
    const available = new Set(
      keepFallback
        ? fallbackPool.map((item) => item.word.id)
        : liveMistakes.map((item) => item.word.id),
    );
    const kept = selectedIds.filter((id) => available.has(id));
    const nextPool = keepFallback ? fallbackPool : liveMistakes;
    setSelectedIds(
      kept.length > 0
        ? kept
        : nextPool.slice(0, DEFAULT_TARGETS).map((item) => item.word.id),
    );
    setFallbackPool(keepFallback ? fallbackPool : null);
    setExercises([]);
    setAnswers([]);
    setIndex(0);
    resetQuestion();
    setFailure(null);
    setStageLog([]);
    setCurrentStage('');
    setStage('setup');
  }

  // 键盘：1–4 选项、Enter 判分 / 下一题。
  useEffect(() => {
    if (stage !== 'quiz') return;
    const exercise = exercises[index];
    if (!exercise) return;
    const hasOptions = (exercise.options?.length ?? 0) > 0;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing) return;

      if (event.key === 'Enter') {
        if (graded) {
          event.preventDefault();
          goNext();
        } else if (hasOptions && selection !== null) {
          event.preventDefault();
          gradeCurrent();
        } else if (!hasOptions) {
          event.preventDefault();
          gradeCurrent();
        }
        return;
      }

      if (graded) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable),
      );
      if (typing) return;

      if (hasOptions && /^[1-4]$/.test(event.key)) {
        const optionIndex = Number(event.key) - 1;
        if (optionIndex < (exercise.options?.length ?? 0)) {
          event.preventDefault();
          setSelection(optionIndex);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // gradeCurrent / goNext 读取的正是下面这些状态。
  }, [stage, exercises, index, graded, selection, fillValue, answers]);

  const activeExercise = exercises[index];
  const durationMs = finishedAt > 0 ? finishedAt - startedAtRef.current : 0;

  return (
    <div className="drill-view">
      <header className="view-head drill-head">
        <div className="drill-head__intro">
          <div className="view-head__eyebrow">
            <span className="seal drill-head__seal" aria-hidden="true">
              训
            </span>
            <span className="mono-label">DRILL / 特训</span>
          </div>
          <h1 className="view-title">错题特训</h1>
          <p className="view-sub">大模型读你的错题，为你命题。逐题作答，答完当堂复盘。</p>
        </div>
        <div className="view-actions drill-head__actions">
          <span
            className={cx(
              'badge',
              'badge--dot',
              llmReady && !missingKey ? 'badge--sage' : 'badge--gold',
            )}
            title={
              !llmReady
                ? '未配置可用接口，练习由本地题库生成'
                : missingKey
                  ? '远端接口缺少 API Key，调用可能失败'
                  : '将调用大模型针对错题命题'
            }
          >
            {!llmReady ? '本地题库' : missingKey ? '大模型 · 缺 Key' : '大模型已就绪'}
          </span>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => navigate('settings')}
          >
            设置
          </button>
        </div>
      </header>

      {stage === 'setup' && (
        <SetupStage
          pool={pool}
          selectedIds={selectedIds}
          count={count}
          difficulty={difficulty}
          settings={data.settings}
          llmReady={llmReady}
          missingKey={missingKey}
          fallbackActive={fallbackPool !== null}
          hasWords={data.words.length > 0}
          onToggleWord={toggleWord}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onRandomPick={pickRandomWords}
          onCountChange={setCount}
          onDifficultyChange={setDifficulty}
          onStart={startGeneration}
          onNavigate={navigate}
        />
      )}

      {stage === 'generating' && (
        <GeneratingStage
          mode={mode}
          currentStage={currentStage}
          stageLog={stageLog}
          words={selectedPool.slice(0, 12).map((item) => item.word.term)}
          elapsedSeconds={elapsed}
          selectedCount={selectedPool.length}
          count={count}
          difficultyLabel={DIFFICULTY_LABEL[difficulty]}
          onCancel={cancelGeneration}
        />
      )}

      {stage === 'error' && failure && (
        <FailureStage
          failure={failure}
          count={count}
          difficultyLabel={DIFFICULTY_LABEL[difficulty]}
          selectedCount={selectedPool.length}
          onRetry={() => void startGeneration(failure.mode)}
          onUseLocal={() => void startGeneration('local')}
          onBack={backToSetup}
        />
      )}

      {stage === 'quiz' && activeExercise && (
        <QuizStage
          exercise={activeExercise}
          word={wordMap.get(activeExercise.wordId)}
          index={index}
          total={exercises.length}
          answered={answers.length}
          graded={graded}
          correct={isCorrect}
          selection={selection}
          fillValue={fillValue}
          onSelectOption={setSelection}
          onFillChange={setFillValue}
          onGrade={gradeCurrent}
          onNext={goNext}
          onEnd={finishRound}
          scrollRef={quizTopRef}
        />
      )}

      {stage === 'result' && (
        <ResultStage
          answers={answers}
          totalQuestions={exercises.length}
          durationMs={durationMs}
          finishedAt={finishedAt}
          words={wordMap}
          onRestart={backToSetup}
          onNavigate={navigate}
        />
      )}
    </div>
  );
}
