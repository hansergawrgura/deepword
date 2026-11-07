/**
 * 一道题的面板：题干、选项/输入、判分反馈。
 *
 * 作答方式：
 * - 选择题（含例句填空、听音）：点选项即作答，不再需要单独点「提交」；
 *   键盘 A / B / C / D 与点击等价，按下即提交；
 * - 拼写 / 互译：输入后回车（互译为 Cmd / Ctrl + Enter）提交。
 *
 * 反馈规则（Phase B）：
 * - 答对：本地鼓励语，按 settings.feedbackAutoAdvanceMs 自动下一题（0 = 手动），
 *   自动跳转期间显示倒计时（剩余秒数 + 进度条）；
 * - 答错：反馈照常给出（流式 AI 讲解 / 本地解析），但题目**不锁** ——
 *   phase 进入 retry，可以继续作答直到答对；只有答对才锁题并允许「下一题」；
 *   答错时给出「跳过这题」，不想再试也能往下走；
 * - 互译：三档判分；`poor` 必须等流式结束且点过「我看完了」才能下一题；
 * - 新词第 1 题的反馈附完整词条信息。
 *
 * 选项状态（选中 / 答对 / 答错）统一由 ./optionState 计算，组件只做样式映射；
 * 动效与声效通过同一个 emitOptionFeedback 出口挂载，不在此处散落判断。
 *
 * 布局：固定双栏，左栏题目卡、右栏反馈容器常驻（未作答时为同尺寸占位）。
 * 反馈只替换右栏内容，两栏宽高、间距、题目卡边界在所有题型与作答阶段
 * 都保持一致，不产生缩放 / 位移 / 跳动。窄屏降级为上下排列。
 *
 * 组件不直接读写数据，判分与记录由 StudyView 驱动。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Question, Word } from '@/domain/types';
import { SKILL_META, isTranslation } from '@/domain/practice';
import { cx } from '@/domain/utils';
import { IconVolume } from '@/ui/icons';
import {
  emitOptionFeedback,
  optionStateClass,
  resolveOptionStates,
  type OptionState,
} from './optionState';
import { isAnswering, type AnswerFeedbackState, type AnswerPhase } from './types';

export interface QuestionCardProps {
  question: Question;
  word: Word;
  /** 第几题 / 共几题。 */
  index: number;
  total: number;
  phase: AnswerPhase;
  feedback: AnswerFeedbackState | null;
  /** 新词第 1 题：反馈附完整词条信息。 */
  showWordInfo: boolean;
  /** 互译 poor：必须先点「我看完了」才能下一题。 */
  mustReadExplanation: boolean;
  /** 答对后的自动跳转倒计时；null = 不自动跳转（手动）。 */
  autoAdvance?: { remaining: number; total: number } | null;
  /** 「让 AI 讲讲」：关闭「自动讲解」时手动请求 AI 讲解。 */
  onAskExplain?: () => void;
  /** 正在生成 AI 讲解。 */
  explaining?: boolean;
  onSubmit: (response: string) => void;
  onNext: () => void;
  /** 朗读英文；slow = true 时慢速。 */
  onSpeak: (text: string, slow?: boolean) => void;
}

const VERDICT_META = {
  perfect: { label: '完全正确', tone: 'is-perfect' },
  good: { label: '基本正确', tone: 'is-good' },
  poor: { label: '还需打磨', tone: 'is-poor' },
} as const;

export default function QuestionCard({
  question,
  word,
  index,
  total,
  phase,
  feedback,
  showWordInfo,
  mustReadExplanation,
  autoAdvance,
  onAskExplain,
  explaining = false,
  onSubmit,
  onNext,
  onSpeak,
}: QuestionCardProps) {
  const [response, setResponse] = useState('');
  const [readDone, setReadDone] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const translation = isTranslation(question);
  const skillMeta = question.skill ? SKILL_META[question.skill] : undefined;
  const answered = phase === 'answered';
  /** 题目是否仍可继续作答：idle（未答）与 retry（答错后）都可。 */
  const editable = isAnswering(phase);
  const streaming = feedback?.streaming ?? false;

  // 换题时清空输入与「看完了」标记
  useEffect(() => {
    setResponse('');
    setReadDone(false);
  }, [question.id]);

  // 可作答时把焦点交给输入框（拼写与互译）；答错回到输入框，方便接着改。
  useEffect(() => {
    if (!editable || translation) return;
    if (question.skill === 'spell') inputRef.current?.focus();
  }, [editable, question.id, question.skill, translation]);

  // 窄屏下反馈排在题目卡下方，出现时滚到可见位置（只依赖「有无反馈」，
  // 避免流式讲解每来一个 token 就重新滚动）。
  const hasFeedback = feedback !== null;
  useEffect(() => {
    if (!hasFeedback || !window.matchMedia('(max-width: 900px)').matches) return;
    const timer = window.setTimeout(() => {
      paneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [hasFeedback]);

  const options = useMemo(() => question.options ?? [], [question.options]);
  /** 选择题（含例句填空 / 听音）：选项即作答按钮。 */
  const choiceMode = options.length > 0;
  /** 每个选项此刻的状态：唯一来源，组件不再自己判断高亮。 */
  const optionStates = useMemo(
    () =>
      resolveOptionStates({
        options,
        picked: response || null,
        answer: question.answer,
        phase,
      }),
    [options, response, question.answer, phase],
  );
  /**
   * 「还能不能作答」只看 phase（editable），不额外维护提交锁：
   * 答错后 phase 停在 retry，若用「phase 变化时解锁」的锁，
   * 第二次答错时 phase 前后都是 retry（judging 被批处理吞掉），锁就再也解不开。
   * 重复落库由 StudyView 的「同一题只记首次作答」兜底；按键 repeat 在 keydown 里挡。
   */
  /** 本次作答是否已经播报过判定结果，避免同一次判定重复触发。 */
  const verdictSentRef = useRef<AnswerPhase | null>(null);

  /** 选择题：选中即提交，不再经过「提交作答」按钮。 */
  const choose = useCallback(
    (option: string, optionIndex: number) => {
      verdictSentRef.current = null;
      setResponse(option);
      emitOptionFeedback({
        stage: 'pick',
        index: optionIndex,
        state: 'selected',
        option,
        questionId: question.id,
      });
      onSubmit(option);
    },
    [onSubmit, question.id],
  );

  // 判定落地（retry = 答错 / answered = 答对）时播报一次，供动效 / 声效订阅。
  useEffect(() => {
    if (!choiceMode) return;
    if (phase !== 'retry' && phase !== 'answered') return;
    if (verdictSentRef.current === phase) return;
    const index = options.findIndex((option) => option === response);
    if (index < 0) return;
    verdictSentRef.current = phase;
    emitOptionFeedback({
      stage: 'verdict',
      index,
      state: phase === 'answered' ? 'correct' : 'wrong',
      option: options[index],
      questionId: question.id,
    });
  }, [choiceMode, options, phase, question.id, response]);

  // 未作答 / 答错后都可用 A / B / C / D 直接作答（点击选项等价）。
  // 拼写 / 互译的输入框内不拦截按键，避免打断打字。
  useEffect(() => {
    if (!choiceMode || !editable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      if (event.key.length !== 1) return;
      const index = event.key.toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0);
      if (index < 0 || index >= options.length) return;
      event.preventDefault();
      choose(options[index], index);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [choiceMode, choose, editable, options]);

  function submit() {
    const value = response.trim();
    if (!value) return;
    onSubmit(value);
  }

  // poor 必须等流式结束、并且用户点过「我看完了」。
  const canAdvance = !mustReadExplanation || (readDone && !streaming);
  const countdownSeconds = autoAdvance ? Math.max(0, Math.ceil(autoAdvance.remaining / 1000)) : 0;
  const countdownRatio =
    autoAdvance && autoAdvance.total > 0
      ? Math.max(0, Math.min(1, autoAdvance.remaining / autoAdvance.total))
      : 0;

  return (
    <div className="practice-layout">
      {/* ------------------------------ 左栏：题目 ------------------------------ */}
      <section className="practice-card" aria-label="练习题">
        <header className="practice-card__head">
          <span className="badge badge--outline">{skillMeta?.label ?? '练习'}</span>
          <span className="practice-card__counter">
            第 <strong>{index + 1}</strong> / {total} 题
          </span>
        </header>

        <p className="practice-card__prompt">{question.prompt}</p>

        {question.audio ? (
          <div className="practice-card__audio">
            <button
              type="button"
              className="study-speak"
              onClick={() => onSpeak(word.term)}
              aria-label={`朗读 ${word.term}`}
            >
              <IconVolume size={15} />
              再听一次
            </button>
            <button
              type="button"
              className="study-speak"
              onClick={() => onSpeak(word.term, true)}
              aria-label={`慢速朗读 ${word.term}`}
            >
              慢速
            </button>
            <span className="practice-card__audio-hint">听发音，选出正确的释义。</span>
          </div>
        ) : null}

        {/* 题型只替换这块内容；上下锚点固定，卡片宽高不变 */}
        <div className="practice-card__body">
        {options.length > 0 ? (
          <ul className="practice-options">
            {options.map((option, optionIndex) => {
              const state: OptionState = optionStates[optionIndex] ?? 'idle';
              return (
                <li key={`${question.id}-${optionIndex}`}>
                  <button
                    type="button"
                    className={cx('practice-option', optionStateClass(state))}
                    data-option-state={state}
                    disabled={!editable}
                    aria-keyshortcuts={String.fromCharCode(65 + optionIndex)}
                    onClick={() => choose(option, optionIndex)}
                  >
                    <span className="practice-option__key" aria-hidden="true">
                      {String.fromCharCode(65 + optionIndex)}
                    </span>
                    <span className="practice-option__text">{option}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : question.skill === 'spell' ? (
          <div className="practice-input">
            <label className="label" htmlFor="practice-spell">
              写出这个单词
            </label>
            <input
              id="practice-spell"
              ref={inputRef as React.RefObject<HTMLInputElement>}
              className="input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={response}
              disabled={!editable}
              placeholder="在这里作答后回车"
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.repeat) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        ) : (
          <div className="practice-input">
            <label className="label" htmlFor="practice-translate">
              {question.direction === 'zh2en' ? '写出英文译文' : '写出中文译文'}
            </label>
            <textarea
              id="practice-translate"
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              className="textarea"
              rows={3}
              value={response}
              disabled={!editable}
              placeholder="写下你的译文"
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className="hint">Cmd / Ctrl + Enter 提交译文；AI 会逐条判分并给出改进建议。</p>
          </div>
        )}
        </div>

        {/* 提交 / 判分 / 提示钉在卡片底部，所有题型位置一致 */}
        <div className="practice-card__foot">
        {editable && !choiceMode ? (
          <div className="practice-card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!response.trim()}
              onClick={submit}
            >
              {phase === 'retry' ? '再提交' : translation ? '提交译文' : '提交作答'}
            </button>
          </div>
        ) : null}

        {phase === 'judging' ? (
          <p className="practice-feedback__pending">正在判分…</p>
        ) : null}

        {phase === 'retry' ? (
          <p className="practice-card__hint practice-card__hint--retry">
            {choiceMode
              ? '答错了，题目没有锁 —— 直接选下一个，直到选对为止。'
              : '答错了，题目没有锁 —— 改完再提交一次。'}
          </p>
        ) : !answered && phase === 'idle' ? (
          <p className="practice-card__hint">
            {choiceMode
              ? '点选项直接作答，也可以按 A / B / C / D 选择。'
              : translation
                ? '译文由 AI 判分：三档 perfect / good / poor。'
                : question.skill === 'spell'
                  ? '拼写不计大小写，但要注意词形变化。'
                  : '写完按 Cmd / Ctrl + Enter 提交。'}
          </p>
        ) : null}
        </div>
      </section>

      {/* --------------------------- 右栏：反馈容器 ---------------------------
          这一栏在所有题型、作答前后都常驻：未作答时是同尺寸占位纸面，
          作答后只替换栏内内容，题目卡的宽度/高度/边界完全不变。 */}
      <aside
        ref={paneRef}
        className={cx('practice-feedback-pane', !feedback && 'is-idle')}
        role="status"
        aria-live={feedback ? 'polite' : 'off'}
        aria-label="答题反馈"
        aria-hidden={!feedback || undefined}
      >
        {feedback ? (
          <div
            className={cx(
              'practice-feedback-panel',
              feedback.verdict
                ? `is-verdict ${VERDICT_META[feedback.verdict].tone}`
                : 'is-graded',
            )}
          >
            <div className="practice-feedback">
              <div className="practice-feedback__head">
                <strong>
                  {feedback.verdict
                    ? VERDICT_META[feedback.verdict].label
                    : feedback.streaming
                      ? '讲解中'
                      : '已记录'}
                </strong>
                {feedback.streaming ? (
                  <span className="practice-feedback__live">正在流式输出…</span>
                ) : feedback.status === 'local-fallback' ? (
                  <span className="practice-feedback__badge">本地解析</span>
                ) : feedback.status === 'failed' ? (
                  <span className="practice-feedback__badge">讲解失败 · 本地解析</span>
                ) : null}
              </div>

              {feedback.text ? (
                <p className="practice-feedback__text">{feedback.text}</p>
              ) : null}

              {feedback.improvement ? (
                <p className="practice-feedback__improve">
                  <span className="practice-feedback__label">改进</span>
                  {feedback.improvement}
                </p>
              ) : null}

              {showWordInfo ? (
                <div className="practice-wordinfo">
                  <p className="practice-wordinfo__title">{word.term}</p>
                  <p className="practice-wordinfo__meta">
                    {word.phonetic ? <span>{word.phonetic}</span> : null}
                    {word.partOfSpeech ? <span>{word.partOfSpeech}</span> : null}
                    {word.tags.length > 0 ? (
                      <span>{word.tags.map((tag) => `#${tag}`).join(' ')}</span>
                    ) : null}
                  </p>
                  <p className="practice-wordinfo__meaning">{word.meaning}</p>
                  {word.example ? (
                    <figure className="practice-wordinfo__example">
                      <blockquote>{word.example}</blockquote>
                      {word.exampleTranslation ? (
                        <figcaption>{word.exampleTranslation}</figcaption>
                      ) : null}
                    </figure>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* 操作区钉在容器底部，正文再长也不用滚动去找「下一题」 */}
            <div className="practice-feedback__footer">
              <div className="practice-feedback__actions">
                {onAskExplain ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={explaining}
                    onClick={onAskExplain}
                  >
                    {explaining ? '正在讲解…' : '让 AI 讲讲'}
                  </button>
                ) : null}

                {mustReadExplanation && !readDone ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={streaming}
                    onClick={() => setReadDone(true)}
                  >
                    我看完了
                  </button>
                ) : null}
                {/* 答错不锁题：主按钮让位给「跳过这题」，鼓励继续作答但不困住人 */}
                {phase === 'retry' ? (
                  <button type="button" className="btn btn--ghost" onClick={onNext}>
                    跳过这题
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!canAdvance}
                    onClick={onNext}
                  >
                    {mustReadExplanation && !readDone ? '先看完讲解' : '下一题'}
                  </button>
                )}
              </div>

              {autoAdvance ? (
                <div className="practice-countdown">
                  <span className="practice-countdown__track" aria-hidden="true">
                    <span style={{ width: `${countdownRatio * 100}%` }} />
                  </span>
                  <span className="practice-countdown__text">
                    {countdownSeconds > 0
                      ? `${countdownSeconds} 秒后自动进入下一题`
                      : '即将进入下一题…'}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="practice-feedback-panel practice-feedback-panel--idle">
            <p className="practice-feedback__idle">作答后，这里显示讲解与「下一题」。</p>
          </div>
        )}
      </aside>
    </div>
  );
}
