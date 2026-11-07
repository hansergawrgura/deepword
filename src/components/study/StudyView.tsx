/**
 * 学习页 —— 闪卡 SRS。
 *
 * 三个阶段：
 * 1. 概览（扉页）：待复习 / 新词 / 总进度、模式选择、开始本轮；
 * 2. 学习：一张「词笺」闪卡 + 四档自评，支持空格翻面、1–4 自评、Esc 结束；
 * 3. 小结：本轮成绩单，可再来一轮 / 去错题特训 / 回首页。
 *
 * 队列只在「开始本轮 / 再来一轮」时构建一次，学习中只按 index 前进；
 * 所有读写都走 useApp()，不直接触碰 localStorage。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Grade, StudyItem, StudyMode, StudyQueue, ViewProps } from '@/types';
import { useApp } from '@/state/AppState';
import { buildStudyQueue } from '@/lib/session';
import { GRADE_META, masteryScore, previewInterval } from '@/lib/srs';
import { cx, dayKey, percent, speak, weekdayName } from '@/lib/utils';
import { IconBook, IconHome, IconSparkle } from '../ui/icons';
import Flashcard from './Flashcard';
import StudySummary, { type RoundResult } from './StudySummary';
import './StudyView.css';

/* ------------------------------------------------------------------ */
/* 常量与纯函数                                                        */
/* ------------------------------------------------------------------ */

const GRADE_ORDER: Grade[] = ['again', 'hard', 'good', 'easy'];

const MODE_META: Record<StudyMode, { label: string; full: string; hint: string }> = {
  mixed: { label: '混合', full: '混合模式', hint: '先清到期旧词，再引入新词。' },
  review: { label: '只复习', full: '只复习', hint: '只翻到期的旧词，不引入新词。' },
  new: { label: '只学新词', full: '只学新词', hint: '只学没见过的词，每轮最多十张。' },
};

const EMPTY_COUNTS: Record<Grade, number> = { again: 0, hard: 0, good: 0, easy: 0 };

type Phase = 'overview' | 'studying' | 'summary';

interface SessionState {
  phase: Phase;
  mode: StudyMode;
  /** 本轮队列只在开始时构建一次。 */
  queue: StudyItem[];
  index: number;
  flipped: boolean;
  counts: Record<Grade, number>;
  results: RoundResult[];
  startedAt: number;
  endedAt: number;
}

type SessionAction =
  | { type: 'START'; mode: StudyMode; queue: StudyItem[]; now: number }
  | { type: 'FLIP' }
  | { type: 'GRADE'; grade: Grade; now: number }
  | { type: 'END'; now: number }
  | { type: 'SKIP'; now: number }
  | { type: 'SET_MODE'; mode: StudyMode }
  | { type: 'RESET_OVERVIEW'; mode: StudyMode };

const INITIAL_SESSION: SessionState = {
  phase: 'overview',
  mode: 'mixed',
  queue: [],
  index: 0,
  flipped: false,
  counts: EMPTY_COUNTS,
  results: [],
  startedAt: 0,
  endedAt: 0,
};

function finishRound(state: SessionState, now: number): SessionState {
  // 一张都没自评就结束，回到扉页而不是成绩单。
  if (state.results.length === 0) return { ...INITIAL_SESSION, mode: state.mode };
  return { ...state, phase: 'summary', flipped: false, endedAt: now };
}

function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case 'START':
      return {
        phase: 'studying',
        mode: action.mode,
        queue: action.queue,
        index: 0,
        flipped: false,
        counts: { ...EMPTY_COUNTS },
        results: [],
        startedAt: action.now,
        endedAt: 0,
      };

    case 'FLIP':
      return state.phase === 'studying' ? { ...state, flipped: !state.flipped } : state;

    case 'GRADE': {
      if (state.phase !== 'studying') return state;
      const item = state.queue[state.index];
      if (!item) return finishRound(state, action.now);
      const counts: Record<Grade, number> = { ...state.counts };
      counts[action.grade] += 1;
      const nextIndex = state.index + 1;
      const next: SessionState = {
        ...state,
        flipped: false,
        counts,
        results: [...state.results, { wordId: item.word.id, grade: action.grade }],
        index: nextIndex,
      };
      if (nextIndex >= state.queue.length) return finishRound(next, action.now);
      return next;
    }

    case 'END':
      return state.phase === 'studying' ? finishRound(state, action.now) : state;

    case 'SKIP': {
      if (state.phase !== 'studying') return state;
      const nextIndex = state.index + 1;
      if (nextIndex >= state.queue.length) return finishRound(state, action.now);
      return { ...state, index: nextIndex, flipped: false };
    }

    case 'SET_MODE':
      return state.phase === 'overview' ? { ...state, mode: action.mode } : state;

    case 'RESET_OVERVIEW':
      return { ...INITIAL_SESSION, mode: action.mode };

    default:
      return state;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

const CN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function cnNumber(value: number): string {
  if (value <= 0) return '零';
  if (value < 10) return CN_DIGITS[value] ?? String(value);
  if (value === 10) return '十';
  if (value < 20) return `十${CN_DIGITS[value - 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${CN_DIGITS[tens]}十${ones > 0 ? CN_DIGITS[ones] : ''}`;
}

function chineseDate(date: Date): string {
  return `${cnNumber(date.getMonth() + 1)}月${cnNumber(date.getDate())}日`;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"]',
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

export default function StudyView({ navigate }: ViewProps) {
  const { data, actions } = useApp();
  const [session, dispatch] = useReducer(sessionReducer, INITIAL_SESSION);
  const [nudge, setNudge] = useState(0);
  const gradesRef = useRef<HTMLDivElement | null>(null);

  const dataRef = useRef(data);
  const actionsRef = useRef(actions);
  const sessionRef = useRef(session);
  const skippedWordRef = useRef<string | null>(null);
  const startRoundRef = useRef<(mode: StudyMode) => void>(() => undefined);
  const endRoundRef = useRef<() => void>(() => undefined);
  const gradeRef = useRef<(grade: Grade) => void>(() => undefined);
  const canStartRef = useRef(false);

  dataRef.current = data;
  actionsRef.current = actions;
  sessionRef.current = session;

  const now = new Date();
  const todayStat = data.stats.daily[dayKey(now.getTime())];
  const todayReviewed = todayStat?.reviewed ?? 0;

  // 只在扉页计算一次「本轮牌面」，学习过程中不再重建队列。
  const preview = useMemo<StudyQueue | null>(
    () => (session.phase === 'overview' ? buildStudyQueue(data, { mode: session.mode }) : null),
    [data, session.phase, session.mode],
  );

  // 全库进度：已学词数 + 平均掌握度。
  const library = useMemo(() => {
    let learned = 0;
    let masterySum = 0;
    for (const word of data.words) {
      const card = data.srs[word.id];
      if (!card) continue;
      masterySum += masteryScore(card);
      if (card.reps > 0) learned += 1;
    }
    const total = data.words.length;
    return {
      total,
      learned,
      mastery: total > 0 ? Math.round(masterySum / total) : 0,
    };
  }, [data.words, data.srs]);

  const currentItem = session.phase === 'studying' ? session.queue[session.index] : undefined;
  const currentWord = currentItem
    ? data.words.find((word) => word.id === currentItem.word.id)
    : undefined;
  const currentCard = currentItem
    ? (data.srs[currentItem.word.id] ?? currentItem.card)
    : undefined;

  const canStart = Boolean(preview && preview.items.length > 0);
  canStartRef.current = canStart;

  /* ------------------------------ 操作 ------------------------------ */

  const startRound = useCallback((nextMode: StudyMode) => {
    const queue = buildStudyQueue(dataRef.current, { mode: nextMode });
    if (queue.items.length === 0) {
      actionsRef.current.toast(
        nextMode === 'review' ? '没有到期的卡，换个模式试试。' : '今天的牌面已经清空了。',
        'info',
      );
      dispatch({ type: 'RESET_OVERVIEW', mode: nextMode });
      return;
    }
    skippedWordRef.current = null;
    dispatch({ type: 'START', mode: nextMode, queue: queue.items, now: Date.now() });
  }, []);

  const endRound = useCallback(() => {
    if (sessionRef.current.phase !== 'studying') return;
    dispatch({ type: 'END', now: Date.now() });
  }, []);

  const flipCard = useCallback(() => {
    if (sessionRef.current.phase !== 'studying') return;
    dispatch({ type: 'FLIP' });
  }, []);

  const gradeCurrent = useCallback((grade: Grade) => {
    const current = sessionRef.current;
    if (current.phase !== 'studying' || !current.flipped) return;
    const item = current.queue[current.index];
    if (!item) {
      dispatch({ type: 'END', now: Date.now() });
      return;
    }
    if (!dataRef.current.words.some((word) => word.id === item.word.id)) {
      dispatch({ type: 'SKIP', now: Date.now() });
      return;
    }
    actionsRef.current.gradeWord(item.word.id, grade);
    dispatch({ type: 'GRADE', grade, now: Date.now() });
  }, []);

  startRoundRef.current = startRound;
  endRoundRef.current = endRound;
  gradeRef.current = gradeCurrent;

  /* ------------------------------ 副作用 ------------------------------ */

  // 轮到一张已被删除的词：跳过并提示。
  useEffect(() => {
    if (session.phase !== 'studying' || !currentItem || currentWord) return;
    if (skippedWordRef.current === currentItem.word.id) return;
    skippedWordRef.current = currentItem.word.id;
    actionsRef.current.toast('这个词已被删除，已自动跳过。', 'info');
    dispatch({ type: 'SKIP', now: Date.now() });
  }, [session.phase, currentItem, currentWord]);

  // 全局快捷键：扉页空格开局；学习中空格翻面、1–4 自评、Esc 结束。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const current = sessionRef.current;
      const interactive = isInteractiveTarget(event.target);

      if (current.phase === 'overview') {
        if (interactive) return;
        if (event.key === ' ' || event.code === 'Space' || event.key === 'Enter') {
          if (!canStartRef.current) return;
          event.preventDefault();
          startRoundRef.current(current.mode);
        }
        return;
      }

      if (current.phase !== 'studying') return;

      if (event.key === 'Escape') {
        event.preventDefault();
        endRoundRef.current();
        return;
      }

      if (event.key === ' ' || event.code === 'Space') {
        // 焦点在按钮上时交给按钮自己处理，避免空格既翻面又点按钮。
        if (interactive) return;
        event.preventDefault();
        if (!event.repeat) dispatch({ type: 'FLIP' });
        return;
      }

      const digit = Number(event.key);
      if (!Number.isInteger(digit) || digit < 1 || digit > 4) return;
      if (event.repeat) return;
      if (!current.flipped) {
        // 还没翻面就按评分：轻点一下「翻面看释义」的提示。
        setNudge((value) => value + 1);
        return;
      }
      event.preventDefault();
      gradeRef.current(GRADE_ORDER[digit - 1]);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 小屏翻面后，把四档自评带入视野（不改变布局，只在需要时滚动）。
  useEffect(() => {
    if (session.phase !== 'studying' || !session.flipped) return;
    if (typeof window === 'undefined' || !window.matchMedia('(max-width: 760px)').matches) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gradesRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [session.phase, session.flipped]);

  // 离开学习页时收掉可能还在朗读的语音。
  useEffect(
    () => () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    },
    [],
  );

  /* ------------------------------ 渲染 ------------------------------ */

  const modeMeta = MODE_META[session.mode];
  const totalAvailable = preview ? preview.dueCount + preview.newCount : 0;
  const hasVocabulary = library.total > 0;
  const cardNo = session.index + 1;
  const roundPercent = percent(session.index, session.queue.length);
  const liveText =
    session.phase === 'studying' && currentWord
      ? session.flipped
        ? `第 ${cardNo} 张，共 ${session.queue.length} 张。${currentWord.term} 的释义已显示，可以自评。`
        : `第 ${cardNo} 张，共 ${session.queue.length} 张。当前词 ${currentWord.term}，按空格翻面。`
      : '';

  return (
    <div className="study">
      <p className="sr-only" role="status" aria-live="polite">
        {liveText}
      </p>

      {/* ============================== 扉页 / 概览 ============================== */}
      {session.phase === 'overview' && preview ? (
        <>
          <header className="view-head">
            <div>
              <div className="view-head__eyebrow">
                <span className="mono-label">STUDY / 温故</span>
                <span className="study-eyebrow-rule" aria-hidden="true" />
                <span className="study-eyebrow-date">{weekdayName(now.getTime())}</span>
              </div>
              <h1 className="view-title">今日学习</h1>
              <p className="view-sub">
                {!hasVocabulary
                  ? '还没有词可学。先去词库收几个想记的词，再回来温故。'
                  : totalAvailable === 0
                    ? '到期的旧词都复习完了，新词也都排进了计划。今天可以收工，也可以加几个新词。'
                    : `待复习 ${preview.dueCount} 张，新词 ${preview.newCount} 个。先看牌面，再起一轮。`}
              </p>
            </div>
            <div className="view-actions">
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => navigate('wordbook')}
              >
                <IconBook size={16} />
                去词库
              </button>
            </div>
          </header>

          <section className="study-sheet enter-up" aria-label="本轮概览">
            <span className="seal study-sheet__seal" aria-hidden="true">
              温
            </span>
            <div className="study-sheet__margin" aria-hidden="true">
              <span className="study-sheet__margin-date">{chineseDate(now)}</span>
              <span className="study-sheet__margin-rule" />
              <span className="study-sheet__margin-week">
                {weekdayName(now.getTime()).replace('星期', '周')}
              </span>
            </div>

            <div className="study-sheet__body">
              <header className="study-sheet__head">
                <h2 className="study-sheet__title">今日牌面</h2>
                <p className="study-sheet__sub">
                  词库共 {library.total} 个词条，已学 {library.learned} 个；今日已翻{' '}
                  {todayReviewed} 次。
                </p>
              </header>

              {hasVocabulary && totalAvailable > 0 ? (
                <>
                  <div className="study-figures">
                    <div className="study-figure">
                      <span className="study-figure__label">待复习</span>
                      <span className="study-figure__value">
                        {preview.dueCount}
                        <em>张</em>
                      </span>
                      <span className="study-figure__note">到期的旧词</span>
                    </div>
                    <div className="study-figure">
                      <span className="study-figure__label">新词</span>
                      <span className="study-figure__value">
                        {preview.newCount}
                        <em>个</em>
                      </span>
                      <span className="study-figure__note">尚未见过</span>
                    </div>
                    <div className="study-figure">
                      <span className="study-figure__label">总进度</span>
                      <span className="study-figure__value">
                        {library.mastery}
                        <em>%</em>
                      </span>
                      <span className="study-figure__note">全库平均掌握度</span>
                      <span className="study-figure__bar" aria-hidden="true">
                        <span style={{ width: `${library.mastery}%` }} />
                      </span>
                    </div>
                  </div>

                  <div className="study-setup">
                    <div className="study-setup__mode">
                      <span className="study-setup__label">本轮模式</span>
                      <div className="segmented" role="group" aria-label="选择学习模式">
                        {(Object.keys(MODE_META) as StudyMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            className={cx(
                              'segmented__option',
                              session.mode === mode && 'segmented__option--active',
                            )}
                            aria-pressed={session.mode === mode}
                            onClick={() => dispatch({ type: 'SET_MODE', mode })}
                          >
                            {MODE_META[mode].label}
                          </button>
                        ))}
                      </div>
                      <p className="study-setup__hint">{modeMeta.hint}</p>
                    </div>

                    <div className="study-setup__cta">
                      <span className="study-setup__count">
                        本轮 {preview.items.length} 张
                      </span>
                      <button
                        type="button"
                        className="btn btn--primary btn--lg"
                        disabled={preview.items.length === 0}
                        onClick={() => startRound(session.mode)}
                      >
                        {preview.items.length === 0 ? '本轮无卡' : '开始本轮'}
                      </button>
                      {preview.items.length > 0 ? (
                        <span className="study-setup__key">
                          <kbd className="kbd">空格</kbd> 直接开始
                        </span>
                      ) : (
                        <span className="study-setup__key">换个模式看看</span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="study-empty">
                  <div className="empty-state">
                    <span className="empty-state__mark" aria-hidden="true">
                      {hasVocabulary ? '完' : '空'}
                    </span>
                    <h2 className="empty-state__title">
                      {hasVocabulary ? '今日牌面已清空' : '词库还是空的'}
                    </h2>
                    <p className="empty-state__desc">
                      {hasVocabulary
                        ? '到期的旧词都复习完了，新词也都排进了计划。明天再来，或者现在加几个新词。'
                        : '先收几个想记的词，再回来温故。也可以让 AI 从错题里为你出题。'}
                    </p>
                    <div className="study-empty__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() => navigate('wordbook')}
                      >
                        <IconBook size={16} />
                        去词库添加
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => navigate('drill')}
                      >
                        <IconSparkle size={16} />
                        AI 特训
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}

      {/* ================================ 学习中 ================================ */}
      {session.phase === 'studying' && currentItem ? (
        <>
          <header className="view-head">
            <div>
              <div className="view-head__eyebrow">
                <span className="mono-label">STUDY / 温故</span>
                <span className="study-eyebrow-rule" aria-hidden="true" />
                <span className="study-eyebrow-date">{modeMeta.full}</span>
              </div>
              <h1 className="view-title">今日学习</h1>
              <p className="view-sub">先在心里回想，再翻面核对；按真实的记忆手感自评。</p>
            </div>
            <div className="view-actions">
              <span className="study-count">
                <strong>{pad2(cardNo)}</strong>
                <span className="study-count__divider" aria-hidden="true">
                  /
                </span>
                <span>{pad2(session.queue.length)}</span>
              </span>
              <button type="button" className="btn btn--quiet" onClick={endRound}>
                结束本轮
              </button>
            </div>
          </header>

          <div className="study-track">
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={session.queue.length}
              aria-valuenow={session.index}
              aria-label="本轮进度"
            >
              <div className="progress__bar" style={{ width: `${roundPercent}%` }} />
            </div>
            <div className="study-track__meta">
              <span className="study-tallies">
                <span className="study-tally study-tally--good">
                  记住 {session.counts.good + session.counts.easy}
                </span>
                <span className="study-tally study-tally--hard">模糊 {session.counts.hard}</span>
                <span className="study-tally study-tally--again">没记住 {session.counts.again}</span>
              </span>
              <span className="study-track__mode">{modeMeta.full}</span>
            </div>
          </div>

          <div className="study-stage">
            {currentWord && currentCard ? (
              <>
                <Flashcard
                  word={currentWord}
                  card={currentCard}
                  isNew={currentItem.isNew}
                  isDue={currentItem.isDue}
                  flipped={session.flipped}
                  nudge={nudge}
                  onFlip={flipCard}
                  onSpeak={() => speak(currentWord.term)}
                />

                <div
                  className={cx('study-grades', !session.flipped && 'is-locked')}
                  ref={gradesRef}
                  role="group"
                  aria-label="按记忆手感自评"
                >
                  {GRADE_ORDER.map((grade) => {
                    const meta = GRADE_META[grade];
                    return (
                      <button
                        key={grade}
                        type="button"
                        className={cx('study-grade', `study-grade--${meta.tone}`)}
                        disabled={!session.flipped}
                        onClick={() => gradeCurrent(grade)}
                        aria-keyshortcuts={meta.key}
                        title={meta.hint}
                      >
                        <span className="study-grade__top">
                          <span className="study-grade__dot" aria-hidden="true" />
                          <span className="study-grade__label">{meta.label}</span>
                          <span className="study-grade__key" aria-hidden="true">
                            {meta.key}
                          </span>
                        </span>
                        <span className="study-grade__preview">
                          {previewInterval(currentCard, grade)}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <p className="study-keys">
                  <span>
                    <kbd className="kbd">空格</kbd> 翻面
                  </span>
                  <span>
                    <kbd className="kbd">1</kbd>–<kbd className="kbd">4</kbd> 自评
                  </span>
                  <span>
                    <kbd className="kbd">Esc</kbd> 结束本轮
                  </span>
                </p>
                <p className="study-touch">轻触卡片翻面，再按记忆手感选四档自评</p>
              </>
            ) : (
              <p className="study-placeholder">正在翻到下一张…</p>
            )}
          </div>
        </>
      ) : null}

      {/* ================================ 小结 ================================ */}
      {session.phase === 'summary' ? (
        <>
          <header className="view-head">
            <div>
              <div className="view-head__eyebrow">
                <span className="mono-label">STUDY / 温故</span>
                <span className="study-eyebrow-rule" aria-hidden="true" />
                <span className="study-eyebrow-date">本轮收束</span>
              </div>
              <h1 className="view-title">本轮小结</h1>
              <p className="view-sub">
                翻过的牌已经归入记忆曲线。记不住的词会更快回来，也会进入错题特训。
              </p>
            </div>
            <div className="view-actions">
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => navigate('dashboard')}
              >
                <IconHome size={16} />
                回首页
              </button>
            </div>
          </header>

          <StudySummary
            mode={session.mode}
            counts={session.counts}
            results={session.results}
            elapsedMs={Math.max(0, session.endedAt - session.startedAt)}
            words={data.words}
            onAgain={() => startRound(session.mode)}
            onDrill={() => navigate('drill')}
          />
        </>
      ) : null}
    </div>
  );
}
