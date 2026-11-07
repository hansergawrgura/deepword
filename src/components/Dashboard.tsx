import { useApp } from '../state/AppState';
import type { ViewProps } from '../types';
import {
  DAILY_GOAL,
  getHeatmap,
  getMasteryBreakdown,
  getOverview,
  getRecentActivity,
  getWeakWords,
} from '../lib/stats';
import { SRS_STATUS_META } from '../lib/srs';
import { countAvailable } from '../lib/rounds';
import { hasResumableSession } from '../lib/practiceRound';
import { getWeaknessReport } from '../lib/weakness';
import { percent, relativeTime, truncate, weekdayName } from '../lib/utils';
import {
  IconArrowRight,
  IconCards,
  IconChevronRight,
  IconFlame,
  IconSparkle,
  IconTarget,
} from '../components/ui/icons';
import './Dashboard.css';

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '晨光正好';
  if (hour < 14) return '午后小憩';
  if (hour < 18) return '日影西斜';
  return '灯下夜读';
}

function compactDate(now: Date): string {
  return `${now.getFullYear()}.${`${now.getMonth() + 1}`.padStart(2, '0')}.${`${now.getDate()}`.padStart(2, '0')}`;
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
  // 上一轮没做完时，入口文案改为「继续上一轮」。
  const resumable = hasResumableSession(data);
  const roundActionLabel = resumable ? '继续上一轮' : '开始本轮学习';
  const pending = available.reviewWords + available.newWords;
  const monthLabel = `${now.getMonth() + 1} 月`;
  const hasLearned = overview.learnedWords > 0;

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <div className="dash-header__eyebrow">
            <span className="mono-label">DASHBOARD</span>
            <span className="dash-header__rule" aria-hidden="true" />
            <span className="dash-header__date">
              {compactDate(now)} · {weekdayName(nowTs)}
            </span>
          </div>
          <h1 className="dash-title">
            {greeting(now)}，<em>宜温故</em>
          </h1>
          <p className="dash-intro">
            错词不是负担，而是下一次记住的线索。今天有{' '}
            <strong className="u-vermilion">{pending}</strong> 个词等你过一遍。
          </p>
        </div>
        <div className="dash-stamp" aria-hidden="true">
          <span className="dash-stamp__word">今日</span>
          <span className="dash-stamp__date">
            {now.getMonth() + 1}/{now.getDate()}
          </span>
        </div>
      </header>

      <section className="dash-stats" aria-label="学习概览">
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">REVIEW</span>
            <IconCards size={16} />
          </div>
          <div className="dash-stat__value">
            {available.reviewWords}
            <span className="dash-stat__unit">个</span>
          </div>
          <p className="dash-stat__label">待复习 · 按薄弱度 · 新词 {available.newWords} 个</p>
        </article>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">TODAY</span>
            <IconTarget size={16} />
          </div>
          <div className="dash-stat__value">
            {overview.todayReviewed}
            <span className="dash-stat__unit">次</span>
          </div>
          <p className="dash-stat__label">
            今日已学 · 目标 {DAILY_GOAL} 次
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
            近七日正确率 · 今日{' '}
            {overview.todayAccuracy === null ? '尚无作答' : `${overview.todayAccuracy}%`}
          </p>
        </article>
        <article className="dash-stat">
          <div className="dash-stat__top">
            <span className="mono-label">STREAK</span>
            <IconFlame size={16} />
          </div>
          <div className="dash-stat__value">
            {overview.streak}
            <span className="dash-stat__unit">天</span>
          </div>
          <p className="dash-stat__label">
            连续学习 · {overview.todayReviewed > 0 ? '今日已打卡' : '今天还未开始'}
          </p>
        </article>
      </section>

      <div className="dash-grid">
        <div className="dash-grid__main">
          <section className="dash-hero">
            <span className="dash-hero__watermark" aria-hidden="true">
              温
            </span>
            <div className="dash-hero__content">
              <span className="mono-label">TODAY&apos;S RITUAL</span>
              <h2 className="dash-hero__title">翻一页，记一页</h2>
              <p className="dash-hero__desc">
                先温习到期的旧词，再认识几个新词。答错的词会按薄弱度排进下一轮，优先再练一遍。
              </p>

              <div className="dash-hero__progress">
                <div className="u-between">
                  <span>
                    今日进度 <strong>{overview.todayReviewed}</strong> / {DAILY_GOAL}
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

              {resumable && (
                <p className="dash-hero__resume">上一轮还没做完，接着往下走。</p>
              )}
            </div>

            <div className="dash-hero__tally" aria-label="待学与连击">
              <div className="dash-hero__tally-item">
                <strong>{pending}</strong>
                <span>个待学</span>
              </div>
              <div className="dash-hero__tally-rule" aria-hidden="true" />
              <div className="dash-hero__tally-item">
                <strong>{overview.streak}</strong>
                <span>天连续</span>
              </div>
            </div>
          </section>

          <section className="dash-panel dash-heat">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">温故有痕</h2>
                <p className="dash-panel__sub">近 28 天的学习记录，每一格都是一次相遇。</p>
              </div>
              <span className="badge badge--sage badge--dot">连续 {overview.streak} 天</span>
            </header>
            <div className="dash-heat__grid" role="img" aria-label="近 28 天学习热力图">
              {heatmap.map((cell) => (
                <span
                  key={cell.key}
                  className="dash-heat__cell"
                  data-level={cell.level}
                  title={`${cell.key} · ${cell.reviewed} 次学习`}
                />
              ))}
            </div>
            <div className="dash-heat__foot">
              <span>{monthLabel} · 共 28 天</span>
              <div className="dash-heat__legend" aria-hidden="true">
                <span>少</span>
                <span className="dash-heat__cell" data-level={1} />
                <span className="dash-heat__cell" data-level={2} />
                <span className="dash-heat__cell" data-level={3} />
                <span className="dash-heat__cell" data-level={4} />
                <span>多</span>
              </div>
            </div>
          </section>

          <section className="dash-panel">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">最近动静</h2>
                <p className="dash-panel__sub">每一次作答，都在改写记忆的曲线。</p>
              </div>
            </header>
            {activities.length === 0 ? (
              <div className="dash-inline-empty">
                <IconLeafMark />
                <div>
                  <p>还没有学习记录</p>
                  <span>从第一张闪卡开始，让今天留一点痕迹。</span>
                </div>
              </div>
            ) : (
              <ol className="dash-recent">
                {activities.map(({ attempt, word }) => (
                  <li key={attempt.id} className="dash-recent__row">
                    <span
                      className={`dash-recent__icon ${attempt.correct ? 'is-correct' : 'is-wrong'}`}
                    >
                      {attempt.kind === 'flashcard' ? <IconCards size={15} /> : <IconSparkle size={15} />}
                    </span>
                    <div className="dash-recent__body">
                      <strong>{word?.term ?? '已删除的词'}</strong>
                      <span>
                        {attempt.kind === 'flashcard' ? '闪卡自评' : 'AI 练习题'} ·{' '}
                        {relativeTime(attempt.createdAt, nowTs)}
                      </span>
                    </div>
                    <span className={`dash-recent__result ${attempt.correct ? 'is-correct' : 'is-wrong'}`}>
                      {attempt.correct ? '对' : '错'}
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
                <h2 className="dash-panel__title">错题待攻克</h2>
                <p className="dash-panel__sub">最该再练一遍的几个词。</p>
              </div>
            </header>

            {weakWords.length === 0 ? (
              <div className="dash-inline-empty">
                <IconLeafMark />
                <div>
                  <p>{hasLearned ? '错题本还是空的' : '还没有开始学习'}</p>
                  <span>{hasLearned ? '保持这样的手感。' : '答错的词会在这里排队，下一轮优先复习。'}</span>
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
                        title={`去复习「${word.term}」`}
                      >
                        <span className="dash-weak__term">{word.term}</span>
                        <span className="dash-weak__meaning">{truncate(word.meaning, 26)}</span>
                        <span className="dash-weak__meta">
                          <span className="badge badge--vermilion">错 {wrongCount}</span>
                          {accuracy !== null && (
                            <span className="dash-weak__accuracy">{accuracy}%</span>
                          )}
                        </span>
                        {mistake?.correctStreak ? (
                          <span className="dash-weak__streak">已连对 {mistake.correctStreak}</span>
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
                  去复习这些词
                </button>
              </>
            )}
          </section>

          <section className="dash-panel dash-weakness">
            <header className="dash-panel__head">
              <div>
                <h2 className="dash-panel__title">薄弱分析</h2>
                <p className="dash-panel__sub">六个技能各练了多少、错在哪里，一眼看清。</p>
              </div>
              {weakness.practiced && weakestStat ? (
                <span className="badge badge--vermilion">最弱 · {weakestStat.label}</span>
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
                      title={`${stat.label} · ${stat.attempts} 次作答`}
                    >
                      <span className="dash-weakness__skill-label">{stat.label}</span>
                      <span className="dash-weakness__skill-bar" aria-hidden="true">
                        <span style={{ width: `${stat.accuracy ?? 0}%` }} />
                      </span>
                      <span className="dash-weakness__skill-acc">
                        {stat.accuracy === null ? '—' : `${stat.accuracy}%`}
                      </span>
                      <span className="dash-weakness__skill-count">{stat.attempts} 次</span>
                    </li>
                  ))}
                </ul>

                <div className="dash-weakness__split">
                  <div className="dash-weakness__words">
                    <h3 className="dash-weakness__subtitle">最该重练的词</h3>
                    {weakness.weakestWords.length === 0 ? (
                      <p className="dash-weakness__note">暂时没有明显失手的词，保持这个手感。</p>
                    ) : (
                      <ul className="dash-weakness__word-list">
                        {weakness.weakestWords.slice(0, 5).map((item) => (
                          <li key={item.word.id}>
                            <button
                              type="button"
                              className="dash-weakness__word"
                              onClick={() => navigate('wordbook')}
                              title={`在词库里查看「${item.word.term}」`}
                            >
                              <span className="dash-weakness__word-term">{item.word.term}</span>
                              <span className="dash-weakness__word-meaning">
                                {truncate(item.word.meaning, 24)}
                              </span>
                              <span className="dash-weakness__word-meta">
                                <span className="badge badge--vermilion">错 {item.wrongCount}</span>
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
                    <span className="dash-weakness__focus-label">建议重点</span>
                    <span className="dash-weakness__focus-text">{weakness.focus}</span>
                  </p>
                </div>
              </>
            ) : (
              <div className="dash-inline-empty dash-weakness__empty">
                <IconLeafMark />
                <div>
                  <p>还没有练习记录</p>
                  <span>完成一轮练习后，这里会告诉你 6 个技能各弱在哪。</span>
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
                <h2 className="dash-panel__title">词库掌握</h2>
                <p className="dash-panel__sub">从遗遇到熟识，各自有它的节奏。</p>
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
                    {SRS_STATUS_META[status].label}
                  </dt>
                  <dd>{mastery[status]}</dd>
                </div>
              ))}
            </dl>

            <div className="dash-mastery__total">
              <span>词库共 {overview.totalWords} 个词条</span>
              <button type="button" className="dash-link" onClick={() => navigate('wordbook')}>
                去词库
                <IconChevronRight size={14} />
              </button>
            </div>
          </section>

          <section className="dash-note">
            <span className="dash-note__mark" aria-hidden="true">
              ”
            </span>
            <p>记忆不是一次完成的事，是一次次被重新想起。</p>
            <span className="dash-note__by mono-label">DEEPWORD · 词渊</span>
          </section>
        </aside>
      </div>
    </div>
  );
}

/** 错题本为空时的留白小印。 */
function IconLeafMark() {
  return (
    <span className="dash-inline-empty__mark" aria-hidden="true">
      空
    </span>
  );
}
