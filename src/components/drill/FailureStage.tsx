/**
 * 组卷失败：给出可读原因、针对错误码的建议，以及三条出路
 * （重试 / 改用本地题库 / 返回调整）。
 */

import { cx } from '@/lib/utils';
import { shortDetail } from './meta';
import type { DrillErrorInfo } from './types';

interface FailureStageProps {
  failure: DrillErrorInfo;
  count: number;
  difficultyLabel: string;
  selectedCount: number;
  onRetry: () => void;
  onUseLocal: () => void;
  onBack: () => void;
}

export default function FailureStage({
  failure,
  count,
  difficultyLabel,
  selectedCount,
  onRetry,
  onUseLocal,
  onBack,
}: FailureStageProps) {
  const detail = shortDetail(failure.detail);

  return (
    <section className="drill-failure">
      <div className="drill-fail">
        <span className="drill-stamp drill-stamp--wrong drill-fail__stamp" aria-hidden="true">
          未成
        </span>
        <p className="mono-label">FAILED / 未能成卷</p>
        <h2 className="drill-fail__title">这一卷没有命成</h2>
        <p className="drill-fail__message">{failure.message}</p>
        <p className="drill-fail__hint">{failure.hint}</p>
        {detail && <p className="drill-fail__detail">接口返回：{detail}</p>}

        <div className="drill-fail__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            重试
          </button>
          {failure.mode === 'llm' && (
            <button type="button" className="btn" onClick={onUseLocal}>
              改用本地题库继续
            </button>
          )}
          <button type="button" className="btn btn--quiet" onClick={onBack}>
            返回调整
          </button>
        </div>

        <p className={cx('hint', 'drill-fail__meta')}>
          已选 {selectedCount} 个词，{count} 题，{difficultyLabel}
        </p>
      </div>
    </section>
  );
}
