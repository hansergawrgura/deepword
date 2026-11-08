import type { Word } from '@/domain/types';
import { cx } from '@/domain/utils';
import { useT } from '@/i18n';
import type { TranslateFn } from '@/i18n';
import { IconVolume } from '@/ui/icons';

export interface FlashcardSchedule {
  status: 'new' | 'learning' | 'review' | 'relearning';
  dueAt: number;
  interval: number;
}

export interface FlashcardProps {
  word: Word;
  card: FlashcardSchedule;
  isNew: boolean;
  isDue: boolean;
  flipped: boolean;
  nudge: number;
  variant?: 'card' | 'gate';
  onFlip: () => void;
  onSpeak: () => void;
}

const STATUS_TONE_CLASS: Record<'muted' | 'vermilion' | 'gold' | 'sage', string> = {
  muted: 'badge--outline',
  vermilion: 'badge--vermilion',
  gold: 'badge--gold',
  sage: 'badge--sage',
};

function statusMeta(
  t: TranslateFn,
  status: FlashcardSchedule['status'],
): { label: string; tone: 'vermilion' | 'gold' | 'sage' } {
  switch (status) {
    case 'new':
      return { label: t('study.flashcardNew'), tone: 'vermilion' };
    case 'learning':
      return { label: t('study.flashcardLearning'), tone: 'gold' };
    case 'review':
      return { label: t('study.flashcardReview'), tone: 'sage' };
    case 'relearning':
      return { label: t('study.flashcardRelearning'), tone: 'vermilion' };
  }
}

function wordSizeClass(term: string): string {
  if (term.length > 14) return 'is-longer';
  if (term.length > 9) return 'is-long';
  return '';
}

function dueLabel(t: TranslateFn, card: FlashcardSchedule, now = Date.now()): string {
  if (card.status === 'new') return t('study.flashcardFirstLearn');
  const delta = card.dueAt - now;
  if (delta <= 0) return t('study.flashcardOverdue');
  const days = Math.ceil(delta / 86_400_000);
  if (days <= 1) return t('study.flashcardDueToday');
  return t('study.flashcardDaysLater', { days });
}

function masteryScore(card: FlashcardSchedule): number {
  if (card.status === 'new') return 0;
  if (card.status === 'learning') return 35;
  if (card.status === 'relearning') return 20;
  return Math.min(100, 50 + Math.round(card.interval * 8));
}

export const DEFAULT_GATE_SCHEDULE: FlashcardSchedule = {
  status: 'new',
  dueAt: Date.now(),
  interval: 0,
};

export default function Flashcard({
  word,
  card,
  isNew,
  isDue,
  flipped,
  nudge,
  variant = 'gate',
  onFlip,
  onSpeak,
}: FlashcardProps) {
  const t = useT();
  const status = isNew ? statusMeta(t, 'new') : statusMeta(t, card.status);
  const seal = isNew ? t('study.flashcardSealNew') : t('study.flashcardSealReview');
  const mastery = masteryScore(card);
  const intervalText =
    card.interval > 0
      ? t('study.flashcardIntervalDays', { days: card.interval })
      : t('study.flashcardNotScheduled');
  const dueText = dueLabel(t, card);
  const gate = variant === 'gate';

  return (
    <div className="study-card-stage">
      <div className={cx('study-card', flipped && 'is-flipped')}>
        <article
          className="study-card__face study-card__face--front"
          inert={flipped}
          aria-hidden={flipped}
          onClick={onFlip}
        >
          <span className="seal study-card__seal" aria-hidden="true">
            {seal}
          </span>

          <header className="study-card__top">
            <div className="study-card__metas">
              <span className={cx('badge', STATUS_TONE_CLASS[status.tone])}>{status.label}</span>
              {isDue && !isNew ? (
                <span className="badge badge--outline">{t('study.flashcardDueBadge')}</span>
              ) : null}
            </div>
          </header>

          <div className="study-card__center">
            <h2 className={cx('study-card__word', wordSizeClass(word.term))}>{word.term}</h2>
            {gate ? (
              <p className="study-card__gate-hint">{t('study.gateThinkHint')}</p>
            ) : word.phonetic || word.partOfSpeech ? (
              <p className="study-card__pron">
                {word.phonetic ? (
                  <span className="study-card__phonetic">{word.phonetic}</span>
                ) : null}
                {word.partOfSpeech ? (
                  <span className="study-card__back-pos">{word.partOfSpeech}</span>
                ) : null}
              </p>
            ) : null}
          </div>

          <footer className="study-card__foot">
            <span className="study-card__tags">
              {gate ? null : word.tags.length > 0 ? (
                word.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="study-card__tag">
                    #{tag}
                  </span>
                ))
              ) : (
                <span className="study-card__tag study-card__tag--quiet">
                  {t('study.flashcardUncategorized')}
                </span>
              )}
            </span>

            <span className="study-card__actions">
              <button
                type="button"
                className="study-speak"
                onClick={(event) => {
                  event.stopPropagation();
                  onSpeak();
                }}
                aria-label={t('study.speakAria', { term: word.term })}
              >
                <IconVolume size={15} />
                {t('study.speak')}
              </button>
              <button
                type="button"
                className={cx('study-card__hint', nudge > 0 && 'is-nudged')}
                key={nudge}
                onClick={(event) => {
                  event.stopPropagation();
                  onFlip();
                }}
              >
                <span className="kbd">{t('study.spaceKey')}</span>
                {t('study.flipHint')}
              </button>
            </span>
          </footer>
        </article>

        <article
          className="study-card__face study-card__face--back"
          inert={!flipped}
          aria-hidden={!flipped}
        >
          <span className="seal study-card__seal" aria-hidden="true">
            {t('study.flashcardSealMeaning')}
          </span>

          <header className="study-card__top study-card__top--back">
            <div className="study-card__metas">
              <span className={cx('badge', STATUS_TONE_CLASS[status.tone])}>{status.label}</span>
              <span className="study-card__back-term">{word.term}</span>
              {word.phonetic ? (
                <span className="study-card__back-phonetic">{word.phonetic}</span>
              ) : null}
              {word.partOfSpeech ? (
                <span className="study-card__back-pos">{word.partOfSpeech}</span>
              ) : null}
            </div>
          </header>

          <div className="study-card__back-main">
            <p className="study-card__meaning">{word.meaning}</p>

            {word.example ? (
              <figure className="study-card__example">
                <blockquote className="study-card__example-en">{word.example}</blockquote>
                {word.exampleTranslation ? (
                  <figcaption className="study-card__example-zh">
                    {word.exampleTranslation}
                  </figcaption>
                ) : null}
              </figure>
            ) : (
              <p className="study-card__example-empty">{t('study.noExample')}</p>
            )}
          </div>

          <footer className="study-card__foot study-card__foot--due">
            <span className="study-card__tags">
              {gate && word.tags.length > 0
                ? word.tags.slice(0, 4).map((tag) => (
                    <span key={tag} className="study-card__tag">
                      #{tag}
                    </span>
                  ))
                : null}
            </span>

            <dl className="study-card__due">
              <div className="study-card__due-item">
                <dt>{t('study.flashcardStatus')}</dt>
                <dd>{status.label}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>{t('study.flashcardSchedule')}</dt>
                <dd>{dueText}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>{t('study.flashcardInterval')}</dt>
                <dd>{intervalText}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>{t('study.flashcardMastery')}</dt>
                <dd>{mastery}%</dd>
              </div>
            </dl>

            <button
              type="button"
              className="study-speak"
              onClick={onSpeak}
              aria-label={t('study.speakAria', { term: word.term })}
            >
              <IconVolume size={15} />
              {t('study.speak')}
            </button>
          </footer>
        </article>
      </div>
    </div>
  );
}
