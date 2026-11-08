import type { ViewProps } from '@/domain/types';
import { cx, percent, weekdayName } from '@/domain/utils';
import { newQuestionCount, reviewQuestionCount } from '@/domain/practiceRound';
import { useLocale, useT } from '@/i18n';
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
  const t = useT();
  const locale = useLocale();
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

  const resumeStageHint =
    c.resumable?.stage === 'gate'
      ? t('study.resumeAtGate')
      : c.resumable?.stage === 'new'
        ? t('study.resumeAtNew')
        : c.resumable?.stage === 'review'
          ? t('study.resumeAtReview')
          : '';

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
              aria-label={t('study.progressAria')}
            >
              <div
                className="progress__bar"
                style={{ width: `${percent(c.session?.questionIndex ?? 0, c.roundQuestions)}%` }}
              />
            </div>
            <div className="study-progress__meta">
              <span>
                {t('study.progressMeta', {
                  roundNo: c.session?.roundNo ?? 1,
                  stage: c.planVisible ? t('study.stagePending') : c.stageLabel,
                  index: c.roundIndex,
                  total: c.roundQuestions,
                })}
              </span>
              <span>
                {c.summary
                  ? t('study.answeredMeta', {
                      answered: c.session?.answered ?? 0,
                      accuracy: c.summary.accuracy,
                    })
                  : t('study.answeredOnly', { answered: c.session?.answered ?? 0 })}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="study-bar">
        <span className="study-bar__stage" title={c.studyHint}>
          {weekdayName(c.nowTs, locale)} · {c.stageLabel}
        </span>
        <div className="study-bar__actions">
          {c.session && !c.planVisible ? (
            <button type="button" className="btn btn--quiet btn--sm" onClick={c.finishRound}>
              {c.stage === 'done' ? <IconHome size={14} /> : null}
              {c.stage === 'done' ? t('study.backOverview') : t('study.endRound')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => navigate('wordbook')}
            >
              <IconBook size={14} />
              {t('study.goWordbook')}
            </button>
          )}
        </div>
      </div>

      <div className="view-stage view-stage--fixed">
        <div className="view-stage__inner">
          {c.planVisible ? (
            <section className="study-sheet enter-up" aria-label={t('study.planTitle')}>
              <span className="seal study-sheet__seal" aria-hidden="true">
                {t('dashboard.watermarkWarm')}
              </span>
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">{t('study.planTitle')}</h2>
                  <p className="study-sheet__sub">
                    {t('study.planSub', {
                      roundNo: c.plan.roundNo,
                      newCount: c.plan.newWords.length,
                      reviewCount: c.plan.reviewWords.length,
                      todayReviewed: c.todayReviewed,
                    })}
                  </p>
                </header>

                {c.data.words.length === 0 ? (
                  <div className="study-empty">
                    <div className="empty-state">
                      <span className="empty-state__mark" aria-hidden="true">
                        {t('common.emptyMark')}
                      </span>
                      <h2 className="empty-state__title">{t('study.emptyWordbook')}</h2>
                      <p className="empty-state__desc">{t('study.emptyWordbookDesc')}</p>
                      <div className="study-empty__actions">
                        <button
                          type="button"
                          className="btn btn--primary"
                          onClick={() => navigate('wordbook')}
                        >
                          <IconBook size={16} />
                          {t('study.goWordbookAdd')}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {c.resumable ? (
                      <div className="study-resume" role="status">
                        <p className="study-resume__title">{t('study.resumeTitle')}</p>
                        <p className="study-resume__desc">
                          {t('study.resumeDesc', {
                            roundNo: c.resumable.roundNo ?? 1,
                            answered: c.resumable.answered ?? 0,
                            stageHint: resumeStageHint,
                          })}
                        </p>
                        <div className="study-resume__actions">
                          <button type="button" className="btn btn--primary" onClick={c.resumeRound}>
                            {t('study.continueLast')}
                          </button>
                          <button type="button" className="btn btn--ghost" onClick={c.startRound}>
                            {t('study.restartRound')}
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="study-figures">
                      <div className="study-figure">
                        <span className="study-figure__label">{t('study.figureNew')}</span>
                        <span className="study-figure__value">
                          {c.plan.newWords.length}
                          {locale === 'zh-CN' ? <em>{t('dashboard.statUnitWords')}</em> : null}
                        </span>
                        <span className="study-figure__note">
                          {t('study.questionsPerWord', {
                            count:
                              c.plan.newWords.length > 0 ? newQuestionCount(c.data.practice) : 0,
                          })}
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">{t('study.figureReview')}</span>
                        <span className="study-figure__value">
                          {c.plan.reviewWords.length}
                          {locale === 'zh-CN' ? <em>{t('dashboard.statUnitWords')}</em> : null}
                        </span>
                        <span className="study-figure__note">
                          {t('study.reviewQuestions', {
                            count: reviewQuestionCount(
                              c.data.practice,
                              Math.max(1, c.plan.reviewWords.length),
                            ),
                          })}
                        </span>
                      </div>
                      <div className="study-figure">
                        <span className="study-figure__label">{t('study.figureMastery')}</span>
                        <span className="study-figure__value">
                          {c.masteryRate}
                          <em>%</em>
                        </span>
                        <span className="study-figure__note">
                          {t('study.masteredCount', { count: c.available.mastered })}
                        </span>
                      </div>
                    </div>

                    <div className="study-setup">
                      <div className="study-setup__mode">
                        <span className="study-setup__label">{t('study.flowTitle')}</span>
                        <ol className="study-flow">
                          <li>{t('study.flow1')}</li>
                          <li>
                            {t('study.flow2', {
                              newWords: c.data.practice.newWordsPerRound,
                              questionsPerWord: c.data.practice.questionsPerNewWord,
                            })}
                          </li>
                          <li>
                            {t('study.flow3', {
                              reviewWords: c.data.practice.reviewWordsPerRound,
                              reviewQuestions: c.data.practice.reviewQuestionsPerRound,
                            })}
                          </li>
                          <li>{t('study.flow4')}</li>
                        </ol>
                      </div>

                      <div className="study-setup__cta">
                        <span className="study-setup__count">
                          {c.available.newWords > 0 || c.available.reviewWords > 0
                            ? t('study.ready')
                            : t('study.nothingToday')}
                        </span>
                        <button
                          type="button"
                          className="btn btn--primary btn--lg"
                          disabled={c.available.newWords === 0 && c.available.reviewWords === 0}
                          onClick={c.startRound}
                        >
                          {t('study.startRound')}
                        </button>
                        <span className="study-setup__key">
                          {c.aiAvailable ? t('study.aiOn') : t('study.aiOff')}
                          {c.ttsAvailable ? '' : t('study.ttsOff')}
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
                  <p className="practice-gate__ask">{t('study.gateConfirm')}</p>
                  <p className="practice-gate__hint">{t('study.gateConfirmHint')}</p>
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={c.handleGateUnknown}>
                      {t('study.thinkAgain')}
                    </button>
                    <button type="button" className="btn btn--primary" onClick={c.handleGateConfirm}>
                      {t('study.confirmMaster')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="practice-gate" role="group" aria-label={t('study.stageGate')}>
                  <div className="practice-gate__actions">
                    <button type="button" className="btn btn--ghost" onClick={c.handleGateUnknown}>
                      {t('study.unknown')}
                    </button>
                    <button type="button" className="btn btn--primary" onClick={c.handleGateMasterIntent}>
                      {t('study.master')}
                    </button>
                  </div>
                  <p className="practice-gate__hint">{t('study.gateFlipHint')}</p>
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
            <section className="study-sheet enter-up" aria-label={t('study.stageOverview')}>
              <div className="study-sheet__body">
                <header className="study-sheet__head">
                  <h2 className="study-sheet__title">{t('study.scheduledTitle')}</h2>
                  <p className="study-sheet__sub">{t('study.scheduledSub')}</p>
                </header>
                <div className="study-setup">
                  <div className="study-setup__cta">
                    <button type="button" className="btn btn--primary" onClick={c.resumeRound}>
                      {t('study.continueRound')}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={c.startRound}>
                      {t('study.reopenRound')}
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
