import type { PracticeSessionState, Skill, Word } from '@/domain/types';
import type { MasteryCheck } from '@/domain/mastery';
import type { WeakWordStat } from '@/domain/weakness';
import { percent, truncate } from '@/domain/utils';
import { useT } from '@/i18n';
import type { TranslateFn } from '@/i18n';
import { IconRefresh } from '@/ui/icons';

export interface MasteryProgressRow {
  word: Word;
  check: MasteryCheck;
}

export interface RoundSummaryProps {
  session: PracticeSessionState;
  words: Word[];
  elapsedMs: number;
  masteredWordId?: string | null;
  weakWords?: WeakWordStat[];
  masteryRows?: MasteryProgressRow[];
  onContinue: () => void;
  onFinish: () => void;
}

function formatDuration(t: TranslateFn, ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t('study.durationSeconds', { seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return t('study.durationMinutes', { minutes, seconds: rest });
}

function skillLabel(t: TranslateFn, skill: Skill): string {
  return t(`domain.skill.${skill}.label`);
}

function skillShort(t: TranslateFn, skill: Skill): string {
  const short = t(`domain.skill.${skill}.short`);
  return short || skillLabel(t, skill);
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
  const t = useT();
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
    <section className="study-report enter-up" aria-label={t('study.summaryTitle')}>
      <span className="seal study-report__seal" aria-hidden="true">
        {t('study.summarySeal')}
      </span>

      <header className="study-report__head">
        <div>
          <h2 className="study-report__title">{t('study.summaryTitle')}</h2>
          <p className="study-report__sub">
            <span>{t('study.summaryMetaRound', { roundNo: session.roundNo ?? 1 })}</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>{t('study.summaryAnswered', { count: results.length })}</span>
            <span className="study-report__sep" aria-hidden="true" />
            <span>{t('study.summaryDuration', { duration: formatDuration(t, elapsedMs) })}</span>
          </p>
        </div>
      </header>

      <div className="study-report__score">
        <div className="study-report__accuracy">
          <strong>
            {accuracy}
            <em>%</em>
          </strong>
          <span>{t('study.accuracyLabel')}</span>
        </div>

        <dl className="study-report__brief">
          <div className="study-report__brief-item">
            <dt>{t('study.statCorrect')}</dt>
            <dd>{correct}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>{t('study.statWrong')}</dt>
            <dd>{results.length - correct}</dd>
          </div>
          <div className="study-report__brief-item">
            <dt>{t('study.statMastered')}</dt>
            <dd>{masteredWord ? 1 : 0}</dd>
          </div>
        </dl>
      </div>

      {skillRows.length > 0 ? (
        <ul className="study-report__skills" aria-label={t('study.summaryTitle')}>
          {skillRows.map(([skill, bucket]) => {
            const share = percent(bucket.correct, bucket.total);
            return (
              <li key={skill} className="study-report__skill">
                <span className="study-report__skill-label">{skillLabel(t, skill)}</span>
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
          {t('study.masteredWord', { term: masteredWord.term })}
        </p>
      ) : null}

      {wrongWords.length > 0 ? (
        <div className="study-report__review">
          <h3 className="study-report__review-title">{t('study.reviewTitle')}</h3>
          <ul className="study-report__review-list">
            {wrongWords.slice(0, 6).map(({ result, word }) => (
              <li key={`${result.wordId}-${result.questionId}`} className="study-report__review-row is-again">
                <span className="study-report__review-term">{word.term}</span>
                <span className="study-report__review-meaning">{truncate(word.meaning, 26)}</span>
                <span className="study-report__review-tag">{skillShort(t, result.skill)}</span>
                {result.aiFeedback ? (
                  <p className="study-report__review-note">{result.aiFeedback}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="study-report__more">{t('study.reportReviewMore')}</p>
        </div>
      ) : (
        <p className="study-report__clear">{t('study.reviewClear')}</p>
      )}

      {masteryRows.length > 0 ? (
        <div className="study-report__mastery">
          <h3 className="study-report__mastery-title">{t('study.masteryProgress')}</h3>
          <ul className="study-report__mastery-list">
            {masteryRows.map(({ word, check }) => (
              <li key={word.id} className="study-report__mastery-row">
                <span className="study-report__mastery-term">{word.term}</span>
                <span className="study-report__mastery-detail">
                  {t('study.masteryDetail', {
                    streak: check.streak,
                    skills: check.skills.length,
                    rounds: check.roundIds.length,
                    errorFreeDays: check.errorFreeDays,
                  })}
                </span>
                {check.eligible ? (
                  <span className="badge badge--sage">{t('study.masteryAchieved')}</span>
                ) : (
                  <span className="study-report__mastery-reason">
                    {check.reasons[0] ?? t('study.masteryDefaultReason')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {weakWords.length > 0 ? (
        <div className="study-report__weak">
          <h3 className="study-report__review-title">{t('study.weakWords')}</h3>
          <ul className="study-report__review-list">
            {weakWords.slice(0, 5).map((item) => (
              <li key={item.word.id} className="study-report__review-row is-again">
                <span className="study-report__review-term">{item.word.term}</span>
                <span className="study-report__review-meaning">
                  {truncate(item.word.meaning, 26)}
                </span>
                <span className="study-report__review-tag">
                  {t('study.wrongTimes', { count: item.wrongCount })}
                </span>
              </li>
            ))}
          </ul>
          <p className="study-report__more">{t('study.reportWeakMore')}</p>
        </div>
      ) : null}

      <div className="study-report__actions">
        <button type="button" className="btn btn--primary btn--lg" onClick={onContinue}>
          <IconRefresh size={17} />
          {t('study.continueNext')}
        </button>
        <button type="button" className="btn btn--ghost btn--lg" onClick={onFinish}>
          {t('study.endRound')}
        </button>
      </div>
    </section>
  );
}
