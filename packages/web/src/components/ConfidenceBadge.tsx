interface ConfidenceBadgeProps {
  confidence: 'high' | 'medium' | 'low';
}

export function ConfidenceBadge({ confidence }: ConfidenceBadgeProps) {
  if (confidence === 'high') {
    return (
      <span
        id="confidence-badge"
        className="inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium tracking-wider uppercase border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 rounded"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 inline-block" />
        HIGH CONFIDENCE
      </span>
    );
  }

  if (confidence === 'medium') {
    return (
      <span
        id="confidence-badge"
        className="inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium tracking-wider uppercase border border-amber-500/30 bg-amber-500/10 text-amber-400 rounded"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5 inline-block" />
        MEDIUM CONFIDENCE
      </span>
    );
  }

  return (
    <span
      id="confidence-badge"
      className="inline-flex items-center px-2 py-0.5 text-xs font-mono font-medium tracking-wider uppercase border border-red-500/30 bg-red-500/10 text-red-400 rounded"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 mr-1.5 inline-block" />
      LOW CONFIDENCE
    </span>
  );
}
