import { AlertCircle, X } from 'lucide-react';

interface ErrorBannerProps {
  message: string | null;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-[14px] border border-[#ff3b30]/25 bg-[#ff3b30]/[0.09] px-3.5 py-2.5 text-[13px] text-[#1d1d1f]"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#ff3b30]" aria-hidden="true" />
      <p className="flex-1 leading-relaxed break-words">{message}</p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="-mr-1 -mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[#ff3b30] transition-colors hover:bg-[#ff3b30]/10 focus-visible:outline-2 focus-visible:outline-[#ff3b30]"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
