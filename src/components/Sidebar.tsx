import { useMemo, type JSX } from 'react';
import { useApp } from '../state/AppState';
import type { ViewId } from '../types';
import { getMistakeList, getOverview } from '../lib/stats';
import {
  IconBook,
  IconCards,
  IconFlame,
  IconHome,
  IconMoon,
  IconSliders,
  IconSun,
  IconTarget,
  type IconProps,
} from './ui/icons';
import './Sidebar.css';

interface SidebarProps {
  current: ViewId;
  onNavigate: (view: ViewId) => void;
}

interface NavEntry {
  id: ViewId;
  label: string;
  shortLabel: string;
  latin: string;
  icon: (props: IconProps) => JSX.Element;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: '今日', shortLabel: '今日', latin: 'TODAY', icon: IconHome },
  { id: 'study', label: '学习', shortLabel: '学习', latin: 'STUDY', icon: IconCards },
  { id: 'drill', label: '错题特训', shortLabel: '特训', latin: 'DRILL', icon: IconTarget },
  { id: 'wordbook', label: '词库', shortLabel: '词库', latin: 'WORDBOOK', icon: IconBook },
  { id: 'settings', label: '设置', shortLabel: '设置', latin: 'SETTINGS', icon: IconSliders },
];

export function Sidebar({ current, onNavigate }: SidebarProps) {
  const { data, actions } = useApp();
  const overview = useMemo(() => getOverview(data), [data]);
  const unresolved = useMemo(
    () => getMistakeList(data).filter((item) => item.correctStreak < 2).length,
    [data],
  );

  const badgeFor = (id: ViewId): number | undefined => {
    if (id === 'study') return overview.dueCount + (overview.todayReviewed === 0 ? Math.min(5, overview.newCount) : 0);
    if (id === 'drill') return unresolved;
    if (id === 'wordbook') return data.words.length;
    return undefined;
  };

  return (
    <aside className="sidebar" aria-label="主导航">
      <button
        type="button"
        className="sidebar__brand"
        onClick={() => onNavigate('dashboard')}
        aria-label="词渊 DeepWord 首页"
      >
        <span className="sidebar__seal" aria-hidden="true">
          渊
        </span>
        <span className="sidebar__brand-text">
          <span className="sidebar__name">词渊</span>
          <span className="sidebar__latin">DEEPWORD</span>
        </span>
      </button>

      <p className="sidebar__motto">以错题为师 · 以温故为舟</p>

      <nav className="sidebar__nav" aria-label="页面">
        {NAV.map((entry) => {
          const active = current === entry.id;
          const badge = badgeFor(entry.id);
          const Icon = entry.icon;
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
                <span className="sidebar__nav-label">{entry.label}</span>
                <span className="sidebar__nav-label-short">{entry.shortLabel}</span>
                <span className="sidebar__nav-latin">{entry.latin}</span>
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
          <span>
            连续 <strong>{overview.streak}</strong> 天
          </span>
          <span className="sidebar__streak-dot" aria-hidden="true" />
        </div>

        <button
          type="button"
          className="sidebar__theme"
          onClick={() => actions.setTheme(data.theme === 'dark' ? 'light' : 'dark')}
          aria-label={data.theme === 'dark' ? '切换到昼读模式' : '切换到夜读模式'}
        >
          {data.theme === 'dark' ? <IconSun size={15} /> : <IconMoon size={15} />}
          <span>{data.theme === 'dark' ? '昼读' : '夜读'}</span>
          <span className="sidebar__theme-track" aria-hidden="true">
            <span className="sidebar__theme-knob" />
          </span>
        </button>

        <p className="sidebar__version">
          <span>词渊 · v1.0</span>
          <span>本地存储</span>
        </p>
      </div>
    </aside>
  );
}
