import type { Word } from '@/domain/types';
import { cx } from '@/domain/utils';
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

const STATUS_META = {
  new: { label: '新词', tone: 'vermilion' as const },
  learning: { label: '学习中', tone: 'gold' as const },
  review: { label: '复习', tone: 'sage' as const },
  relearning: { label: '重学', tone: 'vermilion' as const },
} as const;

const STATUS_TONE_CLASS: Record<'muted' | 'vermilion' | 'gold' | 'sage', string> = {
  muted: 'badge--outline',
  vermilion: 'badge--vermilion',
  gold: 'badge--gold',
  sage: 'badge--sage',
};

function wordSizeClass(term: string): string {
  if (term.length > 14) return 'is-longer';
  if (term.length > 9) return 'is-long';
  return '';
}

function dueLabel(card: FlashcardSchedule, now = Date.now()): string {
  if (card.status === 'new') return '首次学习';
  const delta = card.dueAt - now;
  if (delta <= 0) return '已到期';
  const days = Math.ceil(delta / 86_400_000);
  if (days <= 1) return '今天';
  return `${days} 天后`;
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
  const status = isNew ? STATUS_META.new : STATUS_META[card.status];
  const seal = isNew ? '新' : '复';
  const mastery = masteryScore(card);
  const intervalText = card.interval > 0 ? `${card.interval} 天` : '尚未排期';
  const dueText = dueLabel(card);
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
              {isDue && !isNew ? <span className="badge badge--outline">到期</span> : null}
            </div>
          </header>

          <div className="study-card__center">
            <h2 className={cx('study-card__word', wordSizeClass(word.term))}>{word.term}</h2>
            {gate ? (
              <p className="study-card__gate-hint">先想一想它的意思，再决定认不认识。</p>
            ) : word.phonetic || word.partOfSpeech ? (
              <p className="study-card__pron">
                {word.phonetic ? (
                  <span className="study-card__phonetic">{word.phonetic}</span>
                ) : null}
                {word.partOfSpeech ? (
                  <span className="study-card__pos">{word.partOfSpeech}</span>
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
                <span className="study-card__tag study-card__tag--quiet">未归类</span>
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
                aria-label={`朗读 ${word.term}`}
              >
                <IconVolume size={15} />
                朗读
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
                <span className="kbd">空格</span>
                翻面看释义
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
            释
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
              <p className="study-card__example-empty">这个词还没有例句，先记住它的释义。</p>
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
                <dt>状态</dt>
                <dd>{status.label}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>排期</dt>
                <dd>{dueText}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>间隔</dt>
                <dd>{intervalText}</dd>
              </div>
              <div className="study-card__due-item">
                <dt>掌握</dt>
                <dd>{mastery}%</dd>
              </div>
            </dl>

            <button type="button" className="study-speak" onClick={onSpeak} aria-label={`朗读 ${word.term}`}>
              <IconVolume size={15} />
              朗读
            </button>
          </footer>
        </article>
      </div>
    </div>
  );
}
