/**
 * 第二阶段：组卷中。
 *
 * 不是一颗孤零零的 spinner —— 左侧是「命题」朱印，右侧按 onProgress
 * 的阶段文案逐条落墨、列出正在读的错词，底部是流动的墨线进度与已用时间。
 */

import { cx } from '@/lib/utils';
import type { DrillMode } from './types';

interface GeneratingStageProps {
  mode: DrillMode;
  /** 最近一次 onProgress 文案。 */
  currentStage: string;
  /** 收到过的阶段文案（按时间顺序）。 */
  stageLog: string[];
  /** 正在被命题的错词词条，给等待一点具体感。 */
  words: string[];
  elapsedSeconds: number;
  selectedCount: number;
  count: number;
  difficultyLabel: string;
  onCancel: () => void;
}

export default function GeneratingStage({
  mode,
  currentStage,
  stageLog,
  words,
  elapsedSeconds,
  selectedCount,
  count,
  difficultyLabel,
  onCancel,
}: GeneratingStageProps) {
  const fallbackStage = mode === 'llm' ? '正在整理错词与错因…' : '正在从本地题库组卷…';
  const log = stageLog.length > 0 ? stageLog : [currentStage || fallbackStage];

  return (
    <section className="drill-generating" aria-live="polite" aria-busy="true">
      <div className="drill-draft">
        <div className="drill-draft__seal" aria-hidden="true">
          <span>命</span>
          <span>题</span>
        </div>
        <div className="drill-draft__main">
          <p className="mono-label">
            {mode === 'llm' ? 'DRAFTING / 大模型组卷' : 'DRAFTING / 本地组卷'}
          </p>
          <h2 className="drill-draft__title">正在为你命题</h2>

          <ol className="drill-draft__log">
            {log.map((item, index) => (
              <li key={`${item}-${index}`} className={cx(index === log.length - 1 && 'is-active')}>
                {item}
              </li>
            ))}
          </ol>

          <div className="drill-draft__bar" role="progressbar" aria-label="命题进度">
            <span />
          </div>

          {words.length > 0 && (
            <div className="drill-draft__words">
              <span className="mono-label">WORDS / 正在读</span>
              <ul>
                {words.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="drill-draft__foot">
            <p className="hint">
              {selectedCount} 个词，{count} 题，{difficultyLabel}，已用 {elapsedSeconds} 秒
            </p>
            <button type="button" className="btn btn--quiet btn--sm" onClick={onCancel}>
              取消命题
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
