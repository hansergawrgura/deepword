import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/domain/utils';
import { useT } from '@/i18n';
import { IconClose } from '@/ui/icons';
import type { StudyLookupState } from './useStudyLookup';

export interface LookupPopoverProps {
  active: StudyLookupState;
  onClose: () => void;
}

export default function LookupPopover({ active, onClose }: LookupPopoverProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const kindLabel =
    active.kind === 'word'
      ? t('study.lookupKindWord')
      : active.kind === 'sentence'
        ? t('study.lookupKindSentence')
        : t('study.lookupKindSearch');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.study-selection-assist, .study-word-hot, .study-search')) {
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [onClose]);

  const anchor = active.anchor;
  const style: CSSProperties = anchor
    ? {
        top: Math.min(anchor.top, window.innerHeight - 160),
        left: Math.min(Math.max(16, anchor.left - 160), window.innerWidth - 336),
      }
    : {
        top: 72,
        left: '50%',
        transform: 'translateX(-50%)',
      };

  return createPortal(
    <div
      ref={panelRef}
      className={cx(
        'study-lookup-pop',
        active.status === 'loading' && 'is-loading',
        active.status === 'error' && 'is-error',
      )}
      style={style}
      role="dialog"
      aria-label={kindLabel}
    >
      <header className="study-lookup-pop__head">
        <div className="study-lookup-pop__meta">
          <strong>{kindLabel}</strong>
          <span className="study-lookup-pop__query">{active.query}</span>
        </div>
        <button type="button" className="icon-btn" aria-label={t('study.lookupClose')} onClick={onClose}>
          <IconClose size={14} />
        </button>
      </header>

      <div className="study-lookup-pop__body">
        {active.status === 'loading' ? (
          <p className="study-lookup-pop__pending">{t('study.lookupLoading')}</p>
        ) : (
          <p className="study-lookup-pop__text">{active.text}</p>
        )}
      </div>

      {active.status === 'ready' ? (
        <footer className="study-lookup-pop__foot">
          {active.local ? <span>{t('study.sourceLocal')}</span> : null}
          {active.cached ? <span>{t('study.sourceCached')}</span> : null}
          {!active.local && !active.cached ? <span>{t('study.sourceFresh')}</span> : null}
        </footer>
      ) : null}
    </div>,
    document.body,
  );
}
