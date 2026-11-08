import { ACTIVE_PROVIDER_FORM_NAME } from '@/app/identity';
import type { ProviderProfile } from '@/domain/types';
import { providerName, vendorLabel } from '@/infra/llm/providerModel';
import { cx, isLocalEndpoint } from '@/domain/utils';
import { useLocale, useT } from '@/i18n';
import { IconEdit, IconPlus, IconTrash } from '@/ui/icons';
import { protocolLabel } from './draft';

export interface ProviderListProps {
  providers: ProviderProfile[];
  activeProviderId: string | null;
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
  const t = useT();
  const locale = useLocale();

  if (providers.length === 0) {
    return (
      <div className="empty-state provider-empty">
        <span className="empty-state__mark" aria-hidden="true">
          {t('providers.emptyMark')}
        </span>
        <p className="empty-state__title">{t('providers.emptyTitle')}</p>
        <p className="empty-state__desc">{t('providers.emptyDesc')}</p>
        <button type="button" className="btn btn--primary" onClick={onAdd} disabled={atLimit}>
          <IconPlus size={15} /> {t('providers.addProvider')}
        </button>
      </div>
    );
  }

  return (
    <ul className="provider-list">
      {providers.map((profile, index) => {
        const name = providerName(profile, index, locale);
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
                name={ACTIVE_PROVIDER_FORM_NAME}
                checked={isActive}
                onChange={() => onSetActive(profile.id)}
                aria-label={t('providers.setActiveAria', { name })}
              />
              <span className="provider-radio__text">
                {isActive ? t('providers.inUse') : t('providers.setActive')}
              </span>
            </label>

            <div className="provider-card__main">
              <div className="provider-card__title-row">
                <strong className="provider-card__name">{name}</strong>
                <span className="badge badge--outline">{protocolLabel(profile.protocol, t)}</span>
                <span className="badge">{vendorLabel(profile.vendor)}</span>
                {isActive && (
                  <span className="badge badge--vermilion badge--dot">{t('providers.badgeActive')}</span>
                )}
                {needsKey && (
                  <span className="badge badge--gold badge--dot">{t('providers.badgeMissingKey')}</span>
                )}
              </div>

              <dl className="provider-card__meta">
                <div>
                  <dt>{t('providers.baseUrl')}</dt>
                  <dd>{profile.baseUrl || t('providers.notFilled')}</dd>
                </div>
                <div>
                  <dt>{t('providers.defaultModel')}</dt>
                  <dd>{profile.defaultModel || t('providers.notFilled')}</dd>
                </div>
                <div>
                  <dt>{t('providers.modelAllowlist')}</dt>
                  <dd>
                    {profile.models.length > 0
                      ? t('providers.modelCountUnit', { count: profile.models.length })
                      : t('common.notSet')}
                  </dd>
                </div>
              </dl>

              {isActive && incomplete && (
                <p className="provider-card__notice">{t('providers.incomplete')}</p>
              )}
            </div>

            <div className="provider-card__actions">
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => onEdit(profile.id)}
              >
                <IconEdit size={14} /> {t('providers.editBtn')}
              </button>
              <button
                type="button"
                className="btn btn--quiet btn--sm provider-card__delete"
                onClick={() => onDelete(profile)}
              >
                <IconTrash size={14} /> {t('providers.deleteBtn')}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
