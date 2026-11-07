import { useCallback, useEffect, useState } from 'react';
import type { ViewId } from '@/domain/types';
import { Sidebar } from './Sidebar';
import Dashboard from '@/features/dashboard/Dashboard';
import WordbookView from '@/features/wordbook/WordbookView';
import SettingsView from '@/features/settings/SettingsView';
import StudyView from '@/features/study/StudyView';
import { ToastStack } from '@/ui/ToastStack';

const VIEWS: ViewId[] = ['dashboard', 'study', 'wordbook', 'settings'];

const VIEW_TITLES: Record<ViewId, string> = {
  dashboard: '今日',
  study: '学习',
  wordbook: '词库',
  settings: '设置',
};

function readViewFromHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.includes(raw as ViewId) ? (raw as ViewId) : 'dashboard';
}

export function Shell() {
  const [view, setView] = useState<ViewId>(readViewFromHash);

  const navigate = useCallback((next: ViewId) => {
    setView(next);
    const target = `#/${next}`;
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, '', `#/${readViewFromHash()}`);
    }
    const onHashChange = () => setView(readViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.title = `${VIEW_TITLES[view]} · 词渊 DeepWord`;
  }, [view]);

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('main-content');
          main?.focus();
          main?.scrollIntoView({ block: 'start' });
        }}
      >
        跳到主内容
      </a>
      <Sidebar current={view} onNavigate={navigate} />
      <main className="app-main" id="main-content" tabIndex={-1}>
        <div className="app-main__inner" key={view}>
          <div className="app-view">
            {view === 'dashboard' && <Dashboard navigate={navigate} />}
            {view === 'study' && <StudyView navigate={navigate} />}
            {view === 'wordbook' && <WordbookView />}
            {view === 'settings' && <SettingsView />}
          </div>
        </div>
        <footer className="app-footer">
          <span>DEEPWORD · 词渊</span>
          <span className="app-footer__motto">以错题为师 · 以温故为舟</span>
          <span>所有数据保存在本机浏览器</span>
        </footer>
      </main>
      <ToastStack />
    </div>
  );
}
