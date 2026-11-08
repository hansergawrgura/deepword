import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn--quiet" onClick={onClose}>
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <div style={{ color: 'var(--ink-soft)', fontSize: 13.5, lineHeight: 1.75 }}>{message}</div>
    </Modal>
  );
}
