/**
 * 拉取模型列表弹窗。
 *
 * 规则：
 * - 首次拉取时若白名单为空 → 默认全选；已有白名单 → 保留原勾选，新增项默认不勾选。
 * - 再次拉取（重新拉取）保留当前勾选；此前勾选但服务端不再返回的 model 仍保留并标记「已下线」。
 * - 支持搜索、全选 / 清空、手动添加（回车加入）、取消与确认。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LLMSettings } from '../../types';
import type { ModelInfo } from '../../lib/llm';
import { fetchModels } from '../../lib/llm';
import { cx } from '../../lib/utils';
import { IconRefresh, IconSearch } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { buildModelRows, type ModelRow } from './modelRows';

export interface ModelListDialogProps {
  open: boolean;
  /** 用表单当前值构造的设置，用于拉取列表。 */
  settings: LLMSettings;
  /** 当前白名单（再次拉取时作为初始勾选）。 */
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
  /** 本次弹窗会话里服务端返回过的所有 model id（用于重新拉取后保留已勾选的下架项）。 */
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
          // 首次拉取且白名单为空时默认全选；但保留用户在加载期间手动添加的项。
          setSelection((current) =>
            current.length > 0 ? current : models.map((model) => model.id),
          );
        }
        loadedOnceRef.current = true;
      }
    } catch (error) {
      if (token !== openSeqRef.current) return;
      setWarning(
        error instanceof Error ? error.message : '拉取模型列表失败，请检查 Base URL 与网络。',
      );
    } finally {
      if (token === openSeqRef.current) setLoading(false);
    }
  }

  // 每次打开弹窗都重新拉取一次；settings / selected 通过 ref 读取当前值。
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
    // 只在 open 变化时重置；其余字段从 ref 读取最新值。
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
      title="拉取模型列表"
      subtitle="勾选要保留在配置里的模型；已下线的模型不会再被默认选中。"
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={confirm} disabled={loading}>
            确认（{selection.length}）
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
              placeholder="搜索模型 id"
              aria-label="搜索模型"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="model-dialog__tools">
            <span className="model-dialog__count">
              已选 {selection.length} / 共 {merged.length}
            </span>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={selectAllVisible}
              disabled={filtered.length === 0}
            >
              全选
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={clearVisible}
              disabled={selection.length === 0}
            >
              清空
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={refetch}
              disabled={loading}
            >
              <IconRefresh size={13} /> 重新拉取
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
            placeholder="手动添加模型 id，例如 my-model"
            aria-label="手动添加模型"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={addManual}
            disabled={!manualInput.trim()}
          >
            添加
          </button>
        </div>
        <p className="hint">输入后按回车即可加入；默认 model 也可以不在白名单中。</p>

        {loading ? (
          <div className="model-dialog__status">
            <span className="spinner" aria-hidden="true" /> 正在向服务商拉取模型列表…
          </div>
        ) : (
          <>
            {warning && (
              <div className="callout callout--warn model-dialog__warning">
                <div>
                  <p className="callout__title">未能完整拉取模型列表</p>
                  <p>{warning}</p>
                </div>
              </div>
            )}

            {filtered.length === 0 ? (
              <div className="empty-state model-dialog__empty">
                <span className="empty-state__mark" aria-hidden="true">
                  录
                </span>
                <p className="empty-state__title">
                  {merged.length === 0 ? '没有可勾选的模型' : '没有匹配的模型'}
                </p>
                <p className="empty-state__desc">
                  {merged.length === 0
                    ? '服务没有返回模型列表，可以直接在上面的输入框手动添加模型 id。'
                    : '换个关键词，或清空搜索再看全部。'}
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
                          aria-label={`保留模型 ${row.model.id}`}
                        />
                        <span className="model-row__text">
                          <span className="model-row__id">{row.model.id}</span>
                          {row.model.displayName && (
                            <span className="model-row__name">{row.model.displayName}</span>
                          )}
                        </span>
                        <span className="model-row__tags">
                          {row.origin === 'legacy' && (
                            <span className="badge badge--gold">已下线</span>
                          )}
                          {row.origin === 'manual' && (
                            <span className="badge badge--outline">手动添加</span>
                          )}
                          {row.origin === 'fetched' &&
                            isRetiredLifecycle(row.model.lifecycle) && (
                              <span className="badge badge--gold">已下线</span>
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
