import { Bot, User, FileCode } from 'lucide-react';
import type { ContextItem } from '@dune/shared/types';
import { timeAgo } from '../lib/utils';

interface ContextItemCardProps {
  item: ContextItem;
  onOpenFile?: (path: string) => void;
}

export function ContextItemCard({ item, onOpenFile }: ContextItemCardProps) {
  const getTypeColor = () => {
    switch (item.type) {
      case 'decision':
        return 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20';
      case 'dead-end':
        return 'text-red-400 border-red-500/30 bg-red-950/20';
      case 'constraint':
        return 'text-amber-400 border-amber-500/30 bg-amber-950/20';
    }
  };

  return (
    <div
      id={`context-item-${item.id}`}
      className="border border-neutral-800 bg-neutral-900/40 p-3.5 font-mono text-xs space-y-2.5 hover:border-neutral-700 transition-colors rounded-xl"
    >
      {/* Category header & Author badge */}
      <div className="flex items-center justify-between flex-wrap gap-1">
        <span
          className={`text-[10px] px-1.5 py-0.2 border uppercase tracking-wider font-bold rounded ${getTypeColor()}`}
        >
          {item.type === 'dead-end'
            ? 'DEAD END'
            : item.type === 'decision'
            ? 'DECISION'
            : 'CONSTRAINT'}
        </span>
        {/* A human must always be able to tell which parts of the record a model wrote. */}
        {item.authoredBy === 'agent' ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.2 bg-purple-500/10 border border-purple-500/30 text-purple-300 text-[10px] font-mono tracking-wider uppercase rounded">
            <Bot className="w-3 h-3" />
            [ AGENT-AUTHORED ]
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.2 bg-neutral-800 border border-neutral-700 text-neutral-300 text-[10px] font-mono tracking-wider uppercase rounded">
            <User className="w-3 h-3" />
            [ HUMAN ]
          </span>
        )}
      </div>

      {/* Title */}
      <div className="text-white font-semibold text-xs leading-snug">
        {item.title}
      </div>

      {/* Body */}
      <p className="text-neutral-300 text-[11px] leading-relaxed bg-neutral-950/50 p-2.5 border border-neutral-900 rounded-lg whitespace-pre-line">
        {item.body}
      </p>

      {/* Footer metadata: file paths and timestamp */}
      <div className="pt-1 flex items-start justify-between gap-2 text-[10px] text-neutral-400 border-t border-neutral-900">
        {item.files.length > 0 ? (
          <div className="flex flex-col gap-0.5 min-w-0">
            {item.files.map((file) => (
              <button
                key={file}
                type="button"
                onClick={() => onOpenFile?.(file)}
                className="text-neutral-300 hover:text-white flex items-center gap-1 transition-colors cursor-pointer group min-w-0"
                title="Open source snapshot"
              >
                <FileCode className="w-3 h-3 text-neutral-500 group-hover:text-amber-400 shrink-0" />
                <span className="truncate group-hover:underline">{file}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="text-neutral-600">No file pinned</span>
        )}

        <span className="text-neutral-400 shrink-0" title={item.createdAt}>
          {timeAgo(item.createdAt)}
        </span>
      </div>
    </div>
  );
}
