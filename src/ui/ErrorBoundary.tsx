import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createT, DEFAULT_LOCALE } from '@/i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const t = createT(DEFAULT_LOCALE);
    return {
      hasError: true,
      message: error instanceof Error ? error.message : t('common.unknownError'),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dpdp-word] render error', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const t = createT(DEFAULT_LOCALE);
    return (
      <div className="app-crash">
        <div className="card app-crash__card">
          <span className="seal">{t('brand.seal')}</span>
          <h1 className="app-crash__title">{t('errorBoundary.title')}</h1>
          <p className="app-crash__desc">{t('errorBoundary.desc')}</p>
          <p className="app-crash__detail">{this.state.message}</p>
          <div className="app-crash__actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              {t('errorBoundary.reload')}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                window.location.hash = '#/settings';
                window.location.reload();
              }}
            >
              {t('errorBoundary.goSettings')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
