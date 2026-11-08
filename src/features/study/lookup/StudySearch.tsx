import { useState } from 'react';
import { useT } from '@/i18n';
import { IconSearch } from '@/ui/icons';

export interface StudySearchProps {
  disabled?: boolean;
  onSearch: (query: string) => void;
}

export default function StudySearch({ disabled, onSearch }: StudySearchProps) {
  const t = useT();
  const [value, setValue] = useState('');

  function submit() {
    const query = value.trim();
    if (!query) return;
    onSearch(query);
  }

  return (
    <form
      className="study-search"
      role="search"
      aria-label={t('study.searchPlaceholder')}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <IconSearch size={14} />
      <input
        className="study-search__input"
        type="search"
        value={value}
        disabled={disabled}
        placeholder={t('study.searchPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="study-search__go" disabled={disabled || !value.trim()}>
        {t('study.searchButton')}
      </button>
    </form>
  );
}
