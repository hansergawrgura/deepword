import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/AppState';
import type { Word, WordInput } from '../types';
import { getWordProgressList, type WordProgress } from '../lib/stats';
import { SRS_STATUS_META } from '../lib/srs';
import { relativeDue, truncate } from '../lib/utils';
import { normalizeWord } from '../lib/storage';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';
import {
  IconDownload,
  IconEdit,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from './ui/icons';
import './Wordbook.css';

type FilterKey = 'all' | 'new' | 'learning' | 'review' | 'mastered' | 'mistakes';
type SortKey = 'recent' | 'alpha' | 'wrong' | 'due';

const PAGE_SIZE = 60;

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'new', label: '新词' },
  { key: 'learning', label: '学习中' },
  { key: 'review', label: '复习中' },
  { key: 'mastered', label: '已掌握' },
  { key: 'mistakes', label: '错词' },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'recent', label: '最近添加' },
  { key: 'alpha', label: '字母序' },
  { key: 'wrong', label: '错误最多' },
  { key: 'due', label: '最先到期' },
];

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
      setError('请填写单词');
      return;
    }
    if (!input.meaning) {
      setError('请填写中文释义');
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
      title={word ? '编辑词条' : '添加词条'}
      subtitle={word ? '修改只会影响这个词本身，学习记录会保留。' : '把一个新词收进你的词渊。'}
      size="wide"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={handleSubmit}>
            {word ? '保存修改' : '加入词库'}
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
            <span className="label">单词 *</span>
            <input
              className="input"
              value={form.term}
              onChange={(event) => setField('term', event.target.value)}
              placeholder="例如：serendipity"
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="label">音标</span>
            <input
              className="input"
              value={form.phonetic}
              onChange={(event) => setField('phonetic', event.target.value)}
              placeholder="例如：/ˌserənˈdɪpəti/"
              autoComplete="off"
            />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span className="label">词性</span>
            <input
              className="input"
              value={form.partOfSpeech}
              onChange={(event) => setField('partOfSpeech', event.target.value)}
              placeholder="例如：n. / v. / adj."
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="label">标签</span>
            <input
              className="input"
              value={form.tags}
              onChange={(event) => setField('tags', event.target.value)}
              placeholder="用逗号分隔，例如：CET-6，核心"
              autoComplete="off"
            />
          </label>
        </div>

        <label className="field">
          <span className="label">中文释义 *</span>
          <textarea
            className="textarea"
            value={form.meaning}
            onChange={(event) => setField('meaning', event.target.value)}
            placeholder="多个义项用「；」分隔"
            rows={2}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="label">英文例句</span>
            <textarea
              className="textarea"
              value={form.example}
              onChange={(event) => setField('example', event.target.value)}
              placeholder="包含该词的完整例句，AI 出题时会参考"
              rows={3}
            />
          </label>
          <label className="field">
            <span className="label">例句翻译</span>
            <textarea
              className="textarea"
              value={form.exampleTranslation}
              onChange={(event) => setField('exampleTranslation', event.target.value)}
              placeholder="例句的中文翻译"
              rows={3}
            />
          </label>
        </div>

        {error && <p className="field-error">{error}</p>}
        <button type="submit" className="sr-only" tabIndex={-1}>
          提交
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
  const { actions, data } = useApp();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const preview = useMemo(() => {
    if (!text.trim()) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { words?: unknown }).words)
          ? ((parsed as { words: unknown[] }).words ?? [])
          : null;
      if (!list) throw new Error('需要一个单词数组，或包含 words 数组的对象');
      const inputs: WordInput[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const normalized = normalizeWord(item as WordInput);
        if (normalized) inputs.push(normalized);
      }
      return { inputs, total: list.length };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'JSON 解析失败' };
    }
  }, [text]);

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
      setError('读取文件失败');
    }
  };

  const handleImport = () => {
    if (!preview || 'error' in preview) {
      setError(preview && 'error' in preview ? (preview.error ?? '格式不正确') : '请先粘贴或选择 JSON');
      return;
    }
    if (preview.inputs.length === 0) {
      setError('没有识别到有效的单词（至少需要 term 和 meaning 字段）');
      return;
    }
    const result = actions.importWords(preview.inputs);
    actions.toast(
      result.added > 0
        ? `已导入 ${result.added} 个单词${result.skipped > 0 ? `，跳过 ${result.skipped} 个` : ''}`
        : '没有新增单词（可能都已存在）',
      result.added > 0 ? 'success' : 'info',
    );
    if (result.added > 0) onClose();
  };

  const currentCount = data.words.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="导入词库"
      subtitle={`当前词库 ${currentCount} 个词。支持 JSON 数组，或包含 words 数组的对象。`}
      size="wide"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleImport}
            disabled={!preview || 'error' in preview || preview.inputs.length === 0}
          >
            导入 {preview && !('error' in preview) ? `${preview.inputs.length} 个` : ''}
          </button>
        </>
      }
    >
      <div className="word-import">
        <label className="word-import__file">
          <IconUpload size={16} />
          <span>{fileName || '选择 JSON 文件'}</span>
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
          <span className="label">或直接粘贴 JSON</span>
          <textarea
            className="textarea word-import__textarea"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            placeholder={`[
  {
    "term": "serendipity",
    "phonetic": "/ˌserənˈdɪpəti/",
    "partOfSpeech": "n.",
    "meaning": "意外发现美好事物的运气",
    "example": "Meeting her was pure serendipity.",
    "exampleTranslation": "遇见她纯属美好的巧合。",
    "tags": ["雅思", "核心"]
  }
]`}
            rows={10}
            spellCheck={false}
          />
        </label>

        {preview && 'error' in preview && <p className="field-error">格式错误：{preview.error}</p>}
        {preview && !('error' in preview) && (
          <div className="callout">
            <div>
              <span className="callout__title">识别到 {preview.inputs.length} 个有效单词</span>
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
                  有 {preview.total - preview.inputs.length} 条缺少必要字段会被忽略。
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p className="field-error">{error}</p>}

        <p className="hint">
          导入时会自动去重；已存在的单词不会覆盖。字段说明：term、meaning 必填，其余可选。
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
      if (item.card.status in result) result[item.card.status as FilterKey] += 1;
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
      if (filter !== 'all') return item.card.status === filter;
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
      case 'due':
        sorted.sort((a, b) => {
          const aNew = a.card.status === 'new' ? 1 : 0;
          const bNew = b.card.status === 'new' ? 1 : 0;
          if (aNew !== bNew) return aNew - bNew;
          return a.card.dueAt - b.card.dueAt;
        });
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
    downloadJson(`deepword-wordlist-${new Date().toISOString().slice(0, 10)}.json`, {
      app: 'deepword',
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
    actions.toast(`已导出 ${data.words.length} 个单词`, 'success');
  };

  return (
    <div className="wordbook">
      <header className="view-head">
        <div>
          <div className="view-head__eyebrow">
            <span className="mono-label">WORDBOOK</span>
            <span className="badge badge--outline">{data.words.length} 个词条</span>
          </div>
          <h1 className="view-title">我的词库</h1>
          <p className="view-sub">
            这里是你与单词相遇的地方。共 {data.words.length} 个词条，其中 {learned} 个已开始学习，
            {counts.mistakes} 个曾在作答中失手。
          </p>
        </div>
        <div className="view-actions">
          <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(true)}>
            <IconUpload size={15} />
            导入
          </button>
          <button type="button" className="btn btn--ghost" onClick={handleExport}>
            <IconDownload size={15} />
            导出词库
          </button>
          <button type="button" className="btn btn--primary" onClick={openCreate}>
            <IconPlus size={15} />
            添加单词
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
            placeholder="搜索单词、释义或标签…"
            aria-label="搜索词库"
          />
          {search && (
            <button
              type="button"
              className="wordbook-search__clear"
              onClick={() => setSearch('')}
              aria-label="清空搜索"
            >
              ×
            </button>
          )}
        </div>

        <div className="wordbook-filters" role="group" aria-label="按学习状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? 'chip chip--active' : 'chip'}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
              <span className="wordbook-filters__count">{counts[item.key]}</span>
            </button>
          ))}
        </div>

        <label className="wordbook-sort">
          <span className="sr-only">排序方式</span>
          <select className="select" value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {SORTS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data.words.length === 0 ? (
        <div className="card empty-state wordbook-empty">
          <span className="empty-state__mark">词</span>
          <h2 className="empty-state__title">词库还是空的</h2>
          <p className="empty-state__desc">
            添加第一个单词，或者导入一份自己的词表。学习记录会从你第一次翻开它开始。
          </p>
          <div className="view-actions">
            <button type="button" className="btn btn--primary" onClick={openCreate}>
              <IconPlus size={15} />
              添加单词
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setImportOpen(true)}>
              <IconUpload size={15} />
              导入词库
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card empty-state wordbook-empty">
          <span className="empty-state__mark">寻</span>
          <h2 className="empty-state__title">没有找到匹配的词</h2>
          <p className="empty-state__desc">
            {hasFilters ? '换一个关键词或筛选条件试试。' : '词库中暂时没有内容。'}
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
              清除筛选
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="wordbook-table" role="table" aria-label="词库列表">
            <div className="wordbook-table__head" role="row">
              <span role="columnheader">词条</span>
              <span role="columnheader">释义</span>
              <span role="columnheader">状态</span>
              <span role="columnheader">复习</span>
              <span role="columnheader">错误</span>
              <span role="columnheader" aria-label="操作" />
            </div>

            {shown.map(({ word, card, wrongCount, due }: WordProgress) => {
              const status = SRS_STATUS_META[card.status];
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
                          status.tone === 'muted'
                            ? 'badge'
                            : `badge badge--${status.tone} badge--dot`
                        }
                      >
                        {status.label}
                      </span>
                    </div>

                    <div className="wordbook-row__due" role="cell">
                      {card.status === 'new'
                        ? '未开始'
                        : due
                          ? '已到期'
                          : relativeDue(card.dueAt)}
                    </div>

                    <div className="wordbook-row__wrong" role="cell">
                      {wrongCount > 0 ? (
                        <span className="badge badge--vermilion">错 {wrongCount}</span>
                      ) : (
                        <span className="u-muted">—</span>
                      )}
                    </div>
                  </div>

                  <div className="wordbook-row__actions" role="cell">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`编辑 ${word.term}`}
                      onClick={() => openEdit(word)}
                    >
                      <IconEdit size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn wordbook-row__delete"
                      aria-label={`删除 ${word.term}`}
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
              显示 {shown.length} / {filtered.length} 个词条
              {hasFilters ? `（共 ${data.words.length} 个）` : ''}
            </span>
            {visible < filtered.length && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => setVisible((current) => current + PAGE_SIZE)}
              >
                加载更多
              </button>
            )}
          </div>
        </>
      )}

      <WordEditor open={editorOpen} word={editingWord} onClose={() => setEditorOpen(false)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除这个单词？"
        message={
          <>
            将从词库中移除「<strong>{deleting?.term}</strong>」，同时清除它的学习卡片、错题记录与作答历史。
            此操作不可撤销。
          </>
        }
        confirmLabel="删除"
        danger
        onClose={() => setDeleting(undefined)}
        onConfirm={() => {
          if (deleting) actions.deleteWord(deleting.id);
        }}
      />
    </div>
  );
}
