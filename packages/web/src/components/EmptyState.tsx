import { HelpCircle } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  example?: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function EmptyState({
  title,
  description,
  example,
  actionLabel,
  onAction,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      id="empty-state-box"
      className={`border border-neutral-800 bg-neutral-900/40 p-6 text-neutral-300 font-mono text-sm rounded-xl ${className}`}
    >
      <div className="flex items-center gap-2 text-neutral-400 mb-2 font-semibold tracking-wider uppercase text-xs">
        <HelpCircle className="w-4 h-4 text-neutral-500" />
        <span>{title}</span>
      </div>

      <p className="text-neutral-400 text-xs leading-relaxed mb-4">{description}</p>

      {example && (
        <div className="border-l-2 border-neutral-700 pl-3 py-1 my-3 text-xs text-neutral-300 italic rounded-r-md">
          <span className="text-neutral-400 block not-italic uppercase text-[10px] mb-0.5">
            Example:
          </span>
          "{example}"
        </div>
      )}

      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-3 px-3 py-1.5 border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-xs font-mono tracking-wider uppercase transition-colors rounded-lg cursor-pointer"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
