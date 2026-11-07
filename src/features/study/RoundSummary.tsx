/**
 * 一轮的小结：成绩单 + 技能分布 + 仍薄弱词 + 掌握判定进度。
 *
 * 只负责展示；「继续下一轮」由 StudyView 决定下一轮的选词与题量。
 */

import type { PracticeSessionState, Skill, Word } from '@/domain/types';
import { SKILL_META } from '@/domain/practice';
import type { MasteryCheck } from '@/domain/mastery';
import type { WeakWordStat } from '@/domain/weakness';
import { percent, truncate } from '@/domain/utils';
import { IconRefresh } from '@/ui/icons';

/** 本轮某个新词的掌握判定进度。 */
export interface MasteryProgressRow {
  word: Word;
  check: MasteryCheck;
}

export interface RoundSummaryProps {
  session: PracticeSessionState;
  words: Word[];
  elapsedMs: number;
  /** 新词是否已掌握（闸门确认）。 */
  masteredWordId?: string | null;
  /** 全局仍薄弱词（来自 weakness.getWeaknessReport）。 */
  weakWords?: WeakWordStat[];
  /** 本轮新词的掌握判定进度（来自 mastery.evaluateMastery）。 */
  masteryRows?: MasteryProgressRow[];
  onContinue: () => void;
  onFinish: () => void;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 100_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
}

export default function RoundSummary({
  session,
  words,
  elapsedMs,
  masteredWordId,
  weakWords = [],
  masteryRows = [],
  onContinue,
  onFinish,
}: RoundSummaryProps) {
  const results = session.results ?? [];
  const correct = results.filter((result) => result.correct).length;
  const accuracy = results.length > 0 ? percent(correct, results.length) : 0;

  const bySkill = new Map<Skill, { total: number; correct: number }>();
  for (const result of results) {
    const bucket = bySkill.get(result.skill) ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (result.correct) bucket.correct += 1;
    bySkill.set(result.skill, bucket);
  }

  const wrongWords = results
    .filter((result) => !result.correct)
    .map((result) => ({
      result,
      word: words.find((word) => word.id === result.wordId),
    }))
    .filter((item): item is { result: (typeof results)[number]; word: Word } => Boolean(item.word));

  const masteredWord = masteredWordId
    ? words.find((word) => word.id === masteredWordId)
    : undefined;

  const skillRows = [...bySkill.entries()];

  return (
    <section className="study-report enter-up" aria-label="本轮小结">
      <span className="seal study-report__seal" aria-hidden="true">
        阅
      </span>

      <header className="study-report__head">
        <div>
          <h2 className="study-report__title">本轮小结</h2>
          <p className="study-report__sub">
            <span>第 {session.roundNo ?? 1} 轮</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>作答 {results.length} 题</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>用时 {formatDuration(elapsedMs)}</span>
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
            <dt>答对</dt>
            <dd>{correct}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>答错</dt>
            <dd>{results.length - correct}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>掌握</dt>
            <dd>{masteredWord ? 1 : 0}</dd>
          </div>
        </dl>
      </div>

      {skillRows.length > 0 ? (
        <ul className="study-report__skills" aria-label="技能分布">
          {skillRows.map(([skill, bucket]) => {
            const share = percent(bucket.correct, bucket.total);
            return (
              <li key={skill} className="study-report__skill">
                <span className="study-report__skill-label">{SKILL_META[skill].label}</span>
                <span className="study-report__skill-track" aria-hidden="true">
                  <span style={{ width: `${share}%` }} />
                </span>
                <span className="study-report__skill-count">
                  {bucket.correct}/{bucket.total}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {masteredWord ? (
        <p className="study-report__mastered">
          「{masteredWord.term}」已标为掌握，永久不再学习与复习。
        </p>
      ) : null}

      {wrongWords.length > 0 ? (
        <div className="study-report__review">
          <h3 className="study-report__review-title">需要再看一眼</h3>
          <ul className="study-report__review-list">
            {wrongWords.slice(0, 6).map(({ result, word }) => (
              <li key={`${result.wordId}-${result.questionId}`} className="study-report__review-row is-again">
                <span className="study-report__review-term">{word.term}</span>
                <span className="study-report__review-meaning">{truncate(word.meaning, 26)}</span>
                <span className="study-report__review-tag">
                  {SKILL_META[result.skill].short ?? SKILL_META[result.skill].label}
                </span>
                {result.aiFeedback ? (
                  <p className="study-report__review-note">{result.aiFeedback}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="study-report__more">
            这些词会优先排进下一轮复习；讲解已存入作答记录，随时可以回看。
          </p>
        </div>
      ) : (
        <p className="study-report__clear">这一轮没有需要重看的词，手感正好。</p>
      )}

      {masteryRows.length > 0 ? (
        <div className="study-report__mastery">
          <h3 className="study-report__mastery-title">掌握进度</h3>
          <ul className="study-report__mastery-list">
            {masteryRows.map(({ word, check }) => (
              <li key={word.id} className="study-report__mastery-row">
                <span className="study-report__mastery-term">{word.term}</span>
                <span className="study-report__mastery-detail">
                  连续答对 {check.streak}/3 · 覆盖 {check.skills.length}/2 技能 · 分布{' '}
                  {check.roundIds.length}/2 轮次 · {check.errorFreeDays}/14 天无错
                </span>
                {check.eligible ? (
                  <span className="badge badge--sage">已达成</span>
                ) : (
                  <span className="study-report__mastery-reason">
                    {check.reasons[0] ?? '继续练习即可达标'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {weakWords.length > 0 ? (
        <div className="study-report__weak">
          <h3 className="study-report__review-title">仍薄弱词</h3>
          <ul className="study-report__review-list">
            {weakWords.slice(0, 5).map((item) => (
              <li key={item.word.id} className="study-report__review-row is-again">
                <span className="study-report__review-term">{item.word.term}</span>
                <span className="study-report__review-meaning">
                  {truncate(item.word.meaning, 26)}
                </span>
                <span className="study-report__review-tag">错 {item.wrongCount} 次</span>
              </li>
            ))}
          </ul>
          <p className="study-report__more">这些词会被优先排进后面的复习。</p>
        </div>
      ) : null}

      <div className="study-report__actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={onContinue}>
          <IconRefresh size={17} />
          继续下一轮
        </button>
        <button type="button" className="btn btn--ghost btn--lg" onClick={onFinish}>
          结束本轮
        </button>
      </div>
    </section>
  );
}
