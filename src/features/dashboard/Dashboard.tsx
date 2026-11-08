import { useApp } from '@/app/store';
import type { ViewProps } from '@/domain/types';
import type { Skill } from '@/domain/types';
import {
  DAILY_GOAL,
  getHeatmap,
  getMasteryBreakdown,
  getOverview,
  getRecentActivity,
  getWeakWords,
} from '@/domain/stats';
import { countAvailable } from '@/domain/rounds';
import { hasResumableSession } from '@/domain/practiceRound';
import { getWeaknessReport } from '@/domain/weakness';
import type { WeaknessReport } from '@/domain/weakness';
import { SKILLS } from '@/domain/practice';
import { percent, relativeTime, truncate, weekdayName } from '@/domain/utils';
import { useLocale, useT } from '@/i18n';
import type { TranslateFn } from '@/i18n';
import {
  IconArrowRight,
  IconCards,
  IconChevronRight,
  IconFlame,
  IconSparkle,
  IconTarget,
} from '@/ui/icons';
import './Dashboard.css';

function greeting(t: TranslateFn, now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return t('dashboard.greetingLateNight');
  if (hour < 11) return t('dashboard.greetingMorning');
  if (hour < 14) return t('dashboard.greetingNoon');
  if (hour < 18) return t('dashboard.greetingAfternoon');
  return t('dashboard.greetingEvening');
}

function compactDate(now: Date): string {
  return `${now.getFullYear()}.${`${now.getMonth() + 1}`.padStart(2, '0')}.${`${now.getDate()}`.padStart(2, '0')}`;
}

function skillLabel(t: TranslateFn, skill: Skill): string {
  return t(`domain.skill.${skill}.label`);
}

function weaknessFocusText(t: TranslateFn, report: WeaknessReport): string {
  if (!report.practiced || !report.weakestSkill) {
    return t('domain.weakness.noSkillAttempts');
  }

  const practicedStats = report.skills
    .filter((stat) => stat.attempts > 0 && stat.accuracy !== null)
    .sort((a, b) => {
      const accA = a.accuracy ?? 0;
      const accB = b.accuracy ?? 0;
      if (accA !== accB) return accA - accB;
      if (a.attempts !== b.attempts) return a.attempts - b.attempts;
      return SKILLS.indexOf(a.skill) - SKILLS.indexOf(b.skill);
    });

  const weakest = practicedStats[0];
  if (!weakest) return t('domain.weakness.needOneRound');
  if ((weakest.accuracy ?? 0) >= 100) return t('domain.weakness.allGood');

  const second = practicedStats[1];
  const weakestAcc = weakest.accuracy ?? 0;
  const withSecond =
    Boolean(second) &&
    (second?.accuracy ?? 0) < 100 &&
    weakestAcc - (second?.accuracy ?? 0) <= 20;

  const pairJoin = t('dashboard.focusPairJoin');
  const names = withSecond
    ? `${skillLabel(t, weakest.skill)}${pairJoin}${skillLabel(t, second!.skill)}`
    : skillLabel(t, weakest.skill);

  let text = t('dashboard.focusWeakest', {
    skills: names,
    primary: skillLabel(t, weakest.skill),
  });
  if (withSecond && second) {
    text +=
      t('dashboard.focusJoiner') +
      t('dashboard.focusWeakestDual', { secondary: skillLabel(t, second.skill) });
  }
  const worstWord = report.weakestWords[0];
  if (worstWord) {
    const term = worstWord.word.term?.trim() || t('domain.practice.thisWord');
    text +=
      t('dashboard.focusJoiner') +
      t('dashboard.focusWeakestWord', { term, count: worstWord.wrongCount });
  }
  return `${text}${t('dashboard.focusEndPunct')}`;
}

/** 正确率分档：用于细横条配色（弱 → 中 → 强）。 */
function accuracyTone(accuracy: number | null): 'none' | 'weak' | 'mid' | 'strong' {
  if (accuracy === null) return 'none';
  if (accuracy < 60) return 'weak';
  if (accuracy < 85) return 'mid';
  return 'strong';
}

export default function Dashboard({ navigate }: ViewProps) {
  const { data } = useApp();
  const t = useT();
  const locale = useLocale();
  const now = new Date();
  const nowTs = now.getTime();
  const overview = getOverview(data, nowTs);
  const weakWords = getWeakWords(data, 5, { now: nowTs });
  const heatmap = getHeatmap(data.stats.daily, 28, nowTs);
  const activities = getRecentActivity(data, 5);
  const mastery = getMasteryBreakdown(data);
  const weakness = getWeaknessReport(data, { limit: 5, now: nowTs });
  const available = countAvailable(data, nowTs);
  const weakestStat = weakness.weakestSkill
    ? weakness.skills.find((item) => item.skill === weakness.weakestSkill)
    : undefined;
  const resumable = hasResumableSession(data);
  const roundActionLabel = resumable ? t('dashboard.resumeRound') : t('dashboard.startRound');
  const pending = available.reviewWords + available.newWords;
  const monthLabel =
    locale === 'zh-CN'
      ? `${now.getMonth() + 1}${t('dashboard.monthSuffix')}`
      : now.toLocaleDateString(locale, { month: 'long' });
  const hasLearned = overview.learnedWords > 0;
  const focusText = weaknessFocusText(t, weakness);

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <div className="dash-header__eyebrow">
            <span className="mono-label">DASHBOARD</span>
            <span className="dash-header__rule" aria-hidden="true" />
            <span className="dash-header__date">
              {compactDate(now)} · {weekdayName(nowTs, locale)}
            </span>
          </div>
          <h1 className="dash-title">
            {greeting(t, now)}，<em>{t('dashboard.greetingEm')}</em>
          </h1>
          <p className="dash-intro">{t('dashboard.intro', { pending })}</p>
        </div>
        <div className="dash-stamp" aria-hidden="true">
          <span className="dash-stamp__word">{t('dashboard.stampToday')}</span>
          <span className="dash-stamp__date">
            {now.getMonth() + 1}/{now.getDate()}
          </span>
        </div>
      </header>

      <section className="dash-stats" aria-label={t('dashboard.overview')}>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">REVIEW</span>
            <IconCards size={16} />
          </div>
          <div className="dash-stat__value">
            {available.reviewWords}
            {t('dashboard.statUnitWords') ? (
              <span className="dash-stat__unit">{t('dashboard.statUnitWords')}</span>
            ) : null}
          </div>
          <p className="dash-stat__label">
            {t('dashboard.dueReview', { newWords: available.newWords })}
          </p>
        </article>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">TODAY</span>
            <IconTarget size={16} />
          </div>
          <div className="dash-stat__value">
            {overview.todayReviewed}
            {t('dashboard.statUnitTimes') ? (
              <span className="dash-stat__unit">{t('dashboard.statUnitTimes')}</span>
            ) : null}
          </div>
          <p className="dash-stat__label">
            {t('dashboard.todayStudied', { goal: DAILY_GOAL })}
            <span className="dash-stat__mini">
              <span style={{ width: `${overview.todayProgress}%` }} />
            </span>
          </p>
        </article>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">ACCURACY</span>
            <span className="dash-stat__glyph" aria-hidden="true">
              %
            </span>
          </div>
          <div className="dash-stat__value">
            {overview.accuracy7 === null ? '—' : overview.accuracy7}
            {overview.accuracy7 !== null && <span className="dash-stat__unit">%</span>}
          </div>
          <p className="dash-stat__label">
            {t('dashboard.accuracy7', {
              todayAccuracy:
                overview.todayAccuracy === null
                  ? t('dashboard.noAttempts')
                  : `${overview.todayAccuracy}%`,
            })}
          </p>
        </article>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">STREAK</span>
            <IconFlame size={16} />
          </div>
          <div className="dash-stat__value">
            {overview.streak}
            {locale === 'zh-CN' ? <span className="dash-stat__unit">{t('dashboard.streakUnit')}</span> : null}
          </div>
          <p className="dash-stat__label">
            {t('dashboard.streakLabel', {
              checkedIn:
                overview.todayReviewed > 0 ? t('dashboard.checkedIn') : t('dashboard.notStarted'),
            })}
          </p>
        </article>
      </section>

      <div className="dash-grid">
        <div className="dash-grid__main">
          <section className="dash-hero">
            <span className="dash-hero__watermark" aria-hidden="true">
              {t('dashboard.watermarkWarm')}
            </span>
            <div className="dash-hero__content">
              <span className="mono-label">TODAY&apos;S RITUAL</span>
              <h2 className="dash-hero__title">{t('dashboard.heroTitle')}</h2>
              <p className="dash-hero__desc">{t('dashboard.heroDesc')}</p>

              <div className="dash-hero__progress">
                <div className="u-between">
                  <span>
                    {t('dashboard.todayProgress')}{' '}
                    <strong>{overview.todayReviewed}</strong> / {DAILY_GOAL}
                  </span>
                  <span>{overview.todayProgress}%</span>
                </div>
                <div className="progress">
                  <div className="progress__bar" style={{ width: `${overview.todayProgress}%` }} />
                </div>
              </div>

              <div className="dash-hero__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--lg"
                  onClick={() => navigate('study')}
                >
                  {roundActionLabel}
                  <IconArrowRight size={17} />
                </button>
              </div>

              {resumable && <p className="dash-hero__resume">{t('dashboard.resumeHint')}</p>}
            </div>

            <div className="dash-hero__tally" aria-label={t('dashboard.tallyAria')}>
              <div className="dash-hero__tally-item">
                <strong>{pending}</strong>
                <span>{t('dashboard.pendingUnit')}</span>
              </div>
              <div className="dash-hero__tally-rule" aria-hidden="true" />
              <div className="dash-hero__tally-item">
                <strong>{overview.streak}</strong>
                <span>{t('dashboard.streakUnit')}</span>
              </div>
            </div>
          </section>

          <section className="dash-panel dash-heat">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">{t('dashboard.heatTitle')}</h2>
                <p className="dash-panel__sub">{t('dashboard.heatSub')}</p>
              </div>
              <span className="badge badge--sage badge--dot">
                {t('dashboard.streakBadge', { count: overview.streak })}
              </span>
            </header>
            <div className="dash-heat__grid" role="img" aria-label={t('dashboard.heatAria')}>
              {heatmap.map((cell) => (
                <span
                  key={cell.key}
                  className="dash-heat__cell"
                  data-level={cell.level}
                  title={t('dashboard.heatCell', { date: cell.key, count: cell.reviewed })}
                />
              ))}
            </div>
            <div className="dash-heat__foot">
              <span>{t('dashboard.heatFoot', { month: monthLabel })}</span>
              <div className="dash-heat__legend" aria-hidden="true">
                <span>{t('dashboard.less')}</span>
                <span className="dash-heat__cell" data-level={1} />
                <span className="dash-heat__cell" data-level={2} />
                <span className="dash-heat__cell" data-level={3} />
                <span className="dash-heat__cell" data-level={4} />
                <span>{t('dashboard.more')}</span>
              </div>
            </div>
          </section>

          <section className="dash-panel">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">{t('dashboard.recentTitle')}</h2>
                <p className="dash-panel__sub">{t('dashboard.recentSub')}</p>
              </div>
            </header>
            {activities.length === 0 ? (
              <div className="dash-inline-empty">
                <IconLeafMark label={t('common.emptyMark')} />
                <div>
                  <p>{t('dashboard.recentEmpty')}</p>
                  <span>{t('dashboard.recentEmptyHint')}</span>
                </div>
              </div>
            ) : (
              <ol className="dash-recent">
                {activities.map(({ attempt, word }) => (
                  <li key={attempt.id} className="dash-recent__row">
                    <span
                      className={`dash-recent__icon ${attempt.correct ? 'is-correct' : 'is-wrong'}`}
                    >
                      <IconSparkle size={15} />
                    </span>
                    <div className="dash-recent__body">
                      <strong>{word?.term ?? t('dashboard.deletedWord')}</strong>
                      <span>
                        {t('dashboard.practiceLine')}{' '}
                        {relativeTime(attempt.createdAt, nowTs, locale)}
                      </span>
                    </div>
                    <span
                      className={`dash-recent__result ${attempt.correct ? 'is-correct' : 'is-wrong'}`}
                    >
                      {attempt.correct ? t('common.correct') : t('common.wrong')}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="dash-grid__side">
          <section className="dash-panel dash-weak">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">{t('dashboard.mistakesTitle')}</h2>
                <p className="dash-panel__sub">{t('dashboard.mistakesSub')}</p>
              </div>
            </header>

            {weakWords.length === 0 ? (
              <div className="dash-inline-empty">
                <IconLeafMark label={t('common.emptyMark')} />
                <div>
                  <p>{hasLearned ? t('dashboard.mistakesEmptyClear') : t('dashboard.mistakesEmptyNew')}</p>
                  <span>
                    {hasLearned ? t('dashboard.weakestClear') : t('dashboard.mistakesQueueHint')}
                  </span>
                </div>
              </div>
            ) : (
              <>
                <ul className="dash-weak__list">
                  {weakWords.map(({ word, wrongCount, accuracy, mistake }) => (
                    <li key={word.id}>
                      <button
                        type="button"
                        className="dash-weak__row"
                        onClick={() => navigate('study')}
                        title={t('dashboard.reviewWord', { term: word.term })}
                      >
                        <span className="dash-weak__term">{word.term}</span>
                        <span className="dash-weak__meaning">{truncate(word.meaning, 26)}</span>
                        <span className="dash-weak__meta">
                          <span className="badge badge--vermilion">
                            {t('dashboard.wrongCount', { count: wrongCount })}
                          </span>
                          {accuracy !== null && (
                            <span className="dash-weak__accuracy">{accuracy}%</span>
                          )}
                        </span>
                        {mistake?.correctStreak ? (
                          <span className="dash-weak__streak">
                            {t('dashboard.correctStreak', { count: mistake.correctStreak })}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn btn--ghost btn--block dash-weak__cta"
                  onClick={() => navigate('study')}
                >
                  <IconArrowRight size={15} />
                  {t('dashboard.reviewThese')}
                </button>
              </>
            )}
          </section>

          <section className="dash-panel dash-weakness">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">{t('dashboard.weaknessTitle')}</h2>
                <p className="dash-panel__sub">{t('dashboard.weaknessSub')}</p>
              </div>
              {weakness.practiced && weakestStat ? (
                <span className="badge badge--vermilion">
                  {t('dashboard.weakest', { skill: skillLabel(t, weakestStat.skill) })}
                </span>
              ) : null}
            </header>

            {weakness.practiced ? (
              <>
                <ul className="dash-weakness__skills">
                  {weakness.skills.map((stat) => (
                    <li
                      key={stat.skill}
                      className="dash-weakness__skill"
                      data-tone={accuracyTone(stat.accuracy)}
                      data-weakest={stat.skill === weakness.weakestSkill ? 'true' : 'false'}
                      title={t('dashboard.skillTitle', {
                        skill: skillLabel(t, stat.skill),
                        attempts: stat.attempts,
                      })}
                    >
                      <span className="dash-weakness__skill-label">{skillLabel(t, stat.skill)}</span>
                      <span className="dash-weakness__skill-bar" aria-hidden="true">
                        <span style={{ width: `${stat.accuracy ?? 0}%` }} />
                      </span>
                      <span className="dash-weakness__skill-acc">
                        {stat.accuracy === null ? '—' : `${stat.accuracy}%`}
                      </span>
                      <span className="dash-weakness__skill-count">
                        {t('dashboard.attemptsCount', { count: stat.attempts })}
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="dash-weakness__split">
                  <div className="dash-weakness__words">
                    <h3 className="dash-weakness__subtitle">{t('dashboard.weakestWords')}</h3>
                    {weakness.weakestWords.length === 0 ? (
                      <p className="dash-weakness__note">{t('dashboard.weakestClear')}</p>
                    ) : (
                      <ul className="dash-weakness__word-list">
                        {weakness.weakestWords.slice(0, 5).map((item) => (
                          <li key={item.word.id}>
                            <button
                              type="button"
                              className="dash-weakness__word"
                              onClick={() => navigate('wordbook')}
                              title={t('dashboard.viewInWordbook', { term: item.word.term })}
                            >
                              <span className="dash-weakness__word-term">{item.word.term}</span>
                              <span className="dash-weakness__word-meaning">
                                {truncate(item.word.meaning, 24)}
                              </span>
                              <span className="dash-weakness__word-meta">
                                <span className="badge badge--vermilion">
                                  {t('dashboard.wrongCount', { count: item.wrongCount })}
                                </span>
                                <span className="dash-weakness__word-acc">
                                  {item.accuracy === null ? '—' : `${item.accuracy}%`}
                                </span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <p className="dash-weakness__focus">
                    <span className="dash-weakness__focus-label">{t('dashboard.focusLabel')}</span>
                    <span className="dash-weakness__focus-text">{focusText}</span>
                  </p>
                </div>
              </>
            ) : (
              <div className="dash-inline-empty dash-weakness__empty">
                <IconLeafMark label={t('common.emptyMark')} />
                <div>
                  <p>{t('dashboard.weaknessEmpty')}</p>
                  <span>{t('dashboard.weaknessEmptyDesc')}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm dash-weakness__empty-cta"
                  onClick={() => navigate('study')}
                >
                  {roundActionLabel}
                  <IconArrowRight size={14} />
                </button>
              </div>
            )}
          </section>

          <section className="dash-panel">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">{t('dashboard.masteryTitle')}</h2>
                <p className="dash-panel__sub">{t('dashboard.masterySub')}</p>
              </div>
            </header>

            <div className="dash-mastery__bar" aria-hidden="true">
              {(['new', 'learning', 'review', 'mastered'] as const).map((status) =>
                mastery[status] > 0 ? (
                  <span
                    key={status}
                    className={`dash-mastery__seg is-${status}`}
                    style={{ width: `${percent(mastery[status], overview.totalWords)}%` }}
                  />
                ) : null,
              )}
            </div>

            <dl className="dash-mastery__legend">
              {(['new', 'learning', 'review', 'mastered'] as const).map((status) => (
                <div key={status} className="dash-mastery__legend-item">
                  <dt>
                    <span className={`dash-mastery__dot is-${status}`} aria-hidden="true" />
                    {t(`domain.status.${status}`)}
                  </dt>
                  <dd>{mastery[status]}</dd>
                </div>
              ))}
            </dl>

            <div className="dash-mastery__total">
              <span>{t('dashboard.masteryTotal', { count: overview.totalWords })}</span>
              <button type="button" className="dash-link" onClick={() => navigate('wordbook')}>
                {t('dashboard.goWordbook')}
                <IconChevronRight size={14} />
              </button>
            </div>
          </section>

          <section className="dash-note">
            <span className="dash-note__mark" aria-hidden="true">
              ”
            </span>
            <p>{t('brand.quoteMemory')}</p>
            <span className="dash-note__by mono-label">{t('brand.footer')}</span>
          </section>
        </aside>
      </div>
    </div>
  );
}

function IconLeafMark({ label }: { label: string }) {
  return (
    <span className="dash-inline-empty__mark" aria-hidden="true">
      {label}
    </span>
  );
}
