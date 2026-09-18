import { Bookmark, ExternalLink, AlertTriangle, FileCode, CheckCircle2, Timer } from 'lucide-react';
import type { Answer, Source } from '@dune/shared/types';
import { ConfidenceBadge } from './ConfidenceBadge';
import { ErrorState } from './ErrorState';
import { errorMessage, isRetryable } from '../api/client';

interface AnswerCardProps {
  answer: Answer | null;
  /** The server's own measurement, shown with the answer. */
  tookMs: number | null;
  isLoading: boolean;
  error: unknown;
  /** Present when the last question failed; shown only if the error is retryable. */
  onRetry: (() => void) | null;
  /** `lines` is null when there is no cited range for that file. */
  onOpenSource: (file: string, lines: Source['lines'] | null) => void;
  /** Opens an editable draft in the context panel; nothing is saved until a person does. */
  onSaveToContext: () => void;
}

function TookMs({ tookMs }: { tookMs: number | null }) {
  if (tookMs === null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-[#C89B6B]/80 font-mono-dune" title="Server time for this answer">
      <Timer className="w-3 h-3" />
      {(tookMs / 1000).toFixed(1)}s
    </span>
  );
}

function SaveToContextButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="pt-2 border-t border-[#3A2B33]">
      <button
        id="btn-save-to-context"
        onClick={onClick}
        title="Opens a draft in the context panel to edit before saving"
        className="w-full py-2.5 px-3 border text-xs font-mono-dune uppercase tracking-wider transition-all flex items-center justify-center gap-2 cursor-pointer rounded-lg shadow-sm border-[#3A2B33] bg-[#171833]/60 hover:bg-[#241C2E] hover:border-[#C89B6B]/60 text-[#EAE2D4] hover:text-[#F0DFB4]"
      >
        <Bookmark className="w-3.5 h-3.5 text-[#C89B6B]" />
        <span>SAVE TO CONTEXT ATLAS</span>
      </button>
    </div>
  );
}

export function AnswerCard({
  answer,
  tookMs,
  isLoading,
  error,
  onRetry,
  onOpenSource,
  onSaveToContext,
}: AnswerCardProps) {
  // The cited range for a file, if the answer cites one.
  const linesFor = (file: string): Source['lines'] | null =>
    answer?.sources.find((s) => s.file === file)?.lines ?? null;

  // Section 17: Query Loading Skeleton shaped like AnswerCard
  if (isLoading) {
    return (
      <div id="answer-card-loading" className="p-4 font-mono-dune text-xs space-y-4 bg-[#0A0B14] relative overflow-hidden">
        {/* Subtle moon glowing aura across the card during AI query processing */}
        <div
          className="absolute inset-0 pointer-events-none animate-moon-aura"
          style={{
            background:
              'radial-gradient(ellipse 90% 70% at 50% 10%, rgba(240, 223, 180, 0.08) 0%, transparent 80%)',
          }}
        />

        <div className="flex items-center justify-between border-b border-[#3A2B33]/80 pb-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#F0DFB4] shadow-[0_0_8px_#F0DFB4] animate-pulse" />
            <span className="font-serif-dune text-[#F0DFB4] text-xs font-semibold tracking-wide">
              Surveying Codebase Topography...
            </span>
          </div>
          <span className="text-[10px] text-[#C89B6B] font-mono-dune uppercase tracking-wider animate-pulse">
            Processing
          </span>
        </div>

        <div className="h-9 w-full bg-[#171833]/60 border border-[#3A2B33] rounded-lg animate-pulse" />

        <div className="pt-2">
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
            Attach to Symbol
          </span>
          <div className="h-7 w-3/5 bg-[#171833]/40 border border-[#3A2B33] rounded-md animate-pulse" />
        </div>

        <div className="pt-2">
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
            Topological Rationale
          </span>
          <div className="space-y-1.5 p-2.5 bg-[#171833]/20 border border-[#3A2B33]/50 rounded-lg animate-pulse">
            <div className="h-3 w-full bg-[#171833] rounded" />
            <div className="h-3 w-11/12 bg-[#171833] rounded" />
            <div className="h-3 w-3/4 bg-[#171833] rounded" />
          </div>
        </div>

        <div className="pt-2">
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
            Affected Dependencies
          </span>
          <div className="flex gap-2 animate-pulse">
            <div className="h-5 w-20 bg-[#171833] rounded-md" />
            <div className="h-5 w-24 bg-[#171833] rounded-md" />
            <div className="h-5 w-28 bg-[#171833] rounded-md" />
          </div>
        </div>

        {/* Subtle mini dune crest pulsing gently with --moon */}
        <div className="pt-3 border-t border-[#3A2B33]/50">
          <div className="flex items-center justify-between text-[10px] text-[#C89B6B]/80 mb-1">
            <span>Resolving symbol centrality</span>
            <span className="text-[#F0DFB4]">AI reasoning active</span>
          </div>
          <svg viewBox="0 0 400 24" preserveAspectRatio="none" className="w-full h-3.5 overflow-visible">
            <path
              d="M0,18 Q100,4 220,14 T400,6"
              stroke="var(--moon)"
              strokeWidth="2"
              fill="none"
              className="animate-moon-ridge"
            />
          </svg>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <ErrorState
          title="COULD NOT ANSWER"
          reason={errorMessage(error)}
          actionLabel="ASK AGAIN"
          {...(onRetry && isRetryable(error) ? { onRetry } : {})}
        />
      </div>
    );
  }

  if (!answer) {
    return (
      <div className="p-8 font-mono-dune text-xs text-[#EAE2D4]/60 text-center flex flex-col items-center justify-center h-48">
        <span className="font-serif-dune text-sm text-[#F0DFB4] mb-1.5">Awaiting Cartographic Query</span>
        <p className="max-w-[260px] text-[11px] text-[#C89B6B]/80 leading-relaxed">
          Submit an inquiry above to identify attachment points, topological dependencies, and affected tests.
        </p>
      </div>
    );
  }

  // Section 16: Low-confidence Answer Card — candidates instead of one recommendation.
  if (answer.confidence === 'low' || !answer.recommendedFile) {
    const candidates =
      answer.candidates && answer.candidates.length > 0
        ? answer.candidates
        : answer.recommendedFile
          ? [{ file: answer.recommendedFile, reason: 'The closest match, but not strongly supported.' }]
          : [];
    return (
      <div id="answer-card-low-confidence" className="p-4 font-mono-dune text-xs space-y-4 bg-[#0A0B14]">
        <div className="flex items-center justify-between border-b border-[#3A2B33] pb-2">
          <span className="font-serif-dune text-sm text-[#C89B6B] font-semibold">
            Uncertain Match
          </span>
          <div className="flex items-center gap-2">
            <TookMs tookMs={tookMs} />
            <ConfidenceBadge confidence="low" />
          </div>
        </div>

        <div className="flex items-start gap-2.5 text-[#F0DFB4] bg-[#241C2E]/70 border border-[#C89B6B]/30 p-3 rounded-lg">
          <AlertTriangle className="w-4 h-4 shrink-0 text-[#C89B6B] mt-0.5" />
          <div>
            <div className="font-serif-dune font-semibold text-xs text-[#F0DFB4] mb-0.5">
              No single location was strongly supported
            </div>
            <div className="font-mono-dune text-[11px] text-[#EAE2D4]/80 leading-relaxed">
              The engine prefers honest uncertainty over an ungrounded guess. Review the candidate locations below.
            </div>
          </div>
        </div>

        {/* Candidate locations */}
        {candidates.length > 0 && (
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1.5">
            Candidate Locations
          </span>
          <div className="space-y-1.5 bg-[#171833]/30 p-2.5 border border-[#3A2B33] rounded-lg">
            {candidates.map((candidate, idx) => (
              <button
                key={candidate.file}
                type="button"
                // A directory candidate has no file to open.
                disabled={candidate.file.endsWith('/')}
                onClick={() => onOpenSource(candidate.file, linesFor(candidate.file))}
                className="w-full text-left font-mono-dune text-xs text-[#EAE2D4] hover:text-[#F0DFB4] hover:bg-[#171833]/60 px-2 py-1.5 rounded transition-colors cursor-pointer group disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-[#EAE2D4]"
              >
                <span className="flex items-center justify-between">
                  <span className="truncate">
                    {idx + 1}. {candidate.file}
                  </span>
                  {!candidate.file.endsWith('/') && (
                    <ExternalLink className="w-3 h-3 text-[#C89B6B] group-hover:text-[#F0DFB4] shrink-0 ml-1.5" />
                  )}
                </span>
                <span className="block text-[11px] text-[#EAE2D4]/60 font-sans mt-0.5 pl-3.5">{candidate.reason}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        {/* Why */}
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
            Topological Context
          </span>
          <p className="font-mono-dune text-[#EAE2D4]/85 leading-relaxed text-xs bg-[#171833]/20 p-2.5 border border-[#3A2B33] rounded-lg">
            {answer.reason}
          </p>
        </div>

        {/* Sources button */}
        {answer.sources[0] && (
          <div className="pt-2">
            <button
              onClick={() => onOpenSource(answer.sources[0]!.file, answer.sources[0]!.lines)}
              className="w-full py-2 px-3 border border-[#3A2B33] bg-[#171833]/50 hover:bg-[#241C2E] text-[#EAE2D4] hover:text-white text-xs font-mono-dune uppercase tracking-wider transition-colors flex items-center justify-center gap-2 cursor-pointer rounded-lg"
            >
              <FileCode className="w-3.5 h-3.5 text-[#C89B6B]" />
              <span>Inspect Sources ({answer.sources.length})</span>
            </button>
          </div>
        )}

        {/* An uncertain answer is when a team record helps most: say which one is right. */}
        <SaveToContextButton onClick={onSaveToContext} />
      </div>
    );
  }

  // Section 14: Structured Primary Answer Card (High/Medium Confidence)
  return (
    <div id="answer-card-primary" className="p-4 font-mono-dune text-xs space-y-4 bg-[#0A0B14]">
      {/* Recommended Header & Confidence */}
      <div className="flex items-center justify-between border-b border-[#3A2B33] pb-2">
        <span className="font-serif-dune text-sm font-semibold text-[#F0DFB4] tracking-wide">
          Recommended Injection Target
        </span>
        <div className="flex items-center gap-2">
          <TookMs tookMs={tookMs} />
          <ConfidenceBadge confidence={answer.confidence} />
        </div>
      </div>

      {/* Recommended File */}
      <div>
        <button
          onClick={() => onOpenSource(answer.recommendedFile!, linesFor(answer.recommendedFile!))}
          className="w-full text-left group cursor-pointer"
        >
          <div className="text-sm font-mono-dune font-semibold text-[#F0DFB4] group-hover:text-white transition-colors flex items-center justify-between bg-[#171833]/50 px-3 py-2.5 border border-[#3A2B33] hover:border-[#C89B6B] rounded-lg shadow-sm">
            <span className="truncate">{answer.recommendedFile}</span>
            <ExternalLink className="w-3.5 h-3.5 text-[#C89B6B] group-hover:text-[#F0DFB4] shrink-0 ml-2" />
          </div>
        </button>
      </div>

      {/* Attach To */}
      {answer.attachTo && (
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
            Attach To
          </span>
          <button
            type="button"
            onClick={() => onOpenSource(answer.attachTo!, linesFor(answer.attachTo!))}
            className="w-full text-left bg-[#171833]/35 hover:bg-[#241C2E]/70 px-2.5 py-1.5 border border-[#3A2B33] hover:border-[#C89B6B] text-[#EAE2D4] hover:text-[#F0DFB4] font-mono-dune text-xs rounded-md transition-colors cursor-pointer"
          >
            <code>{answer.attachTo}</code>
          </button>
        </div>
      )}

      {/* Why */}
      <div>
        <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1">
          Topological Rationale
        </span>
        <p className="font-mono-dune text-[#EAE2D4]/90 leading-relaxed text-xs bg-[#171833]/25 p-2.5 border border-[#3A2B33] rounded-lg">
          {answer.reason}
        </p>
      </div>

      {/* Affected Routes / Files */}
      {answer.affected.length > 0 && (
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1.5">
            Affected
          </span>
          <div className="flex flex-wrap gap-1.5">
            {answer.affected.map((aff, i) => (
              <span
                key={i}
                className="font-mono-dune px-2 py-0.5 bg-[#171833]/50 border border-[#3A2B33] text-[#C89B6B] text-[11px] rounded-md"
              >
                {aff}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tests to update */}
      {answer.testsToUpdate.length > 0 && (
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1.5">
            Tests to Update
          </span>
          <div className="space-y-1">
            {answer.testsToUpdate.map((t, i) => (
              <div
                key={i}
                className="font-mono-dune text-[11px] text-[#EAE2D4]/85 bg-[#171833]/35 px-2.5 py-1.5 border border-[#3A2B33] flex items-center gap-1.5 rounded-md"
              >
                <CheckCircle2 className="w-3 h-3 text-[#C89B6B] shrink-0" />
                <span className="truncate">{t}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sources with line numbers in moonlight highlight (--moon #F0DFB4) */}
      {answer.sources.length > 0 && (
        <div>
          <span className="font-serif-dune text-[#C89B6B] text-xs font-semibold block mb-1.5">
            Cited Source Lines
          </span>
          <div className="space-y-1">
            {answer.sources.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onOpenSource(s.file, s.lines)}
                className="w-full text-left px-2.5 py-1.5 bg-[#171833]/40 hover:bg-[#241C2E]/70 border border-[#3A2B33] hover:border-[#C89B6B] text-[#EAE2D4] hover:text-[#F0DFB4] flex items-center justify-between text-[11px] font-mono-dune transition-colors cursor-pointer group rounded-lg"
              >
                <span className="truncate text-[#F0DFB4] font-medium">
                  {s.file}:{s.lines[0]}–{s.lines[1]}
                </span>
                <span className="text-[10px] text-[#C89B6B] group-hover:text-[#F0DFB4] shrink-0 ml-1">
                  Inspect ↗
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Save to context action */}
      <SaveToContextButton onClick={onSaveToContext} />
    </div>
  );
}
