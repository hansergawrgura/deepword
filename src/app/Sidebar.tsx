import { useMemo, type JSX } from 'react';
import { useApp } from '@/app/store';
import { APP_VERSION } from '@/app/version';
import type { ViewId } from '@/domain/types';
import { getOverview } from '@/domain/stats';
import { countAvailable } from '@/domain/rounds';
import { useT } from '@/i18n';
import {
  IconBook,
  IconCards,
  IconFlame,
  IconHome,
  IconMoon,
  IconSliders,
  IconSun,
  type IconProps,
} from '@/ui/icons';
import './Sidebar.css';

interface SidebarProps {
  current: ViewId;
  onNavigate: (view: ViewId) => void;
}

interface NavEntry {
  id: ViewId;
  latinKey: string;
  icon: (props: IconProps) => JSX.Element;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', latinKey: 'nav.latin.dashboard', icon: IconHome },
  { id: 'study', latinKey: 'nav.latin.study', icon: IconCards },
  { id: 'wordbook', latinKey: 'nav.latin.wordbook', icon: IconBook },
  { id: 'settings', latinKey: 'nav.latin.settings', icon: IconSliders },
];

export function Sidebar({ current, onNavigate }: SidebarProps) {
  const { data, actions } = useApp();
  const t = useT();
  const overview = useMemo(() => getOverview(data), [data]);

  const badgeFor = (id: ViewId): number | undefined => {
    if (id === 'study') {
      const available = countAvailable(data);
      const pending = available.reviewWords + available.newWords;
      return pending > 0 ? pending : undefined;
    }
    if (id === 'wordbook') return data.words.length;
    return undefined;
  };

  return (
    <aside className="sidebar" aria-label={t('nav.mainNav')}>
      <button
        type="button"
        className="sidebar__brand"
        onClick={() => onNavigate('dashboard')}
        aria-label={t('brand.homeAria')}
      >
        <span className="sidebar__seal" aria-hidden="true">
          {t('brand.seal')}
        </span>
        <span className="sidebar__brand-text">
          <span className="sidebar__name">{t('brand.name')}</span>
          <span className="sidebar__latin">{t('brand.latin')}</span>
        </span>
      </button>

      <p className="sidebar__motto">{t('brand.motto')}</p>

      <nav className="sidebar__nav" aria-label={t('nav.pages')}>
        {NAV.map((entry) => {
          const active = current === entry.id;
          const badge = badgeFor(entry.id);
          const Icon = entry.icon;
          const label = t(`nav.${entry.id}`);
          return (
            <button
              key={entry.id}
              type="button"
              className={active ? 'sidebar__nav-item is-active' : 'sidebar__nav-item'}
              onClick={() => onNavigate(entry.id)}
              aria-current={active ? 'page' : undefined}
            >
              <span className="sidebar__nav-icon">
                <Icon size={18} />
              </span>
              <span className="sidebar__nav-text">
                <span className="sidebar__nav-label">{label}</span>
                <span className="sidebar__nav-label-short">{label}</span>
                <span className="sidebar__nav-latin">{t(entry.latinKey)}</span>
              </span>
              {badge !== undefined && badge > 0 && (
                <span className={entry.id === 'study' ? 'sidebar__nav-badge is-accent' : 'sidebar__nav-badge'}>
                  {badge > 999 ? '999+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__foot">
        <div className="sidebar__streak">
          <IconFlame size={15} />
          <span>{t('streak.days', { count: overview.streak })}</span>
          <span className="sidebar__streak-dot" aria-hidden="true" />
        </div>

        <button
          type="button"
          className="sidebar__theme"
          onClick={() => actions.setTheme(data.theme === 'dark' ? 'light' : 'dark')}
          aria-label={data.theme === 'dark' ? t('theme.switchToDay') : t('theme.switchToNight')}
        >
          {data.theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          <span>{data.theme === 'dark' ? t('theme.day') : t('theme.night')}</span>
          <span className="sidebar__theme-track" aria-hidden="true">
            <span className="sidebar__theme-knob" />
          </span>
        </button>

        <p className="sidebar__version">
          <span>{t('brand.versionLine', { version: APP_VERSION })}</span>
          <span>{t('shell.localStorage')}</span>
        </p>
      </div>
    </aside>
  );
}
