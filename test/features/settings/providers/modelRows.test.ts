/**
 * 模型列表弹窗行合并逻辑单测（Phase A P2 回归）。
 */

import { describe, expect, it } from 'vitest';
import { buildModelRows } from './modelRows';
import type { ModelInfo } from '@/infra/llm';

const model = (id: string, lifecycle?: string): ModelInfo => ({ id, lifecycle });

describe('buildModelRows', () => {
  it('首次拉取：全部 fetched，按服务端顺序', () => {
    const rows = buildModelRows({
      fetched: [model('a'), model('b'), model('c')],
      initialSelected: [],
      seenFetched: ['a', 'b', 'c'],
      manualIds: [],
      selection: ['a', 'b', 'c'],
    });
    expect(rows.map((row) => [row.model.id, row.origin])).toEqual([
      ['a', 'fetched'],
      ['b', 'fetched'],
      ['c', 'fetched'],
    ]);
  });

  it('再次拉取：消失但仍在白名单的项保留为 legacy（已下线）', () => {
    const rows = buildModelRows({
      fetched: [model('a')],
      initialSelected: ['a', 'b'],
      seenFetched: ['a', 'b'],
      manualIds: [],
      selection: ['a', 'b'],
    });
    expect(rows).toContainEqual({ model: { id: 'b' }, origin: 'legacy' });
    expect(rows.find((row) => row.model.id === 'a')?.origin).toBe('fetched');
  });

  it('P2 回归：本次会话出现过、后来消失、且未勾选的历史项不保留', () => {
    const rows = buildModelRows({
      fetched: [model('a'), model('c')],
      initialSelected: ['a'],
      seenFetched: ['a', 'b', 'c'],
      manualIds: [],
      selection: ['a', 'c'],
    });
    expect(rows.map((row) => row.model.id)).toEqual(['a', 'c']);
    expect(rows.some((row) => row.model.id === 'b')).toBe(false);
  });

  it('P2 回归：本次会话出现过、后来消失、但已勾选的项仍保留为 legacy', () => {
    const rows = buildModelRows({
      fetched: [model('a')],
      initialSelected: ['a'],
      seenFetched: ['a', 'c'],
      manualIds: [],
      selection: ['a', 'c'],
    });
    expect(rows).toContainEqual({ model: { id: 'c' }, origin: 'legacy' });
  });

  it('手动添加的项标 manual，且不与已存在项重复', () => {
    const rows = buildModelRows({
      fetched: [model('a')],
      initialSelected: ['a'],
      seenFetched: ['a'],
      manualIds: ['a', 'custom-1', 'b'],
      selection: ['a', 'custom-1', 'b'],
    });
    expect(rows.map((row) => [row.model.id, row.origin])).toEqual([
      ['a', 'fetched'],
      ['custom-1', 'manual'],
      ['b', 'manual'],
    ]);
  });

  it('下发 lifecycle 下架的 fetched 项仍标 fetched（由界面按 lifecycle 显示已下线）', () => {
    const rows = buildModelRows({
      fetched: [model('a', 'retired'), model('b')],
      initialSelected: ['a', 'b'],
      seenFetched: ['a', 'b'],
      manualIds: [],
      selection: ['a', 'b'],
    });
    expect(rows.every((row) => row.origin === 'fetched')).toBe(true);
  });
});
