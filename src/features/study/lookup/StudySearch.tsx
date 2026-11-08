/**
 * 答题过程中顶部搜索：随时查词 / 翻译。
 */

import { useState } from 'react';
import { IconSearch } from '@/ui/icons';

export interface StudySearchProps {
  disabled?: boolean;
  onSearch: (query: string) => void;
}

export default function StudySearch({ disabled, onSearch }: StudySearchProps) {
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
      aria-label="学习中搜索"
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
        placeholder="搜索单词、翻译…"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="study-search__go" disabled={disabled || !value.trim()}>
        查
      </button>
    </form>
  );
}
