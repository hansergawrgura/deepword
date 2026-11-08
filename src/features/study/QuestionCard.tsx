/**
 * Wrong answers keep the question unlocked (retry) until correct or skip;
 * translation `poor` requires reading the explanation before next.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Question, Word } from '@/domain/types';
import { isTranslation } from '@/domain/practice';
import { cx } from '@/domain/utils';
import { useT } from '@/i18n';
import { IconVolume } from '@/ui/icons';
import ClickableWords from './lookup/ClickableWords';
import SelectionAssist from './lookup/SelectionAssist';
import type { LookupAnchor, StudyLookupApi } from './lookup/useStudyLookup';
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
  index: number;
  total: number;
  phase: AnswerPhase;
  feedback: AnswerFeedbackState | null;
  showWordInfo: boolean;
  /** Translation `poor`: block Next until the learner confirms they read the explanation. */
  mustReadExplanation: boolean;
  /** Auto-advance countdown after a correct answer; null = manual Next. */
  autoAdvance?: { remaining: number; total: number } | null;
  onAskExplain?: () => void;
  explaining?: boolean;
  lookup?: Pick<StudyLookupApi, 'lookup'>;
  onSubmit: (response: string) => void;
  onNext: () => void;
  onSpeak: (text: string, slow?: boolean) => void;
}

const VERDICT_TONE = {
  perfect: 'is-perfect',
  good: 'is-good',
  poor: 'is-poor',
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
  lookup,
  onSubmit,
  onNext,
  onSpeak,
}: QuestionCardProps) {
  const t = useT();
  const [response, setResponse] = useState('');
  const [readDone, setReadDone] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const translation = isTranslation(question);
  const skillLabel = question.skill
    ? t(`domain.skill.${question.skill}.label` as const)
    : t('domain.skill.fallback');
  const answered = phase === 'answered';
  /** 题目是否仍可继续作答：idle（未答）与 retry（答错后）都可。 */
  const editable = isAnswering(phase);
  const streaming = feedback?.streaming ?? false;
  /** 作答后（含判分中）才展开右栏；下一题 phase 回到 idle 即收缩。 */
  const feedbackOpen = phase !== 'idle';

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
        target.closest(
          'input, textarea, select, [contenteditable="true"], .study-word-hot, .study-search, .study-lookup-pop',
        )
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

  const onWordClick = useCallback(
    (token: string, anchor: LookupAnchor) => {
      void lookup?.lookup('word', token, anchor);
    },
    [lookup],
  );

  const onSelectionExplain = useCallback(
    (text: string, anchor: LookupAnchor) => {
      void lookup?.lookup('sentence', text, anchor);
    },
    [lookup],
  );

  // poor 必须等流式结束、并且用户点过「我看完了」。
  const canAdvance = !mustReadExplanation || (readDone && !streaming);
  const countdownSeconds = autoAdvance ? Math.max(0, Math.ceil(autoAdvance.remaining / 1000)) : 0;
  const countdownRatio =
    autoAdvance && autoAdvance.total > 0
      ? Math.max(0, Math.min(1, autoAdvance.remaining / autoAdvance.total))
      : 0;

  return (
    <div className={cx('practice-layout', feedbackOpen && 'is-feedback-open')}>
      {/* ------------------------------ 左栏：题目 ------------------------------ */}
      <section ref={cardRef} className="practice-card" aria-label={t('study.practiceAria')}>
        <header className="practice-card__head">
          <span className="badge badge--outline">{skillLabel}</span>
          <span className="practice-card__counter">
            {t('study.counter', { current: index + 1, total })}
          </span>
        </header>

        <p className="practice-card__prompt">
          {lookup ? (
            <ClickableWords text={question.prompt} onWordClick={onWordClick} />
          ) : (
            question.prompt
          )}
        </p>

        {question.audio ? (
          <div className="practice-card__audio">
            <button
              type="button"
              className="study-speak"
              onClick={() => onSpeak(word.term)}
              aria-label={t('study.speakAria', { term: word.term })}
            >
              <IconVolume size={15} />
              {t('study.listenAgain')}
            </button>
            <button
              type="button"
              className="study-speak"
              onClick={() => onSpeak(word.term, true)}
              aria-label={t('study.slowSpeak', { term: word.term })}
            >
              {t('study.slow')}
            </button>
            <span className="practice-card__audio-hint">{t('domain.practice.listenPrompt')}</span>
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
                    {/* 选项本身是 button，不能再嵌套点词热点；选中文字用 SelectionAssist。 */}
                    <span className="practice-option__text">{option}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : question.skill === 'spell' ? (
          <div className="practice-input">
            <label className="label" htmlFor="practice-spell">
              {t('study.spellLabel')}
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
              placeholder={t('study.spellPlaceholder')}
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
              {question.direction === 'zh2en' ? t('study.translateEn') : t('study.translateZh')}
            </label>
            <textarea
              id="practice-translate"
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              className="textarea"
              rows={3}
              value={response}
              disabled={!editable}
              placeholder={t('study.translatePlaceholder')}
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <p className="hint">{t('study.translateSubmitHint')}</p>
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
              {phase === 'retry' ? t('study.submitRetry') : translation ? t('study.submitTranslation') : t('study.submitAnswer')}
            </button>
          </div>
        ) : null}

        {phase === 'judging' ? (
          <p className="practice-feedback__pending">{t('study.judging')}</p>
        ) : null}

        {phase === 'retry' ? (
          <p className="practice-card__hint practice-card__hint--retry">
            {choiceMode
              ? t('study.retryChoice')
              : t('study.retryInput')}
          </p>
        ) : !answered && phase === 'idle' ? (
          <p className="practice-card__hint">
            {choiceMode
              ? t('study.hintChoice')
              : translation
                ? t('study.hintTranslation')
                : question.skill === 'spell'
                  ? t('study.hintSpell')
                  : t('study.hintEnter')}
          </p>
        ) : null}
        </div>

        {lookup ? <SelectionAssist rootRef={cardRef} onExplain={onSelectionExplain} /> : null}
      </section>

      {/* --------------------------- 右栏：反馈容器 ---------------------------
          始终挂载以便宽度动画；.is-feedback-open 控制展开，下一题收缩。 */}
      <aside
        ref={paneRef}
        className={cx('practice-feedback-pane', !feedback && 'is-idle')}
        role="status"
        aria-live={feedbackOpen && feedback ? 'polite' : 'off'}
        aria-label={t('study.feedbackAria')}
        aria-hidden={!feedbackOpen || undefined}
        inert={!feedbackOpen || undefined}
      >
        {feedback ? (
          <div
            className={cx(
              'practice-feedback-panel',
              feedback.verdict
                ? `is-verdict ${VERDICT_TONE[feedback.verdict]}`
                : 'is-graded',
            )}
          >
            <div className="practice-feedback">
              <div className="practice-feedback__head">
                <strong>
                  {feedback.verdict
                    ? (feedback.verdict === 'perfect'
                      ? t('study.verdictPerfect')
                      : feedback.verdict === 'good'
                        ? t('study.verdictGood')
                        : t('study.verdictPoor'))
                    : feedback.streaming
                      ? t('study.explaining')
                      : t('study.recorded')}
                </strong>
                {feedback.streaming ? (
                  <span className="practice-feedback__live">{t('study.streaming')}</span>
                ) : feedback.status === 'local-fallback' ? (
                  <span className="practice-feedback__badge">{t('study.localFallback')}</span>
                ) : feedback.status === 'failed' ? (
                  <span className="practice-feedback__badge">{t('study.explainFailed')}</span>
                ) : null}
              </div>

              {feedback.text ? (
                <p className="practice-feedback__text">{feedback.text}</p>
              ) : null}

              {feedback.improvement ? (
                <p className="practice-feedback__improve">
                  <span className="practice-feedback__label">{t('study.improvement')}</span>
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

            <div className="practice-feedback__footer">
              <div className="practice-feedback__actions">
                {onAskExplain ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={explaining}
                    onClick={onAskExplain}
                  >
                    {explaining ? t('study.askingAi') : t('study.askAi')}
                  </button>
                ) : null}

                {mustReadExplanation && !readDone ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={streaming}
                    onClick={() => setReadDone(true)}
                  >
                    {t('study.readDone')}
                  </button>
                ) : null}
                {phase === 'retry' ? (
                  <button type="button" className="btn btn--ghost" onClick={onNext}>
                    {t('study.skipQuestion')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={!canAdvance}
                    onClick={onNext}
                  >
                    {mustReadExplanation && !readDone ? t('study.readFirst') : t('study.nextQuestion')}
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
                      ? t('study.autoAdvance', { seconds: countdownSeconds })
                      : t('study.autoAdvanceSoon')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="practice-feedback-panel practice-feedback-panel--idle">
            <p className="practice-feedback__idle">
              {feedbackOpen
                ? phase === 'judging'
                  ? t('study.idleJudging')
                  : t('study.idleGenerating')
                : t('study.idlePlaceholder')}
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}
