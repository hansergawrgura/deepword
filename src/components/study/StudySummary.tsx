/**
 * 本轮小结 —— 一张被「阅」过的成绩单。
 *
 * 只负责展示：四档自评的分布、正确率、用时，以及值得再看一眼的词。
 * 「再来一轮 / 去特训」由 StudyView 决定队列与导航。
 */

import type { Grade, StudyMode, Word } from '@/types';
import { GRADE_META } from '@/lib/srs';
import { cx, percent, truncate } from '@/lib/utils';
import { IconRefresh, IconSparkle } from '../ui/icons';

export interface RoundResult {
  wordId: string;
  grade: Grade;
}

interface StudySummaryProps {
  mode: StudyMode;
  counts: Record<Grade, number>;
  results: RoundResult[];
  elapsedMs: number;
  words: Word[];
  onAgain: () => void;
  onDrill: () => void;
}

const GRADE_ORDER: Grade[] = ['again', 'hard', 'good', 'easy'];

const MODE_LABEL: Record<StudyMode, string> = {
  mixed: '混合模式',
  review: '只复习',
  new: '只学新词',
};

const REVIEW_LIMIT = 6;

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

export default function StudySummary({
  mode,
  counts,
  results,
  elapsedMs,
  words,
  onAgain,
  onDrill,
}: StudySummaryProps) {
  const graded = results.length;
  const accuracy = percent(graded - counts.again, graded);
  const duration = formatDuration(elapsedMs);
  const needReview = results.filter(
    (result) => result.grade === 'again' || result.grade === 'hard',
  );
  const reviewItems = needReview
    .map((result) => ({
      result,
      word: words.find((word) => word.id === result.wordId),
    }))
    .filter((item): item is { result: RoundResult; word: Word } => Boolean(item.word));

  return (
    <section className="study-report enter-up" aria-label="本轮小结">
      <span className="seal study-report__seal" aria-hidden="true">
        阅
      </span>

      <header className="study-report__head">
        <div>
          <h2 className="study-report__title">本轮成绩</h2>
          <p className="study-report__sub">
            <span>{MODE_LABEL[mode]}</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>翻过 {graded} 张</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>用时 {duration}</span>
          </p>
        </div>
      </header>

      <div className="study-report__score">
        <div className="study-report__accuracy">
          <strong>
            {accuracy}
            <em>%</em>
          </strong>
          <span>本轮正确率</span>
        </div>

        <dl className="study-report__brief">
          <div className="study-report__brief-item">
            <dt>记住了</dt>
            <dd>{counts.good + counts.easy}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>没记住</dt>
            <dd>{counts.again}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>待再看</dt>
            <dd>{needReview.length}</dd>
          </div>
        </dl>
      </div>

      <ul className="study-report__grades" aria-label="自评分布">
        {GRADE_ORDER.map((grade) => {
          const count = counts[grade];
          const share = percent(count, graded);
          return (
            <li key={grade} className={cx('study-report__grade', `is-${grade}`)}>
              <span className="study-report__grade-label">{GRADE_META[grade].label}</span>
              <span className="study-report__grade-track" aria-hidden="true">
                <span style={{ width: `${share}%` }} />
              </span>
              <span className="study-report__grade-count">
                {count} 张
                <em>{share}%</em>
              </span>
            </li>
          );
        })}
      </ul>

      {reviewItems.length > 0 ? (
        <div className="study-report__review">
          <h3 className="study-report__review-title">需要再看一眼</h3>
          <ul className="study-report__review-list">
            {reviewItems.slice(0, REVIEW_LIMIT).map(({ result, word }) => (
              <li
                key={result.wordId}
                className={cx('study-report__review-row', `is-${result.grade}`)}
              >
                <span className="study-report__review-term">{word.term}</span>
                <span className="study-report__review-meaning">
                  {truncate(word.meaning, 28)}
                </span>
                <span className="study-report__review-tag">
                  {GRADE_META[result.grade].label}
                </span>
              </li>
            ))}
          </ul>
          {reviewItems.length > REVIEW_LIMIT ? (
            <p className="study-report__more">
              另有 {reviewItems.length - REVIEW_LIMIT} 个词也在等你，去错题特训接着来。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="study-report__clear">这一轮没有需要重看的词，手感正好。</p>
      )}

      <div className="study-report__actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={onAgain}>
          <IconRefresh size={17} />
          再来一轮
        </button>
        <button type="button" className="btn btn--ghost btn--lg" onClick={onDrill}>
          <IconSparkle size={16} />
          去错题 AI 特训
        </button>
      </div>
    </section>
  );
}
