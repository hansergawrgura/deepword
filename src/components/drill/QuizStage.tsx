/**
 * 第三阶段：逐题作答。
 *
 * 一张有左侧朱线、题号与答题区的「特训卷」：选择题选中后判分，填空在
 * 句内横线上直接写；判分后立即给出对错、正解与中文解析，并露出考查词。
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { Exercise, Word } from '@/types';
import { cx, normalizeAnswer, percent, speak } from '@/lib/utils';
import { CheckIcon, CrossIcon, SpeakerIcon } from './Icons';
import { EXERCISE_TYPE_META, OPTION_LETTERS, SOURCE_LABEL } from './meta';

interface QuizStageProps {
  exercise: Exercise;
  word?: Word;
  index: number;
  total: number;
  answered: number;
  graded: boolean;
  correct: boolean;
  selection: number | null;
  fillValue: string;
  onSelectOption: (index: number) => void;
  onFillChange: (value: string) => void;
  onGrade: () => void;
  onNext: () => void;
  onEnd: () => void;
  /** 交给父组件，在换题时把卷面滚回视野。 */
  scrollRef: RefObject<HTMLDivElement | null>;
}

export default function QuizStage({
  exercise,
  word,
  index,
  total,
  answered,
  graded,
  correct,
  selection,
  fillValue,
  onSelectOption,
  onFillChange,
  onGrade,
  onNext,
  onEnd,
  scrollRef,
}: QuizStageProps) {
  const fillRef = useRef<HTMLInputElement | null>(null);
  const feedbackRef = useRef<HTMLDivElement | null>(null);
  const options = exercise.options ?? [];
  const hasOptions = options.length > 0;
  const progress = percent(answered, total);
  const isLast = index + 1 >= total;

  // 填空题在桌面端自动聚焦（触屏设备不主动弹键盘）。
  useEffect(() => {
    if (graded || hasOptions) return;
    const input = fillRef.current;
    if (!input) return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(pointer: fine)').matches) return;
    input.focus({ preventScroll: true });
  }, [graded, hasOptions, index]);

  // 判分后若解析被挤出视口，轻轻把它带回来。
  useEffect(() => {
    if (!graded) return;
    const node = feedbackRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewport = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom > viewport - 8) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [graded]);

  const optionState = (option: string, optionIndex: number) => {
    if (!graded) return selection === optionIndex ? 'is-selected' : '';
    const isAnswer = normalizeAnswer(option) === normalizeAnswer(exercise.answer);
    if (isAnswer) return 'is-correct';
    if (selection === optionIndex) return 'is-wrong';
    return 'is-muted';
  };

  const renderInput = () => (
    <input
      ref={fillRef}
      className={cx('drill-blank', graded && (correct ? 'is-correct' : 'is-wrong'))}
      type="text"
      value={fillValue}
      size={Math.min(20, Math.max(8, exercise.answer.length + 2))}
      readOnly={graded}
      placeholder="填写单词"
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      aria-label="填写缺失的单词"
      aria-invalid={graded && !correct}
      onChange={(event) => onFillChange(event.target.value)}
    />
  );

  const renderPrompt = () => {
    if (hasOptions) {
      return <p className="drill-prompt">{exercise.prompt}</p>;
    }
    const match = exercise.prompt.match(/_{2,}|＿{2,}/);
    if (!match || match.index === undefined) {
      return (
        <>
          <p className="drill-prompt">{exercise.prompt}</p>
          <div className="drill-fill-standalone">{renderInput()}</div>
        </>
      );
    }
    const start = match.index;
    const end = start + match[0].length;
    return (
      <p className="drill-prompt drill-prompt--fill">
        {exercise.prompt.slice(0, start)}
        {renderInput()}
        {exercise.prompt.slice(end)}
      </p>
    );
  };

  const response = hasOptions
    ? selection === null
      ? ''
      : (options[selection] ?? '')
    : fillValue.trim();

  return (
    <section className="drill-quiz" aria-label="错题特训答题">
      <div className="drill-quiz__top" ref={scrollRef}>
        <p className="drill-quiz__counter">
          第 <b>{index + 1}</b> 题
          <span className="drill-quiz__total"> / 共 {total} 题</span>
        </p>
        <div
          className="progress drill-quiz__progress"
          role="progressbar"
          aria-label="作答进度"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
        >
          <span className="progress__bar" style={{ width: `${progress}%` }} />
        </div>
        <button
          type="button"
          className="btn btn--quiet btn--sm drill-quiz__end"
          onClick={onEnd}
        >
          结束特训
        </button>
      </div>

      <article className={cx('drill-paper', graded && (correct ? 'is-correct' : 'is-wrong'))}>
        <header className="drill-paper__head">
          <span className="badge badge--vermilion">
            {EXERCISE_TYPE_META[exercise.type].label}
          </span>
          <span className="drill-paper__rule" aria-hidden="true" />
          <span className="mono-label drill-paper__source">{SOURCE_LABEL[exercise.source]}</span>
        </header>

        <div className="drill-paper__body">
          <span className="drill-paper__no" aria-hidden="true">
            {index + 1}
          </span>

          {renderPrompt()}

          {hasOptions ? (
            <div className="drill-options" role="group" aria-label="选项">
              {options.map((option, optionIndex) => (
                <button
                  key={`${optionIndex}-${option}`}
                  type="button"
                  className={cx('drill-option', optionState(option, optionIndex))}
                  aria-pressed={selection === optionIndex}
                  disabled={graded}
                  onClick={() => onSelectOption(optionIndex)}
                >
                  <span className="drill-option__letter" aria-hidden="true">
                    {OPTION_LETTERS[optionIndex] ?? String(optionIndex + 1)}
                  </span>
                  <span className="drill-option__text">{option}</span>
                  <span className="drill-option__mark" aria-hidden="true">
                    {graded ? (
                      normalizeAnswer(option) === normalizeAnswer(exercise.answer) ? (
                        <CheckIcon size={14} />
                      ) : selection === optionIndex ? (
                        <CrossIcon size={14} />
                      ) : null
                    ) : (
                      <span className="drill-option__key">{optionIndex + 1}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="drill-prompt__note">根据句意，在横线上填入缺失的单词。</p>
          )}

          {!graded ? (
            <div className="drill-quiz__hintbar">
              <p className="hint drill-quiz__keys">
                {hasOptions ? (
                  <>
                    <span className="kbd">1</span>–<span className="kbd">4</span> 选择，
                    <span className="kbd">Enter</span> 判分
                  </>
                ) : (
                  <>
                    写好之后按 <span className="kbd">Enter</span> 提交
                  </>
                )}
              </p>
              <button
                type="button"
                className="btn btn--primary"
                disabled={hasOptions ? selection === null : fillValue.trim().length === 0}
                onClick={onGrade}
              >
                判分
              </button>
            </div>
          ) : (
            <div className="drill-feedback" ref={feedbackRef} aria-live="polite">
              <div className="drill-feedback__top">
                <span
                  className={cx(
                    'drill-stamp',
                    correct ? 'drill-stamp--right' : 'drill-stamp--wrong',
                  )}
                  aria-hidden="true"
                >
                  {correct ? '对' : '误'}
                </span>
                <div className="drill-feedback__verdict">
                  <p className={cx('drill-feedback__title', !correct && 'is-wrong')}>
                    {correct ? '答对了' : '答错了'}
                  </p>
                  <dl className="drill-feedback__keys">
                    {!correct && (
                      <div>
                        <dt>你答</dt>
                        <dd className="is-wrong">{response || '留白'}</dd>
                      </div>
                    )}
                    <div>
                      <dt>正解</dt>
                      <dd className="is-correct">{exercise.answer}</dd>
                    </div>
                  </dl>
                </div>
              </div>

              <p className="drill-feedback__explain">{exercise.explanation}</p>

              {word && (
                <div className="drill-feedback__word">
                  <button
                    type="button"
                    className="icon-btn drill-feedback__speak"
                    aria-label={`朗读 ${word.term}`}
                    onClick={() => speak(word.term)}
                  >
                    <SpeakerIcon size={15} />
                  </button>
                  <span className="drill-feedback__term">{word.term}</span>
                  {word.phonetic && (
                    <span className="drill-feedback__phonetic">{word.phonetic}</span>
                  )}
                  <span className="drill-feedback__meaning">{word.meaning}</span>
                </div>
              )}

              <div className="drill-feedback__foot">
                <p className="hint">
                  <span className="kbd">Enter</span> {isLast ? '查看成绩' : '下一题'}
                </p>
                <button type="button" className="btn btn--primary" onClick={onNext}>
                  {isLast ? '查看本卷成绩' : '下一题'}
                </button>
              </div>
            </div>
          )}
        </div>
      </article>
    </section>
  );
}
