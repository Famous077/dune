import { AlertCircle, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  location?: string;
  reason?: string;
  actionLabel?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = 'OPERATION FAILED',
  location,
  reason = 'An unexpected error occurred while communicating with the repository service.',
  actionLabel = 'RETRY',
  onRetry,
  className = '',
}: ErrorStateProps) {
  return (
    <div
      id="error-state-card"
      className={`border border-red-500/30 bg-neutral-950/80 p-6 text-neutral-200 font-mono text-sm max-w-lg mx-auto rounded-xl ${className}`}
    >
      <div className="flex items-center gap-2 text-red-400 mb-4 font-semibold tracking-wider uppercase text-xs">
        <AlertCircle className="w-4 h-4" />
        <span>{title}</span>
      </div>

      {location && (
        <div className="mb-3">
          <span className="text-xs text-neutral-300 uppercase tracking-wide block mb-1">
            Parsing stopped while processing:
          </span>
          <div className="bg-neutral-900 border border-neutral-800 px-3 py-1.5 text-neutral-300 text-xs rounded-lg">
            {location}
          </div>
        </div>
      )}

      <div className="mb-5">
        <span className="text-xs text-neutral-300 uppercase tracking-wide block mb-1">
          Reason:
        </span>
        <p className="text-neutral-300 text-xs leading-relaxed bg-neutral-900/50 p-3 border border-neutral-800/80 rounded-lg">
          {reason}
        </p>
      </div>

      {onRetry && (
        <button
          id="btn-error-retry"
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-4 py-2 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 hover:text-white text-xs font-mono tracking-wider uppercase transition-colors rounded-lg cursor-pointer"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          {actionLabel}
        </button>
      )}
    </div>
  );
}
