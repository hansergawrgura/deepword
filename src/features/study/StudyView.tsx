import type { ViewProps } from '@/domain/types';
import { cx, percent, weekdayName } from '@/domain/utils';
import { newQuestionCount, reviewQuestionCount } from '@/domain/practiceRound';
import { IconBook, IconHome } from '@/ui/icons';
import Flashcard, { DEFAULT_GATE_SCHEDULE } from './Flashcard';
import LookupPopover from './lookup/LookupPopover';
import StudySearch from './lookup/StudySearch';
import { useStudyLookup } from './lookup/useStudyLookup';
import QuestionCard from './QuestionCard';
import RoundSummary from './RoundSummary';
import { useStudyController } from './useStudyController';
import './StudyView.css';

export default function StudyView({ navigate }: ViewProps) {
  const c = useStudyController();
  const answering = Boolean(c.question) && (c.stage === 'new' || c.stage === 'review');
  const currentWord = c.question
    ? (c.wordMap.get(c.question.wordId) ?? c.data.words[0])
    : undefined;
  const studyLookup = useStudyLookup({
    llmSettings: c.llmSettings,
    aiAvailable: c.aiAvailable,
    words: c.data.words,
    question: c.question,
    word: currentWord,
  });

  return (
    <div className={cx('study', answering && 'study--answering')}>
      <div className="study-chrome">
        {answering ? (
          <StudySearch
            onSearch={(query) => {
              void studyLookup.lookup('search', query, {
                top: 64,
                left: Math.round(window.innerWidth / 2),
              });
            }}
          />
        ) : null}

        {c.roundQuestions > 0 ? (
          <div className="study-progress study-progress--top">
            <div
              className="progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={c.roundQuestions}
              aria-valuenow={c.roundIndex}
              aria-label="本轮进度"
            >
              <div
                className="progress__bar"
                style={{ width: `${percent(c.session?.questionIndex ?? 0, c.roundQuestions)}%` }}
              />
            </div>
            <div className="study-progress__meta">
              <span>
                第 {c.session?.roundNo ?? 1} 轮 · {c.planVisible ? '待继续' : c.stageLabel} · 第{' '}
                {c.roundIndex} / {c.roundQuestions} 题
              </span>
              <span>
                已答 {c.session?.answered ?? 0} 题
                {c.summary ? ` · 正确率 ${c.summary.accuracy}%` : ''}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="study-bar">
        <span className="study-bar__stage" title={c.studyHint}>
          {weekdayName(c.nowTs)} · {c.stageLabel}
        </span>
        <div className="study-bar__actions">
          {c.session && !c.planVisible ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={c.finishRound}>
              {c.stage === 'done' ? <IconHome size={14} /> : null}
              {c.stage === 'done' ? '回概览' : '结束本轮'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => navigate('wordbook')}
            >
              <IconBook size={14} />
              去词库
            </button>
          )}
        </div>
      </div>

      <div className="view-stage view-stage--fixed">
        <div className="view-stage__inner">
          {c.planVisible ? (
            <section className="study-sheet enter-up" aria-label="本轮计划">
              <span className="seal study-sheet__seal" aria-hidden="true">
                温
              </span>
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">本轮计划</h2>
                  <p className="study-sheet__sub">
                    第 {c.plan.roundNo} 轮 · 一轮 = {c.plan.newWords.length} 个新词 +{' '}
                    {c.plan.reviewWords.length} 个复习词；今日已学 {c.todayReviewed} 次。
                  </p>
                </header>

                {c.data.words.length === 0 ? (
                  <div className="study-empty">
                    <div className="empty-state">
                      <span className="empty-state__mark" aria-hidden="true">
                        空
                      </span>
                      <h2 className="empty-state__title">词库还是空的</h2>
                      <p className="empty-state__desc">先收几个想记的词，再回来温故。</p>
                      <div className="study-empty__actions">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => navigate('wordbook')}
                        >
                          <IconBook size={16} />
                          去词库添加
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {c.resumable ? (
                      <div className="study-resume" role="status">
                        <p className="study-resume__title">上一轮还没结束</p>
                        <p className="study-resume__desc">
                          第 {c.resumable.roundNo ?? 1} 轮，已答 {c.resumable.answered ?? 0} 题
                          {c.resumable.stage === 'gate'
                            ? '，还停在新词闸门'
                            : c.resumable.stage === 'new'
                              ? '，还在新词练习'
                              : '，还在复习'}
                          。继续会回到原来的位置。
                        </p>
                        <div className="study-resume__actions">
                          <button type="button" className="btn btn--primary" onClick={c.resumeRound}>
                            继续上一轮
                          </button>
                          <button type="button" className="btn btn--ghost" onClick={c.startRound}>
                            重新开始一轮
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="study-figures">
                      <div className="study-figure">
                        <span className="study-figure__label">新词</span>
                        <span className="study-figure__value">
                          {c.plan.newWords.length}
                          <em>个</em>
                        </span>
                        <span className="study-figure__note">
                          本轮 {c.plan.newWords.length > 0 ? newQuestionCount(c.data.practice) : 0}{' '}
                          题 / 词
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">复习</span>
                        <span className="study-figure__value">
                          {c.plan.reviewWords.length}
                          <em>个</em>
                        </span>
                        <span className="study-figure__note">
                          本轮{' '}
                          {reviewQuestionCount(
                            c.data.practice,
                            Math.max(1, c.plan.reviewWords.length),
                          )}{' '}
                          题
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">掌握度</span>
                        <span className="study-figure__value">
                          {c.masteryRate}
                          <em>%</em>
                        </span>
                        <span className="study-figure__note">已掌握 {c.available.mastered} 词</span>
                      </div>
                    </div>

                    <div className="study-setup">
                      <div className="study-setup__mode">
                        <span className="study-setup__label">这一轮怎么走</span>
                        <ol className="study-flow">
                          <li>新词先过闸门：认识就出题，掌握就永久记住。</li>
                          <li>
                            {c.data.practice.newWordsPerRound} 个新词，每个{' '}
                            {c.data.practice.questionsPerNewWord} 题，覆盖 6 个技能。
                          </li>
                          <li>
                            复习 {c.data.practice.reviewWordsPerRound} 个词（
                            {c.data.practice.reviewQuestionsPerRound} 题），按薄弱度优先。
                          </li>
                          <li>小结之后点「继续」，进入下一轮。</li>
                        </ol>
                      </div>

                      <div className="study-setup__cta">
                        <span className="study-setup__count">
                          {c.available.newWords > 0 || c.available.reviewWords > 0
                            ? '准备好了就开始'
                            : '今天没有待学的词'}
                        </span>
                        <button
                          type="button"
                          className="btn btn--primary btn--lg"
                          disabled={c.available.newWords === 0 && c.available.reviewWords === 0}
                          onClick={c.startRound}
                        >
                          开始一轮
                        </button>
                        <span className="study-setup__key">
                          {c.aiAvailable ? '互译题可用' : '未配置 AI · 互译题不出'}
                          {c.ttsAvailable ? '' : ' · 无英文语音，听音题不出'}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          ) : c.stage === 'done' && c.session ? (
            <RoundSummary
              session={c.session}
              words={c.data.words}
              elapsedMs={Math.max(0, Date.now() - c.session.startedAt)}
              masteredWordId={c.masteredThisRound}
              onContinue={c.startRound}
              onFinish={c.finishRound}
            />
          ) : c.stage === 'gate' && c.gateWord ? (
            <div className="view-stage__pane">
              <Flashcard
                word={c.gateWord}
                card={DEFAULT_GATE_SCHEDULE}
                isNew
                isDue={false}
                flipped={c.gateFlipped}
                nudge={c.nudge}
                variant="gate"
                onFlip={c.handleGateMasterIntent}
                onSpeak={() => c.speak(c.gateWord!.term)}
              />

              {c.gateFlipped ? (
                <div className="practice-gate">
                  <p className="practice-gate__ask">确认已经掌握这个词？</p>
                  <p className="practice-gate__hint">
                    确认后它将永久退出学习与复习队列；点「再想想」继续出题。
                  </p>
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={c.handleGateUnknown}>
                      再想想
                    </button>
                    <button type="button" className="btn btn--primary" onClick={c.handleGateConfirm}>
                      确认掌握
                    </button>
                  </div>
                </div>
              ) : (
                <div className="practice-gate" role="group" aria-label="新词闸门">
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={c.handleGateUnknown}>
                      不认识
                    </button>
                    <button type="button" className="btn btn--primary" onClick={c.handleGateMasterIntent}>
                      掌握
                    </button>
                  </div>
                  <p className="practice-gate__hint">
                    点「掌握」会翻面显示释义，并再问你一次；确定才作数。
                  </p>
                </div>
              )}
            </div>
          ) : c.question && currentWord ? (
            <QuestionCard
              question={c.question}
              word={currentWord}
              index={c.session?.questionIndex ?? 0}
              total={c.session?.questions?.length ?? 0}
              phase={c.phase}
              feedback={c.feedback}
              showWordInfo={c.stage === 'new' && (c.session?.questionIndex ?? 0) === 0}
              mustReadExplanation={c.feedback?.verdict === 'poor'}
              autoAdvance={c.autoAdvance}
              onAskExplain={
                c.needsExplain && c.aiAvailable && c.llmSettings ? c.handleAskExplain : undefined
              }
              explaining={c.explaining}
              lookup={studyLookup}
              onSubmit={(response) => void c.handleSubmit(response)}
              onNext={c.handleNext}
              onSpeak={c.speak}
            />
          ) : (
            <section className="study-sheet enter-up" aria-label="本轮概览">
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">这一轮已经排好了</h2>
                  <p className="study-sheet__sub">点「开始一轮」继续下一轮学习。</p>
                </header>
                <div className="study-setup">
                  <div className="study-setup__cta">
                    <button type="button" className="btn btn--primary" onClick={c.resumeRound}>
                      继续这一轮
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={c.startRound}>
                      重开一轮
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {studyLookup.active ? (
        <LookupPopover active={studyLookup.active} onClose={studyLookup.clear} />
      ) : null}
    </div>
  );
}
