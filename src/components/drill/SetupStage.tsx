/**
 * 第一阶段：选词与命题设定。
 *
 * 左侧是一张「错处清单」纸，右侧是题量 / 难度 / 出题引擎与主按钮。
 */

import type { DifficultyPreference, LLMSettings, ViewId } from '@/types';
import type { WordProgress } from '@/lib/stats';
import { cx, relativeTime } from '@/lib/utils';
import {
  COUNT_OPTIONS,
  DIFFICULTY_LABEL,
  DIFFICULTY_OPTIONS,
  providerLabel,
} from './meta';
import type { DrillMode } from './types';

interface SetupStageProps {
  /** 候选单词：优先错词；无错题时可换成随机抽词。 */
  pool: WordProgress[];
  selectedIds: string[];
  count: number;
  difficulty: DifficultyPreference;
  settings: LLMSettings;
  llmReady: boolean;
  /** 远端接口缺 API Key 时给出金色提示。 */
  missingKey: boolean;
  /** 当前 pool 是否来自「随机抽词」。 */
  fallbackActive: boolean;
  hasWords: boolean;
  onToggleWord: (wordId: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onRandomPick: () => void;
  onCountChange: (count: number) => void;
  onDifficultyChange: (difficulty: DifficultyPreference) => void;
  onStart: (mode: DrillMode) => void;
  onNavigate: (view: ViewId) => void;
}

export default function SetupStage({
  pool,
  selectedIds,
  count,
  difficulty,
  settings,
  llmReady,
  missingKey,
  fallbackActive,
  hasWords,
  onToggleWord,
  onSelectAll,
  onClearSelection,
  onRandomPick,
  onCountChange,
  onDifficultyChange,
  onStart,
  onNavigate,
}: SetupStageProps) {
  const selected = new Set(selectedIds);
  const selectedCount = pool.filter((item) => selected.has(item.word.id)).length;
  const description =
    DIFFICULTY_OPTIONS.find((option) => option.value === difficulty)?.description ?? '';

  return (
    <div className="drill-setup">
      <section className="drill-sheet" aria-labelledby="drill-sheet-title">
        <header className="drill-sheet__head">
          <div className="drill-sheet__intro">
            <p className="mono-label">
              {fallbackActive ? 'WORDBANK / 词库抽词' : 'MISTAKES / 错处'}
            </p>
            <h2 className="drill-sheet__title" id="drill-sheet-title">
              {fallbackActive ? '这轮抽到的词' : '待命题的错词'}
            </h2>
            <p className="drill-sheet__sub">
              {!hasWords
                ? '先去词库添加或导入单词，再来特训。'
                : pool.length === 0
                  ? '答错的词会自动聚拢到这里；也可以先从词库随机抽几个词热身。'
                  : fallbackActive
                    ? '还没有错题，先从词库随机抽了几个词热身。可以重新抽一批。'
                    : '按错误次数与最近出错时间排序，默认勾选前 8 个。'}
            </p>
          </div>
          {pool.length > 0 && (
            <div className="drill-sheet__tools">
              <span className="drill-sheet__count">
                已选 <b>{selectedCount}</b> / {pool.length}
              </span>
              <button type="button" className="btn btn--quiet btn--sm" onClick={onSelectAll}>
                全选
              </button>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={onClearSelection}
                disabled={selectedCount === 0}
              >
                清空
              </button>
              {fallbackActive && (
                <button type="button" className="btn btn--quiet btn--sm" onClick={onRandomPick}>
                  重新抽一批
                </button>
              )}
            </div>
          )}
        </header>

        {!hasWords ? (
          <div className="empty-state drill-empty">
            <span className="empty-state__mark" aria-hidden="true">
              空
            </span>
            <p className="empty-state__title">词库还是空的</p>
            <p className="empty-state__desc">
              先去词库添加或导入一批单词，再来让大模型针对错词命题。
            </p>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onNavigate('wordbook')}
            >
              去词库
            </button>
          </div>
        ) : pool.length === 0 ? (
          <div className="empty-state drill-empty">
            <span className="empty-state__mark" aria-hidden="true">
              净
            </span>
            <p className="empty-state__title">还没有错题</p>
            <p className="empty-state__desc">
              闪卡与练习里答错的词会在这里聚拢。也可以先从词库随机抽 8 个词，来一轮热身。
            </p>
            <div className="drill-empty__actions">
              <button type="button" className="btn btn--primary" onClick={onRandomPick}>
                随机从词库选词
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => onNavigate('study')}
              >
                去闪卡复习
              </button>
            </div>
          </div>
        ) : (
          <ul className="drill-words">
            {pool.map((item) => {
              const isSelected = selected.has(item.word.id);
              const recentSample = Math.min(10, item.attempts);
              return (
                <li key={item.word.id}>
                  <button
                    type="button"
                    className={cx('drill-word', isSelected && 'is-selected')}
                    aria-pressed={isSelected}
                    onClick={() => onToggleWord(item.word.id)}
                  >
                    <span className="drill-word__check" aria-hidden="true" />
                    <span className="drill-word__main">
                      <span className="drill-word__line">
                        <span className="drill-word__term">{item.word.term}</span>
                        {item.word.phonetic && (
                          <span className="drill-word__phonetic">{item.word.phonetic}</span>
                        )}
                        {item.correctStreak >= 2 && (
                          <span className="badge badge--sage badge--dot drill-word__badge">
                            已连续答对 {item.correctStreak} 次
                          </span>
                        )}
                      </span>
                      <span className="drill-word__meaning">{item.word.meaning}</span>
                    </span>
                    <span className="drill-word__meta">
                      {item.wrongCount > 0 ? (
                        <span className="drill-word__wrong">错 {item.wrongCount} 次</span>
                      ) : (
                        <span>{item.attempts > 0 ? `练过 ${item.attempts} 次` : '尚未练习'}</span>
                      )}
                      {item.mistake && (
                        <span>上次答错 {relativeTime(item.mistake.lastWrongAt)}</span>
                      )}
                      {item.accuracy !== null && recentSample > 0 && (
                        <span>
                          近 {recentSample} 次答对 {item.accuracy}%
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside className="drill-aside">
        <div className="drill-aside__panel">
          <div className="drill-aside__head">
            <p className="mono-label">SETUP / 命题设定</p>
            <h2 className="drill-aside__title">这一卷怎么出</h2>
          </div>

          <div className="drill-set">
            <div className="drill-set__field">
              <div className="drill-set__label">
                <span>题量</span>
                <span className="drill-set__value">{count} 题</span>
              </div>
              <div className="segmented drill-seg" role="group" aria-label="题量">
                {COUNT_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={cx(
                      'segmented__option',
                      option === count && 'segmented__option--active',
                    )}
                    aria-pressed={option === count}
                    onClick={() => onCountChange(option)}
                  >
                    {option} 题
                  </button>
                ))}
              </div>
            </div>

            <div className="drill-set__field">
              <div className="drill-set__label">
                <span>难度</span>
                <span className="drill-set__value">{DIFFICULTY_LABEL[difficulty]}</span>
              </div>
              <div className="segmented drill-seg" role="group" aria-label="难度">
                {DIFFICULTY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={cx(
                      'segmented__option',
                      option.value === difficulty && 'segmented__option--active',
                    )}
                    aria-pressed={option.value === difficulty}
                    onClick={() => onDifficultyChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="hint drill-set__desc">{description}</p>
            </div>
          </div>

          <div className="drill-engine">
            <div className="drill-engine__head">
              <span className="mono-label">ENGINE / 出题引擎</span>
              <span
                className={cx(
                  'badge',
                  'badge--dot',
                  llmReady ? 'badge--sage' : 'badge--gold',
                )}
              >
                {llmReady ? '大模型' : '本地题库'}
              </span>
            </div>

            {llmReady ? (
              <>
                <dl className="drill-engine__meta">
                  <div>
                    <dt>接口</dt>
                    <dd>{providerLabel(settings)}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd className="drill-engine__model">{settings.model}</dd>
                  </div>
                </dl>
                <p className="hint">将调用大模型，针对所选错词与错因命题。</p>
                {missingKey && (
                  <div className="callout callout--warn drill-callout">
                    <p className="callout__title">接口还缺 API Key</p>
                    <p>远端接口通常需要 Key 才能调用；也可以先改用本地题库。</p>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onNavigate('settings')}
                    >
                      前往设置
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn--quiet btn--sm drill-engine__link"
                  onClick={() => onNavigate('settings')}
                >
                  调整接口与模型
                </button>
              </>
            ) : (
              <div className="callout callout--warn drill-callout">
                <p className="callout__title">未配置可用接口</p>
                <p>将使用本地题库出题：由词库与错词记录直接生成，不联网。</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => onNavigate('settings')}
                >
                  前往设置
                </button>
              </div>
            )}
          </div>

          <div className="drill-cta">
            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              disabled={selectedCount === 0}
              onClick={() => onStart(llmReady ? 'llm' : 'local')}
            >
              {llmReady ? '生成针对性练习' : '使用本地题库出题'}
            </button>
            {llmReady && (
              <button
                type="button"
                className="btn btn--quiet btn--block"
                disabled={selectedCount === 0}
                onClick={() => onStart('local')}
              >
                不用大模型，改用本地题库
              </button>
            )}
            <p className="hint drill-cta__hint">
              {selectedCount === 0
                ? '先勾选至少一个要特训的词。'
                : `已选 ${selectedCount} 个词，目标 ${count} 题（每个词最多 2 题，所选词少时实际题量会少一些）。`}
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
