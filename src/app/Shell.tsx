import { useCallback, useEffect, useState } from 'react';
import type { ViewId } from '@/domain/types';
import { useLocale, useT } from '@/i18n';
import { Sidebar } from './Sidebar';
import Dashboard from '@/features/dashboard/Dashboard';
import WordbookView from '@/features/wordbook/WordbookView';
import SettingsView from '@/features/settings/SettingsView';
import StudyView from '@/features/study/StudyView';
import { ToastStack } from '@/ui/ToastStack';

const VIEWS: ViewId[] = ['dashboard', 'study', 'wordbook', 'settings'];

function readViewFromHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.includes(raw as ViewId) ? (raw as ViewId) : 'dashboard';
}

export function Shell() {
  const t = useT();
  const locale = useLocale();
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
    document.documentElement.lang = locale;
    document.title = t('brand.documentTitle', { view: t(`nav.${view}`) });
  }, [locale, t, view]);

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
        {t('shell.skipToContent')}
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
          <span>{t('brand.footer')}</span>
          <span className="app-footer__motto">{t('brand.motto')}</span>
          <span>{t('shell.dataLocalOnly')}</span>
        </footer>
      </main>
      <ToastStack />
    </div>
  );
}
