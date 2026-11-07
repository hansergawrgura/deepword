import { useApp } from '../../state/AppState';
import { IconClose } from './icons';

/** 全局 Toast 堆栈，挂在 App 根部。 */
export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label="关闭提示"
            onClick={() => dismissToast(toast.id)}
          >
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
