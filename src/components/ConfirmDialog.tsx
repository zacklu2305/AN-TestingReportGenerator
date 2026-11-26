import { useEffect } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: 'danger' | 'primary';
  secondaryLabel?: string;
  onConfirm: () => void;
  onSecondary?: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmVariant = 'primary',
  secondaryLabel,
  onConfirm,
  onSecondary,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={onCancel}
    >
      <div
        className="glass-panel w-full max-w-lg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="confirm-dialog-title"
          className="text-[17px] font-semibold text-[#1d1d1f] tracking-[-0.01em]"
        >
          {title}
        </h3>
        <p className="mt-2 text-[14px] leading-relaxed text-[#525257]">
          {message}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-2.5 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="glass-btn-secondary px-5 py-2.5 text-[13px] font-medium disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            Cancel
          </button>
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="glass-btn-secondary px-5 py-2.5 text-[13px] font-medium disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={`${
              confirmVariant === 'danger'
                ? 'rounded-full bg-[#ff3b30] hover:bg-[#e0352b] text-white shadow-[0_4px_12px_rgba(255,59,48,0.28)] transition-all'
                : 'glass-btn-primary'
            } px-5 py-2.5 text-[13px] font-medium disabled:opacity-50 whitespace-nowrap shrink-0`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
