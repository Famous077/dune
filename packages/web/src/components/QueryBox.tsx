import React, { useState, useRef, useEffect } from 'react';
import { Search, Loader2 } from 'lucide-react';

interface QueryBoxProps {
  onSearch: (question: string) => void;
  isLoading: boolean;
  /** Example chips solve the blank page; they go once an answer is on screen. */
  showExamples: boolean;
}

// Phrased to make sense on any web codebase, since the repo is whatever was indexed.
const EXAMPLE_QUERIES = [
  'Where is authentication handled?',
  'Where do I add a new API route?',
  'Where is data validated before it is saved?',
];

export function QueryBox({ onSearch, isLoading, showExamples }: QueryBoxProps) {
  const [question, setQuestion] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea between 2 and 4 rows
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      // Clamp between ~56px and ~110px
      textareaRef.current.style.height = `${Math.min(112, Math.max(56, scrollHeight))}px`;
    }
  }, [question]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (question.trim() && !isLoading) {
      onSearch(question.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div id="query-box-container" className="p-4 border-b border-[#3A2B33] bg-[#0A0B14] font-mono-dune">
      <div className="flex items-center justify-between mb-2">
        <label
          htmlFor="query-input"
          className="flex items-center gap-2"
        >
          <Search className="w-3.5 h-3.5 text-[#F0DFB4]" />
          <span className="font-serif-dune text-sm font-semibold text-[#F0DFB4] tracking-wide">
            Codebase Query
          </span>
        </label>
        <span className="text-[10px] font-mono-dune text-[#C89B6B]/80 hidden sm:inline tracking-wider">
          Enter ↵ submit
        </span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <textarea
            ref={textareaRef}
            id="query-input"
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Where do I add rate limiting to the auth API?"
            disabled={isLoading}
            className="w-full px-3 py-2.5 bg-[#171833]/40 border border-[#3A2B33] text-[#EAE2D4] text-xs font-mono-dune placeholder:text-[#57392C] focus:outline-none focus:border-[#C89B6B] focus:ring-1 focus:ring-[#C89B6B] resize-none transition-colors leading-relaxed rounded-lg shadow-inner"
          />
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            id="btn-find-location"
            type="submit"
            disabled={isLoading || !question.trim()}
            className="w-full py-2.5 px-4 bg-[#F0DFB4] hover:bg-[#FFF5DD] text-[#0A0B14] font-bold font-mono-dune text-xs tracking-wider uppercase transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed select-none rounded-lg shadow-[0_2px_10px_rgba(240,223,180,0.15)] active:scale-[0.99]"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0A0B14]" />
                <span>Surveying terrain...</span>
              </>
            ) : (
              <span>Locate injection point</span>
            )}
          </button>
        </div>
      </form>

      {/* Examples chips */}
      {showExamples && (
      <div className="mt-3 pt-2.5 border-t border-[#3A2B33]/60">
        <span className="text-[10px] font-mono-dune text-[#C89B6B] uppercase tracking-wider block mb-1.5 font-medium">
          Suggested inquiries
        </span>
        <div className="flex flex-col gap-1 font-mono-dune">
          {EXAMPLE_QUERIES.map((ex, i) => (
            <button
              key={i}
              type="button"
              disabled={isLoading}
              onClick={() => {
                setQuestion(ex);
                onSearch(ex);
              }}
              className="text-left text-[11px] text-[#EAE2D4]/70 hover:text-[#F0DFB4] transition-colors truncate cursor-pointer hover:underline flex items-center gap-1.5 py-0.5"
            >
              <span className="text-[#C89B6B] text-[10px]">•</span>
              <span className="truncate">{ex}</span>
            </button>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}
