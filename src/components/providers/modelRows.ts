/**
 * 模型列表弹窗的行合并逻辑（纯函数，便于单测）。
 *
 * 规则：
 * - fetched = 本次服务端返回；
 * - 原白名单里但本次未返回的 model 标 legacy（界面显示「已下线」）；
 * - 本次会话里出现过、后来又消失、但**仍勾选**的 model 也标 legacy；
 *   未勾选的历史 model 不保留，避免把用户没要的 model 标成已下线；
 * - 手动添加的标 manual。
 */

import type { ModelInfo } from '../../lib/llm';

export interface ModelRow {
  model: ModelInfo;
  /** fetched = 服务端返回；legacy = 旧白名单/已下线；manual = 手动添加。 */
  origin: 'fetched' | 'legacy' | 'manual';
}

export interface BuildModelRowsInput {
  fetched: ModelInfo[];
  /** 打开弹窗时的白名单（再次拉取时作为初始勾选）。 */
  initialSelected: readonly string[];
  /** 本次弹窗会话里服务端返回过的所有 model id。 */
  seenFetched: readonly string[];
  /** 手动添加的 model id。 */
  manualIds: readonly string[];
  /** 当前勾选状态。 */
  selection: readonly string[];
}

export function buildModelRows(input: BuildModelRowsInput): ModelRow[] {
  const fetchedIds = new Set(input.fetched.map((model) => model.id));
  const rows: ModelRow[] = input.fetched.map((model) => ({ model, origin: 'fetched' }));
  const added = new Set<string>();

  for (const id of input.initialSelected) {
    if (fetchedIds.has(id) || added.has(id)) continue;
    added.add(id);
    rows.push({ model: { id }, origin: 'legacy' });
  }

  const selectedIds = new Set(input.selection);
  for (const id of input.seenFetched) {
    if (fetchedIds.has(id) || added.has(id) || !selectedIds.has(id)) continue;
    added.add(id);
    rows.push({ model: { id }, origin: 'legacy' });
  }

  for (const id of input.manualIds) {
    if (fetchedIds.has(id) || added.has(id)) continue;
    added.add(id);
    rows.push({ model: { id }, origin: 'manual' });
  }

  return rows;
}
