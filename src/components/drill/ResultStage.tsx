/**
 * 第四阶段：本轮成绩单。
 *
 * 编辑排版感的复盘页：大号衬线正确率、一句「批语」、错题逐条对照
 * 你答 / 正解，以及再练一组 / 去闪卡 / 回首页三个出口。
 */

import type { ViewId, Word } from '@/types';
import { formatDate, percent, speak } from '@/lib/utils';
import { SpeakerIcon } from './Icons';
import {
  EXERCISE_TYPE_META,
  batchComment,
  formatDuration,
  sourceSummary,
} from './meta';
import type { AnswerRecord } from './types';

interface ResultStageProps {
  answers: AnswerRecord[];
  /** 本卷实际生成的题数（可能多于已答）。 */
  totalQuestions: number;
  durationMs: number;
  finishedAt: number;
  words: Map<string, Word>;
  onRestart: () => void;
  onNavigate: (view: ViewId) => void;
}

export default function ResultStage({
  answers,
  totalQuestions,
  durationMs,
  finishedAt,
  words,
  onRestart,
  onNavigate,
}: ResultStageProps) {
  const correctCount = answers.filter((record) => record.correct).length;
  const wrongAnswers = answers.filter((record) => !record.correct);
  const accuracy = percent(correctCount, answers.length);
  const duration = formatDuration(durationMs);
  const sourceLabel = sourceSummary(answers.map((record) => record.exercise.source));
  const comment = batchComment(accuracy, wrongAnswers.length, answers.length, totalQuestions);
  const unanswered = Math.max(0, totalQuestions - answers.length);

  return (
    <section className="drill-result" aria-label="本轮特训成绩">
      <article className="drill-report">
        <span className="drill-stamp drill-stamp--right drill-report__stamp" aria-hidden="true">
          阅
        </span>

        <header className="drill-report__head">
          <div>
            <p className="mono-label">REPORT / 本轮成绩</p>
            <h2 className="drill-report__title">特训成绩单</h2>
          </div>
          <p className="drill-report__date">{formatDate(finishedAt)}</p>
        </header>

        <div className="drill-report__hero">
          <div className="drill-report__score">
            <span className="drill-report__number">{accuracy}</span>
            <span className="drill-report__pct">%</span>
            <p className="drill-report__score-label">本轮正确率</p>
          </div>
          <div className="drill-report__comment">
            <p className="mono-label">批语</p>
            <p className="drill-report__comment-text">{comment}</p>
            <p className="hint">
              {sourceLabel}，已答 {answers.length} / {totalQuestions} 题，用时 {duration}
            </p>
          </div>
        </div>

        <dl className="drill-report__stats">
          <div>
            <dt>答对</dt>
            <dd>{correctCount}</dd>
          </div>
          <div>
            <dt>答错</dt>
            <dd>{wrongAnswers.length}</dd>
          </div>
          <div>
            <dt>已答</dt>
            <dd>
              {answers.length}
              <span className="drill-report__denom"> / {totalQuestions}</span>
            </dd>
          </div>
          <div>
            <dt>用时</dt>
            <dd className="drill-report__duration">{duration}</dd>
          </div>
        </dl>

        {unanswered > 0 && (
          <p className="hint drill-report__unfinished">
            还有 {unanswered} 题未作答，已答部分的成绩仍会记入学习记录。
          </p>
        )}

        {wrongAnswers.length > 0 ? (
          <section className="drill-review" aria-label="错题复盘">
            <header className="drill-review__head">
              <h3 className="drill-review__title">错题复盘</h3>
              <span className="drill-review__count">{wrongAnswers.length} 处错笔</span>
            </header>
            <ul className="drill-review__list">
              {wrongAnswers.map((record, position) => {
                const word = words.get(record.exercise.wordId);
                const response = record.response || '留白';
                return (
                  <li
                    key={`${record.exercise.id}-${position}`}
                    className="drill-review__item"
                  >
                    <div className="drill-review__word">
                      <div className="drill-review__term-row">
                        <span className="drill-review__term">{word?.term ?? '未知词条'}</span>
                        {word?.phonetic && (
                          <span className="drill-review__phonetic">{word.phonetic}</span>
                        )}
                        {word && (
                          <button
                            type="button"
                            className="icon-btn drill-review__speak"
                            aria-label={`朗读 ${word.term}`}
                            onClick={() => speak(word.term)}
                          >
                            <SpeakerIcon size={13} />
                          </button>
                        )}
                      </div>
                      <p className="drill-review__meaning">
                        {word?.meaning ?? '该词已从词库移除'}
                      </p>
                    </div>

                    <dl className="drill-review__answers">
                      <div>
                        <dt>你答</dt>
                        <dd className="is-wrong">{response}</dd>
                      </div>
                      <div>
                        <dt>正解</dt>
                        <dd className="is-correct">{record.exercise.answer}</dd>
                      </div>
                    </dl>

                    <span className="badge badge--outline drill-review__type">
                      {EXERCISE_TYPE_META[record.exercise.type].short}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <div className="drill-perfect">
            <span
              className="drill-stamp drill-stamp--right drill-perfect__stamp"
              aria-hidden="true"
            >
              全
            </span>
            <div>
              <p className="drill-perfect__title">本卷无错</p>
              <p className="hint">
                这一轮没有留下错处。去闪卡里把这几个词再巩固一遍，就算彻底收下了。
              </p>
            </div>
          </div>
        )}

        <footer className="drill-report__foot">
          <div className="drill-report__actions">
            <button type="button" className="btn btn--primary" onClick={onRestart}>
              再练一组
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onNavigate('study')}
            >
              去闪卡复习
            </button>
            <button
              type="button"
              className="btn btn--quiet"
              onClick={() => onNavigate('dashboard')}
            >
              回首页
            </button>
          </div>
          <p className="hint drill-report__note">每题作答已即时写入学习记录</p>
        </footer>
      </article>
    </section>
  );
}
