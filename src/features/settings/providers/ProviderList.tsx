/** Provider 列表：每份配置一张卡片，radio 切换「当前使用」，可编辑 / 删除。 */

import type { ProviderProfile } from '@/domain/types';
import { providerName, vendorLabel } from '@/infra/llm/providerModel';
import { cx, isLocalEndpoint } from '@/domain/utils';
import { IconEdit, IconPlus, IconTrash } from '@/ui/icons';
import { protocolLabel } from './draft';

export interface ProviderListProps {
  providers: ProviderProfile[];
  activeProviderId: string | null;
  /** 是否已达数量上限（新增按钮禁用）。 */
  atLimit: boolean;
  onAdd: () => void;
  onEdit: (id: string) => void;
  onDelete: (profile: ProviderProfile) => void;
  onSetActive: (id: string) => void;
}

export default function ProviderList({
  providers,
  activeProviderId,
  atLimit,
  onAdd,
  onEdit,
  onDelete,
  onSetActive,
}: ProviderListProps) {
  if (providers.length === 0) {
    return (
      <div className="empty-state provider-empty">
        <span className="empty-state__mark" aria-hidden="true">
          空
        </span>
        <p className="empty-state__title">还没有模型配置</p>
        <p className="empty-state__desc">
          添加一份 OpenAI 兼容或 Anthropic 配置，就可以让大模型针对错词命题与讲解。
          没有配置时，练习会退回本地题库。
        </p>
        <button type="button" className="btn btn--primary" onClick={onAdd} disabled={atLimit}>
          <IconPlus size={15} /> 新增配置
        </button>
      </div>
    );
  }

  return (
    <ul className="provider-list">
      {providers.map((profile, index) => {
        const name = providerName(profile, index);
        const isActive = profile.id === activeProviderId;
        const needsKey =
          !profile.apiKey.trim() &&
          (profile.protocol === 'anthropic' || !isLocalEndpoint(profile.baseUrl));
        const incomplete = !profile.baseUrl.trim() || !profile.defaultModel.trim();
        return (
          <li
            key={profile.id}
            className={cx('provider-card', isActive && 'provider-card--active')}
          >
            <label className="provider-radio">
              <input
                type="radio"
                name="deepword-active-provider"
                checked={isActive}
                onChange={() => onSetActive(profile.id)}
                aria-label={`将「${name}」设为当前使用`}
              />
              <span className="provider-radio__text">{isActive ? '使用中' : '设为当前'}</span>
            </label>

            <div className="provider-card__main">
              <div className="provider-card__title-row">
                <strong className="provider-card__name">{name}</strong>
                <span className="badge badge--outline">{protocolLabel(profile.protocol)}</span>
                <span className="badge">{vendorLabel(profile.vendor)}</span>
                {isActive && <span className="badge badge--vermilion badge--dot">当前使用</span>}
                {needsKey && <span className="badge badge--gold badge--dot">缺 Key</span>}
              </div>

              <dl className="provider-card__meta">
                <div>
                  <dt>BASE URL</dt>
                  <dd>{profile.baseUrl || '未填写'}</dd>
                </div>
                <div>
                  <dt>默认模型</dt>
                  <dd>{profile.defaultModel || '未填写'}</dd>
                </div>
                <div>
                  <dt>模型白名单</dt>
                  <dd>{profile.models.length > 0 ? `${profile.models.length} 个` : '未设置'}</dd>
                </div>
              </dl>

              {isActive && incomplete && (
                <p className="provider-card__notice">
                  这份配置缺少 Base URL 或默认模型，出题与判分会退回本地题库。
                </p>
              )}
            </div>

            <div className="provider-card__actions">
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => onEdit(profile.id)}
              >
                <IconEdit size={14} /> 编辑
              </button>
              <button
                type="button"
                className="btn btn--quiet btn--sm provider-card__delete"
                onClick={() => onDelete(profile)}
              >
                <IconTrash size={14} /> 删除
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
