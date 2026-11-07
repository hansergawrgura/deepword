import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

/** 最外层错误边界：任何渲染异常都给出可恢复的说明，而不是白屏。 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : '未知错误',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[DeepWord] 渲染错误', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="app-crash">
        <div className="card app-crash__card">
          <span className="seal">渊</span>
          <h1 className="app-crash__title">页面遇到了些问题</h1>
          <p className="app-crash__desc">
            你的学习数据保存在本机浏览器里，通常不会丢失。刷新页面可以继续；如果反复出现，可以导出备份后在设置中恢复初始数据。
          </p>
          <p className="app-crash__detail">{this.state.message}</p>
          <div className="app-crash__actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              刷新页面
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                window.location.hash = '#/settings';
                window.location.reload();
              }}
            >
              前往设置
            </button>
          </div>
        </div>
      </div>
    );
  }
}
