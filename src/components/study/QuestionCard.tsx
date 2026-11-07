/**
 * 一道题的面板：题干、选项/输入、判分反馈。
 *
 * 反馈规则（Phase B）：
 * - 答对：本地鼓励语，按 settings.feedbackAutoAdvanceMs 自动下一题（0 = 手动），
 *   自动跳转期间显示倒计时（剩余秒数 + 进度条）；
 * - 答错：流式 AI 讲解（错因 + 记忆点 + 改进），**永远不自动跳题**；
 *   关闭「自动讲解」时先给本地解析（local-fallback 角标）+「让 AI 讲讲」手动按钮；
 * - 互译：三档判分；`poor` 必须等流式结束且点过「我看完了」才能下一题；
 * - 新词第 1 题的反馈附完整词条信息。
 *
 * 布局：固定双栏，左栏题目卡、右栏反馈容器常驻（未作答时为同尺寸占位）。
 * 反馈只替换右栏内容，两栏宽高、间距、题目卡边界在所有题型与作答阶段
 * 都保持一致，不产生缩放 / 位移 / 跳动。窄屏降级为上下排列。
 *
 * 组件不直接读写数据，判分与记录由 StudyView 驱动。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Exercise, Word } from '@/types';
import { SKILL_META, isTranslation } from '@/lib/practice';
import { cx } from '@/lib/utils';
import { IconVolume } from '../ui/icons';
import type { AnswerFeedbackState, AnswerPhase } from './types';

export interface QuestionCardProps {
  question: Exercise;
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
  const streaming = feedback?.streaming ?? false;

  // 换题时清空输入与「看完了」标记
  useEffect(() => {
    setResponse('');
    setReadDone(false);
  }, [question.id]);

  // 未作答时把焦点交给输入框（拼写与互译）
  useEffect(() => {
    if (phase !== 'idle' || translation) return;
    if (question.type === 'spell') inputRef.current?.focus();
  }, [phase, question.id, question.type, translation]);

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
              const selected = response === option;
              const isAnswer = answered && question.answer === option;
              const isWrongPick = answered && selected && !isAnswer;
              return (
                <li key={`${question.id}-${optionIndex}`}>
                  <button
                    type="button"
                    className={cx(
                      'practice-option',
                      selected && 'is-selected',
                      isAnswer && 'is-correct',
                      isWrongPick && 'is-wrong',
                    )}
                    disabled={phase !== 'idle'}
                    onClick={() => setResponse(option)}
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
        ) : question.type === 'spell' ? (
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
              disabled={phase !== 'idle'}
              placeholder="在这里作答后回车"
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
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
              disabled={phase !== 'idle'}
              placeholder="写下你的译文"
              onChange={(event) => setResponse(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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
        {phase === 'idle' ? (
          <div className="practice-card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!response.trim()}
              onClick={submit}
            >
              {translation ? '提交译文' : '提交作答'}
            </button>
          </div>
        ) : null}

        {phase === 'judging' ? (
          <p className="practice-feedback__pending">正在判分…</p>
        ) : null}

        {!answered && phase === 'idle' ? (
          <p className="practice-card__hint">
            {translation
              ? '译文由 AI 判分：三档 perfect / good / poor。'
              : question.type === 'spell'
                ? '拼写不计大小写，但要注意词形变化。'
                : '选一个最贴切的答案。'}
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
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!canAdvance}
                  onClick={onNext}
                >
                  {mustReadExplanation && !readDone ? '先看完讲解' : '下一题'}
                </button>
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
