import { useEffect, useMemo, useRef, useState } from 'react';
import type { LLMSettings } from '@/domain/types';
import type { ModelInfo } from '@/infra/llm';
import { fetchModels } from '@/infra/llm';
import { cx } from '@/domain/utils';
import { useT } from '@/i18n';
import { IconRefresh, IconSearch } from '@/ui/icons';
import { Modal } from '@/ui/Modal';
import { buildModelRows, type ModelRow } from './modelRows';

export interface ModelListDialogProps {
  open: boolean;
  settings: LLMSettings;
  selected: string[];
  onClose: () => void;
  onConfirm: (models: string[]) => void;
}

function isRetiredLifecycle(lifecycle: string | undefined): boolean {
  return lifecycle === 'deprecated' || lifecycle === 'retired';
}

export default function ModelListDialog({
  open,
  settings,
  selected,
  onClose,
  onConfirm,
}: ModelListDialogProps) {
  const t = useT();
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState('');
  const [fetched, setFetched] = useState<ModelInfo[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [manualInput, setManualInput] = useState('');

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const initialSelectedRef = useRef<string[]>([]);
  const seenFetchedIdsRef = useRef<string[]>([]);
  const loadedOnceRef = useRef(false);
  const openSeqRef = useRef(0);

  async function loadModels(token: number) {
    setLoading(true);
    try {
      const result = await fetchModels(settingsRef.current);
      if (token !== openSeqRef.current) return;
      const models = Array.isArray(result.models) ? result.models : [];
      for (const model of models) {
        if (!seenFetchedIdsRef.current.includes(model.id)) {
          seenFetchedIdsRef.current.push(model.id);
        }
      }
      setFetched(models);
      setWarning(result.warning ?? '');
      if (!loadedOnceRef.current) {
        const previous = initialSelectedRef.current.filter(Boolean);
        if (previous.length > 0) {
          setSelection(previous);
        } else {
          setSelection((current) =>
            current.length > 0 ? current : models.map((model) => model.id),
          );
        }
        loadedOnceRef.current = true;
      }
    } catch (error) {
      if (token !== openSeqRef.current) return;
      setWarning(
        error instanceof Error ? error.message : t('providers.modelDialogFetchFailed'),
      );
    } finally {
      if (token === openSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const token = openSeqRef.current + 1;
    openSeqRef.current = token;
    initialSelectedRef.current = [...selected];
    seenFetchedIdsRef.current = [];
    loadedOnceRef.current = false;
    setFetched([]);
    setWarning('');
    setSelection([...selected]);
    setManualIds([]);
    setQuery('');
    setManualInput('');
    void loadModels(token);
    return () => {
      openSeqRef.current += 1;
    };
  }, [open]);

  function refetch() {
    if (loading) return;
    const token = openSeqRef.current + 1;
    openSeqRef.current = token;
    setWarning('');
    void loadModels(token);
  }

  const merged = useMemo<ModelRow[]>(
    () =>
      buildModelRows({
        fetched,
        initialSelected: initialSelectedRef.current,
        seenFetched: seenFetchedIdsRef.current,
        manualIds,
        selection,
      }),
    [fetched, manualIds, selection],
  );

  const selectedSet = useMemo(() => new Set(selection), [selection]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return merged;
    return merged.filter(
      (row) =>
        row.model.id.toLowerCase().includes(keyword) ||
        (row.model.displayName ?? '').toLowerCase().includes(keyword),
    );
  }, [merged, query]);

  function toggleModel(id: string) {
    setSelection((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function selectAllVisible() {
    const visibleIds = filtered.map((row) => row.model.id);
    setSelection((current) => Array.from(new Set([...current, ...visibleIds])));
  }

  function clearVisible() {
    const visibleIds = new Set(filtered.map((row) => row.model.id));
    setSelection((current) => current.filter((id) => !visibleIds.has(id)));
  }

  function addManual() {
    const id = manualInput.trim();
    if (!id) return;
    if (!merged.some((row) => row.model.id === id)) {
      setManualIds((current) => (current.includes(id) ? current : [...current, id]));
    }
    setSelection((current) => (current.includes(id) ? current : [...current, id]));
    setManualInput('');
  }

  function confirm() {
    const ordered = merged
      .filter((row) => selectedSet.has(row.model.id))
      .map((row) => row.model.id);
    onConfirm(ordered);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('providers.modelDialogTitle')}
      subtitle={t('providers.modelDialogSub')}
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn--primary" onClick={confirm} disabled={loading}>
            {t('providers.modelDialogConfirm', { count: selection.length })}
          </button>
        </>
      }
    >
      <div className="model-dialog">
        <div className="model-dialog__toolbar">
          <div className="model-dialog__search">
            <IconSearch size={15} />
            <input
              className="input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('providers.modelDialogSearchPlaceholder')}
              aria-label={t('providers.modelDialogSearchAria')}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="model-dialog__tools">
            <span className="model-dialog__count">
              {t('providers.modelDialogSelectedCount', {
                selected: selection.length,
                total: merged.length,
              })}
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={selectAllVisible}
              disabled={filtered.length === 0}
            >
              {t('providers.modelDialogSelectAll')}
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={clearVisible}
              disabled={selection.length === 0}
            >
              {t('providers.modelDialogClear')}
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={refetch}
              disabled={loading}
            >
              <IconRefresh size={13} /> {t('providers.modelDialogRefetch')}
            </button>
          </div>
        </div>

        <div className="model-dialog__manual">
          <input
            className="input"
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addManual();
            }}
            placeholder={t('providers.modelDialogManualPlaceholder')}
            aria-label={t('providers.modelDialogManualAria')}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addManual}
            disabled={!manualInput.trim()}
          >
            {t('providers.modelDialogManualAdd')}
          </button>
        </div>
        <p className="hint">{t('providers.modelDialogManualHint')}</p>

        {loading ? (
          <div className="model-dialog__status">
            <span className="spinner" aria-hidden="true" /> {t('providers.modelDialogLoading')}
          </div>
        ) : (
          <>
            {warning && (
              <div className="callout callout--warn model-dialog__warning">
                <div>
                  <p className="callout__title">{t('providers.modelDialogWarnTitle')}</p>
                  <p>{warning}</p>
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              <div className="empty-state model-dialog__empty">
                <span className="empty-state__mark" aria-hidden="true">
                  {t('providers.modelDialogEmptyMark')}
                </span>
                <p className="empty-state__title">
                  {merged.length === 0
                    ? t('providers.modelDialogEmptyNone')
                    : t('providers.modelDialogEmptyNoMatch')}
                </p>
                <p className="empty-state__desc">
                  {merged.length === 0
                    ? t('providers.modelDialogEmptyNoneDesc')
                    : t('providers.modelDialogEmptyNoMatchDesc')}
                </p>
              </div>
            ) : (
              <ul className="model-list">
                {filtered.map((row) => {
                  const checked = selectedSet.has(row.model.id);
                  return (
                    <li key={row.model.id}>
                      <label className={cx('model-row', checked && 'is-selected')}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleModel(row.model.id)}
                          aria-label={t('providers.modelDialogKeepAria', { id: row.model.id })}
                        />
                        <span className="model-row__text">
                          <span className="model-row__id">{row.model.id}</span>
                          {row.model.displayName && (
                            <span className="model-row__name">{row.model.displayName}</span>
                          )}
                        </span>
                        <span className="model-row__tags">
                          {row.origin === 'legacy' && (
                            <span className="badge badge--gold">
                              {t('providers.modelDialogRetired')}
                            </span>
                          )}
                          {row.origin === 'manual' && (
                            <span className="badge badge--outline">
                              {t('providers.modelDialogManualBadge')}
                            </span>
                          )}
                          {row.origin === 'fetched' &&
                            isRetiredLifecycle(row.model.lifecycle) && (
                              <span className="badge badge--gold">
                                {t('providers.modelDialogRetired')}
                              </span>
                            )}
                          {row.model.maxTokens ? (
                            <span className="model-row__meta">≤ {row.model.maxTokens} tok</span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
