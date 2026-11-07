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

export default function Dashboard({ navigate }: ViewProps) {
  const { data } = useApp();
  const now = new Date();
  const nowTs = now.getTime();
  const overview = getOverview(data, nowTs);
  const weakWords = getWeakWords(data, 5, { now: nowTs });
  const heatmap = getHeatmap(data.stats.daily, 28, nowTs);
  const activities = getRecentActivity(data, 5);
  const mastery = getMasteryBreakdown(data);
  const pending = overview.dueCount + overview.newCount;
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
            <strong className="u-vermilion">{pending}</strong> 张卡片等你翻过。
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
            <span className="mono-label">DUE</span>
            <IconCards size={16} />
          </div>
          <div className="dash-stat__value">
            {overview.dueCount}
            <span className="dash-stat__unit">张</span>
          </div>
          <p className="dash-stat__label">到期复习 · 新词 {overview.newCount} 个</p>
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
                先温习到期的旧词，再认识几个新词。答错的词会进入 AI 特训，由大模型读你的错误，为你重新命题。
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
                  开始今日学习
                  <IconArrowRight size={17} />
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => navigate('drill')}>
                  <IconSparkle size={16} />
                  错题 AI 特训
                </button>
              </div>
            </div>

            <div className="dash-hero__tally" aria-label="待学与连击">
              <div className="dash-hero__tally-item">
                <strong>{pending}</strong>
                <span>张待学</span>
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
                <p className="dash-panel__sub">最该被重新命题的几个词。</p>
              </div>
              <button
                type="button"
                className="dash-link"
                onClick={() => navigate('drill')}
                aria-label="前往错题特训"
              >
                特训
                <IconChevronRight size={14} />
              </button>
            </header>

            {weakWords.length === 0 ? (
              <div className="dash-inline-empty">
                <IconLeafMark />
                <div>
                  <p>{hasLearned ? '错题本还是空的' : '还没有开始学习'}</p>
                  <span>{hasLearned ? '保持这样的手感。' : '答错的词会在这里排队，等待 AI 针对性出题。'}</span>
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
                        onClick={() => navigate('drill')}
                        title={`去特训「${word.term}」`}
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
                  onClick={() => navigate('drill')}
                >
                  <IconSparkle size={15} />
                  让 AI 为这些错词出题
                </button>
              </>
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
