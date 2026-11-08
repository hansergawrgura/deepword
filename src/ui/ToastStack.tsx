import { useApp } from '@/app/store';
import { useT } from '@/i18n';
import { IconClose } from './icons';

export function ToastStack() {
  const { toasts, dismissToast } = useApp();
  const t = useT();
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="toast__close"
            aria-label={t('common.closeToast')}
            onClick={() => dismissToast(toast.id)}
          >
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
