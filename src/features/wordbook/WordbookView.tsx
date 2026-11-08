import { useEffect, useMemo, useState } from 'react';
import { BACKUP_APP, downloadWordlistName } from '@/app/identity';
import { useApp } from '@/app/store';
import { useLocale, useT } from '@/i18n';
import type { Word, WordInput } from '@/domain/types';
import { getWordProgressList, type WordProgress } from '@/domain/stats';
import { relativeTime, truncate } from '@/domain/utils';
import { Modal } from '@/ui/Modal';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import {
  IconDownload,
  IconEdit,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from '@/ui/icons';
import './Wordbook.css';

type FilterKey = 'all' | 'new' | 'learning' | 'review' | 'mastered' | 'mistakes';
type SortKey = 'recent' | 'alpha' | 'wrong' | 'activity';

const PAGE_SIZE = 60;

const FILTER_KEYS: FilterKey[] = ['all', 'new', 'learning', 'review', 'mastered', 'mistakes'];
const SORT_KEYS: SortKey[] = ['recent', 'alpha', 'wrong', 'activity'];

const FILTER_I18N: Record<FilterKey, string> = {
  all: 'wordbook.filterAll',
  new: 'wordbook.filterNew',
  learning: 'wordbook.filterLearning',
  review: 'wordbook.filterReview',
  mastered: 'wordbook.filterMastered',
  mistakes: 'wordbook.filterMistakes',
};

const STATUS_TONE: Record<'new' | 'learning' | 'review' | 'mastered', 'muted' | 'vermilion' | 'gold' | 'sage'> = {
  new: 'vermilion',
  learning: 'gold',
  review: 'sage',
  mastered: 'sage',
};

const SORT_I18N: Record<SortKey, string> = {
  recent: 'wordbook.sortRecent',
  alpha: 'wordbook.sortAlpha',
  wrong: 'wordbook.sortWrong',
  activity: 'wordbook.sortActivity',
};

interface WordFormState {
  term: string;
  phonetic: string;
  partOfSpeech: string;
  meaning: string;
  example: string;
  exampleTranslation: string;
  tags: string;
}

function formFromWord(word?: Word): WordFormState {
  return {
    term: word?.term ?? '',
    phonetic: word?.phonetic ?? '',
    partOfSpeech: word?.partOfSpeech ?? '',
    meaning: word?.meaning ?? '',
    example: word?.example ?? '',
    exampleTranslation: word?.exampleTranslation ?? '',
    tags: word?.tags.join('，') ?? '',
  };
}

function formToInput(form: WordFormState): WordInput {
  const tags = form.tags
    .split(/[,，;；\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  return {
    term: form.term.trim(),
    phonetic: form.phonetic.trim() || undefined,
    partOfSpeech: form.partOfSpeech.trim() || undefined,
    meaning: form.meaning.trim(),
    example: form.example.trim() || undefined,
    exampleTranslation: form.exampleTranslation.trim() || undefined,
    tags,
  };
}

interface WordEditorProps {
  open: boolean;
  word?: Word;
  onClose: () => void;
}

function WordEditor({ open, word, onClose }: WordEditorProps) {
  const t = useT();
  const { actions } = useApp();
  const [form, setForm] = useState<WordFormState>(() => formFromWord(word));
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(formFromWord(word));
      setError('');
    }
  }, [open, word]);

  const setField = (key: keyof WordFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = () => {
    const input = formToInput(form);
    if (!input.term) {
      setError(t('wordbook.validationTerm'));
      return;
    }
    if (!input.meaning) {
      setError(t('wordbook.validationMeaning'));
      return;
    }
    const result = word ? actions.updateWord(word.id, input) : actions.addWord(input);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={word ? t('wordbook.editorEdit') : t('wordbook.editorAdd')}
      subtitle={word ? t('wordbook.editorSubEdit') : t('wordbook.editorSubAdd')}
      size="wide"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" onClick={handleSubmit}>
            {word ? t('wordbook.saveEdit') : t('wordbook.addToWordbook')}
          </button>
        </>
      }
    >
      <form
        className="word-form"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <div className="field-row">
          <label className="field">
            <span className="label">{t('wordbook.fieldTerm')}</span>
            <input
              className="input"
              value={form.term}
              onChange={(event) => setField('term', event.target.value)}
              placeholder={t('wordbook.placeholderTerm')}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="label">{t('wordbook.fieldPhonetic')}</span>
            <input
              className="input"
              value={form.phonetic}
              onChange={(event) => setField('phonetic', event.target.value)}
              placeholder={t('wordbook.placeholderPhonetic')}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="label">{t('wordbook.fieldPos')}</span>
            <input
              className="input"
              value={form.partOfSpeech}
              onChange={(event) => setField('partOfSpeech', event.target.value)}
              placeholder={t('wordbook.placeholderPos')}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="label">{t('wordbook.fieldTags')}</span>
            <input
              className="input"
              value={form.tags}
              onChange={(event) => setField('tags', event.target.value)}
              placeholder={t('wordbook.placeholderTags')}
              autoComplete="off"
            />
          </label>
        </div>

        <label className="field">
          <span className="label">{t('wordbook.fieldMeaning')}</span>
          <textarea
            className="textarea"
            value={form.meaning}
            onChange={(event) => setField('meaning', event.target.value)}
            placeholder={t('wordbook.placeholderMeaning')}
            rows={2}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="label">{t('wordbook.fieldExample')}</span>
            <textarea
              className="textarea"
              value={form.example}
              onChange={(event) => setField('example', event.target.value)}
              placeholder={t('wordbook.placeholderExample')}
              rows={3}
            />
          </label>
          <label className="field">
            <span className="label">{t('wordbook.fieldExampleZh')}</span>
            <textarea
              className="textarea"
              value={form.exampleTranslation}
              onChange={(event) => setField('exampleTranslation', event.target.value)}
              placeholder={t('wordbook.placeholderExampleZh')}
              rows={3}
            />
          </label>
        </div>

        {error && <p className="field-error">{error}</p>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          {t('common.submit')}
        </button>
      </form>
    </Modal>
  );
}

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

function ImportDialog({ open, onClose }: ImportDialogProps) {
  const t = useT();
  const { actions, data } = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    const parsed = actions.parseWordsJson(text);
    if (!parsed.ok) return { error: parsed.error };
    return { inputs: parsed.inputs, total: parsed.total };
  }, [actions, text]);

  useEffect(() => {
    if (open) {
      setText('');
      setError('');
      setFileName('');
    }
  }, [open]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      setText(content);
      setFileName(file.name);
      setError('');
    } catch {
      setError(t('wordbook.errorFile'));
    }
  };

  const handleImport = () => {
    if (!preview || 'error' in preview) {
      setError(preview && 'error' in preview ? (preview.error ?? t('wordbook.errorFormat')) : t('wordbook.errorPaste'));
      return;
    }
    if (preview.inputs.length === 0) {
      setError(t('wordbook.errorNoValid'));
      return;
    }
    const result = actions.importWords(preview.inputs);
    actions.toast(
      result.added > 0
        ? t('wordbook.toastImported', { added: result.added, skippedSuffix: result.skipped > 0 ? t('wordbook.toastSkipped', { skipped: result.skipped }) : '' })
        : t('wordbook.toastNone'),
      result.added > 0 ? 'success' : 'info',
    );
    if (result.added > 0) onClose();
  };

  const currentCount = data.words.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('wordbook.importTitle')}
      subtitle={t('wordbook.importSubtitle', { count: currentCount })}
      size="wide"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleImport}
            disabled={!preview || 'error' in preview || preview.inputs.length === 0}
          >
            {t('wordbook.importButton', { count: preview && !('error' in preview) ? preview.inputs.length : 0 })}
          </button>
        </>
      }
    >
      <div className="word-import">
        <label className="word-import__file">
          <IconUpload size={16} />
          <span>{fileName || t('wordbook.pickJson')}</span>
          <input
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              void handleFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>

        <label className="field">
          <span className="label">{t('wordbook.pasteJson')}</span>
          <textarea
            className="textarea word-import__textarea"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            placeholder={t('wordbook.importJsonPlaceholder')}
            rows={10}
            spellCheck={false}
          />
        </label>

        {preview && 'error' in preview && <p className="field-error">{t('wordbook.formatError')}{preview.error}</p>}
        {preview && !('error' in preview) && (
          <div className="callout">
            <div>
              <span className="callout__title">{t('wordbook.previewValid', { count: preview.inputs.length })}</span>
              {preview.inputs.length > 0 && (
                <p className="word-import__preview">
                  {preview.inputs
                    .slice(0, 6)
                    .map((word) => word.term)
                    .join(' · ')}
                  {preview.inputs.length > 6 ? ' …' : ''}
                </p>
              )}
              {preview.total > preview.inputs.length && (
                <p className="word-import__preview">
                  {t('wordbook.previewSkipped', { count: preview.total - preview.inputs.length })}
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <p className="hint">
          {t('wordbook.importHint')}
        </p>
      </div>
    </Modal>
  );
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function WordbookView() {
  const t = useT();
  const locale = useLocale();
  const { data, actions } = useApp();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('recent');
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingWord, setEditingWord] = useState<Word | undefined>(undefined);
  const [deleting, setDeleting] = useState<Word | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);

  const progress = useMemo(() => getWordProgressList(data), [data]);

  const counts = useMemo(() => {
    const result: Record<FilterKey, number> = {
      all: progress.length,
      new: 0,
      learning: 0,
      review: 0,
      mastered: 0,
      mistakes: 0,
    };
    for (const item of progress) {
      if (item.status in result) result[item.status as FilterKey] += 1;
      if (item.wrongCount > 0) result.mistakes += 1;
    }
    return result;
  }, [progress]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = progress.filter((item) => {
      if (
        keyword &&
        ![item.word.term, item.word.meaning, ...item.word.tags]
          .join(' ')
          .toLowerCase()
          .includes(keyword)
      ) {
        return false;
      }
      if (filter === 'mistakes') return item.wrongCount > 0;
      if (filter !== 'all') return item.status === filter;
      return true;
    });
    const sorted = [...list];
    switch (sort) {
      case 'alpha':
        sorted.sort((a, b) => a.word.term.localeCompare(b.word.term, 'en'));
        break;
      case 'wrong':
        sorted.sort((a, b) => b.wrongCount - a.wrongCount || b.attempts - a.attempts);
        break;
      case 'activity':
        sorted.sort((a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0));
        break;
      case 'recent':
      default:
        sorted.sort((a, b) => b.word.createdAt - a.word.createdAt);
        break;
    }
    return sorted;
  }, [progress, search, filter, sort]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [search, filter, sort]);

  const shown = filtered.slice(0, visible);
  const hasFilters = search.trim() !== '' || filter !== 'all';
  const learned = counts.learning + counts.review + counts.mastered;

  const openCreate = () => {
    setEditingWord(undefined);
    setEditorOpen(true);
  };

  const openEdit = (word: Word) => {
    setEditingWord(word);
    setEditorOpen(true);
  };

  const handleExport = () => {
    downloadJson(downloadWordlistName(new Date().toISOString().slice(0, 10)), {
      app: BACKUP_APP,
      kind: 'wordlist',
      exportedAt: new Date().toISOString(),
      words: data.words.map(({ term, phonetic, partOfSpeech, meaning, example, exampleTranslation, tags }) => ({
        term,
        phonetic,
        partOfSpeech,
        meaning,
        example,
        exampleTranslation,
        tags,
      })),
    });
    actions.toast(t('wordbook.toastExported', { count: data.words.length }), 'success');
  };

  return (
    <div className="wordbook">
      <header className="view-head">
        <div>
          <div className="view-head__eyebrow">
            <span className="mono-label">WORDBOOK</span>
            <span className="badge badge--outline">{t('wordbook.badgeCount', { count: data.words.length })}</span>
          </div>
          <h1 className="view-title">{t('wordbook.title')}</h1>
          <p className="view-sub">
{t('wordbook.subtitle', { total: data.words.length, learned, mistakes: counts.mistakes })}
          </p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(true)}>
            <IconUpload size={15} />
            {t('wordbook.import')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={handleExport}>
            <IconDownload size={15} />
            {t('wordbook.export')}
          </button>
          <button type="button" className="btn btn--primary" onClick={openCreate}>
            <IconPlus size={15} />
            {t('wordbook.add')}
          </button>
        </div>
      </header>

      <div className="wordbook-toolbar">
        <div className="wordbook-search">
          <IconSearch size={16} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('wordbook.searchPlaceholder')}
            aria-label={t('wordbook.searchAria')}
          />
          {search && (
            <button
              type="button"
              className="wordbook-search__clear"
              onClick={() => setSearch('')}
              aria-label={t('wordbook.clearSearch')}
            >
              ×
            </button>
          )}
        </div>

        <div className="wordbook-filters" role="group" aria-label={t('wordbook.filterAria')}>
          {FILTER_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={filter === key ? 'chip chip--active' : 'chip'}
              onClick={() => setFilter(key)}
            >
              {t(FILTER_I18N[key])}
              <span className="wordbook-filters__count">{counts[key]}</span>
            </button>
          ))}
        </div>

        <label className="wordbook-sort">
          <span className="sr-only">{t('wordbook.sortLabel')}</span>
          <select className="select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {t(SORT_I18N[key])}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.words.length === 0 ? (
        <div className="card empty-state wordbook-empty">
          <span className="empty-state__mark">{t('common.emptyMark')}</span>
          <h2 className="empty-state__title">{t('wordbook.empty')}</h2>
          <p className="empty-state__desc">
            {t('wordbook.emptyDesc')}
          </p>
          <div className="view-actions">
            <button type="button" className="btn btn--primary" onClick={openCreate}>
              <IconPlus size={15} />
              {t('wordbook.add')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(true)}>
              <IconUpload size={15} />
              {t('wordbook.import')}
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state wordbook-empty">
          <span className="empty-state__mark">…</span>
          <h2 className="empty-state__title">{t('wordbook.noMatch')}</h2>
          <p className="empty-state__desc">
            {hasFilters ? t('wordbook.noMatchFilter') : t('wordbook.noMatchEmpty')}
          </p>
          {hasFilters && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setSearch('');
                setFilter('all');
              }}
            >
              {t('wordbook.clearFilters')}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="wordbook-table" role="table" aria-label={t('wordbook.tableAria')}>
            <div className="wordbook-table__head" role="row">
              <span role="columnheader">{t('wordbook.colTerm')}</span>
              <span role="columnheader">{t('wordbook.colMeaning')}</span>
              <span role="columnheader">{t('wordbook.colStatus')}</span>
              <span role="columnheader">{t('wordbook.colRecent')}</span>
              <span role="columnheader">{t('wordbook.colWrong')}</span>
              <span role="columnheader" aria-label={t('common.actions')} />
            </div>

            {shown.map(({ word, status: learningStatus, wrongCount, lastAttemptAt }: WordProgress) => {
              const statusLabel = t(`domain.status.${learningStatus}`);
              const statusTone =
                learningStatus === 'mastered' ? 'muted' : STATUS_TONE[learningStatus];
              return (
                <div className="wordbook-row" role="row" key={word.id}>
                  <div className="wordbook-row__term" role="cell">
                    <strong>{word.term}</strong>
                    <span className="wordbook-row__meta">
                      {[word.phonetic, word.partOfSpeech].filter(Boolean).join(' · ') || '—'}
                    </span>
                    {word.tags.length > 0 && (
                      <span className="wordbook-row__tags">
                        {word.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="badge badge--outline">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>

                  <div className="wordbook-row__meaning" role="cell" title={word.meaning}>
                    {truncate(word.meaning, 60)}
                  </div>

                  <div className="wordbook-row__badges">
                    <div className="wordbook-row__status" role="cell">
                      <span
                        className={
                          statusTone === 'muted'
                            ? 'badge'
                            : `badge badge--${statusTone} badge--dot`
                        }
                      >
                        {statusLabel}
                      </span>
                    </div>

                    <div className="wordbook-row__due" role="cell">
                      {learningStatus === 'new' || !lastAttemptAt
                        ? t('wordbook.notStarted')
                        : relativeTime(lastAttemptAt, Date.now(), locale)}
                    </div>

                    <div className="wordbook-row__wrong" role="cell">
                      {wrongCount > 0 ? (
                        <span className="badge badge--vermilion">{t('dashboard.wrongCount', { count: wrongCount })}</span>
                      ) : (
                        <span className="u-muted">—</span>
                      )}
                    </div>
                  </div>

                  <div className="wordbook-row__actions" role="cell">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={t('wordbook.editAria', { term: word.term })}
                      onClick={() => openEdit(word)}
                    >
                      <IconEdit size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn wordbook-row__delete"
                      aria-label={t('wordbook.deleteAria', { term: word.term })}
                      onClick={() => setDeleting(word)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="wordbook-foot">
            <span>
              {t('wordbook.shown', { shown: shown.length, filtered: filtered.length, totalSuffix: '' })}
              {hasFilters ? t('wordbook.totalSuffix', { total: data.words.length }) : ''}
            </span>
            {visible < filtered.length && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setVisible((current) => current + PAGE_SIZE)}
              >
                {t('common.loadMore')}
              </button>
            )}
          </div>
        </>
      )}

      <WordEditor open={editorOpen} word={editingWord} onClose={() => setEditorOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        title={t('wordbook.deleteTitle')}
        message={t('wordbook.deleteMessage', { term: deleting?.term ?? '' })}
        confirmLabel={t('common.delete')}
        danger
        onClose={() => setDeleting(undefined)}
        onConfirm={() => {
          if (deleting) actions.deleteWord(deleting.id);
        }}
      />
    </div>
  );
}
