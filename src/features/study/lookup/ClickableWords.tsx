// stopPropagation on word clicks so option submit does not fire.
import { useMemo } from 'react';
import { useT } from '@/i18n';
import type { LookupAnchor } from './useStudyLookup';

const TOKEN_RE = /([A-Za-z][A-Za-z'-]*|[0-9]+(?:\.[0-9]+)?|[^A-Za-z0-9]+)/g;

export interface ClickableWordsProps {
  text: string;
  className?: string;
  onWordClick: (word: string, anchor: LookupAnchor) => void;
}

function isWordToken(token: string): boolean {
  return /^[A-Za-z][A-Za-z'-]*$/.test(token) && token.length >= 2;
}

export default function ClickableWords({ text, className, onWordClick }: ClickableWordsProps) {
  const t = useT();
  const tokens = useMemo(() => text.match(TOKEN_RE) ?? [text], [text]);

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        if (!isWordToken(token)) {
          return <span key={`${index}-${token.slice(0, 8)}`}>{token}</span>;
        }
        return (
          <button
            key={`${index}-${token}`}
            type="button"
            className="study-word-hot"
            title={t('study.wordLookup', { token })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onWordClick(token, {
                top: rect.bottom + 6,
                left: rect.left + rect.width / 2,
              });
            }}
          >
            {token}
          </button>
        );
      })}
    </span>
  );
}
