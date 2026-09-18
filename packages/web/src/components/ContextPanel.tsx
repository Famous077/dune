import { useLayoutEffect, useState } from 'react';
import {
  X,
  Plus,
  FileDown,
  Copy,
  Check,
  Sparkles,
  Server,
  GitPullRequestArrow,
  Loader2,
} from 'lucide-react';
import type { ContextItem, ContextType, Suggestion } from '@dune/shared/types';
import type { ContextDraft } from '../api/context';
import { errorMessage } from '../api/client';
import { MCP_URL } from '../config';
import { parseFileList } from '../lib/utils';
import { ContextItemCard } from './ContextItemCard';
import { SuggestionCard } from './SuggestionCard';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';

interface ContextPanelProps {
  repoId: string | null;
  repoName: string | null;
  items: ContextItem[];
  /** Pending suggestions only; saved and dismissed ones never come back from the API. */
  suggestions: Suggestion[];
  isLoading: boolean;
  loadError: string | null;
  onReload: () => void;
  isOpen: boolean;
  /** A pre-filled form, e.g. from "Save to context" on an answer. Consumed once shown. */
  draft: ContextDraft | null;
  onDraftConsumed: () => void;
  onClose: () => void;
  onCreateItem: (draft: ContextDraft) => Promise<void>;
  onApproveSuggestion: (suggestionId: string, draft: ContextDraft) => Promise<void>;
  onDismissSuggestion: (suggestionId: string) => Promise<void>;
  /** Resolves to the number of pending suggestions after the refresh. */
  onRefreshSuggestions: () => Promise<number>;
  onOpenExport: () => void;
  onOpenFile: (filePath: string) => void;
}

type TabType = 'all' | 'decision' | 'dead-end' | 'constraint';

export function ContextPanel({
  repoId,
  repoName,
  items,
  suggestions,
  isLoading,
  loadError,
  onReload,
  isOpen,
  draft,
  onDraftConsumed,
  onClose,
  onCreateItem,
  onApproveSuggestion,
  onDismissSuggestion,
  onRefreshSuggestions,
  onOpenExport,
  onOpenFile,
}: ContextPanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [showAddForm, setShowAddForm] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);

  // New item form state
  const [newType, setNewType] = useState<ContextType>('decision');
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newFiles, setNewFiles] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<{ text: string; isError: boolean } | null>(null);

  // Load a pre-filled draft into the form for the person to edit and confirm. Before paint,
  // so a form left open from an earlier draft never shows its old text for a frame.
  useLayoutEffect(() => {
    if (!draft || !isOpen) return;
    setNewType(draft.type);
    setNewTitle(draft.title);
    setNewBody(draft.body);
    setNewFiles(draft.files.join(', '));
    setSaveError(null);
    setShowAddForm(true);
    onDraftConsumed();
  }, [draft, isOpen, onDraftConsumed]);

  if (!isOpen) return null;

  // The repo rides on the URL, so an agent connected with it needs no repo id of its own.
  const mcpUrl =
    MCP_URL && repoId ? `${MCP_URL}${MCP_URL.includes('?') ? '&' : '?'}repoId=${encodeURIComponent(repoId)}` : MCP_URL;

  const handleCopyMcp = () => {
    if (!mcpUrl) return;
    navigator.clipboard.writeText(mcpUrl);
    setMcpCopied(true);
    setTimeout(() => setMcpCopied(false), 2000);
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newBody.trim() || isSaving) return;

    setIsSaving(true);
    setSaveError(null);
    try {
      await onCreateItem({
        type: newType,
        title: newTitle.trim(),
        body: newBody.trim(),
        files: parseFileList(newFiles),
      });
      setNewTitle('');
      setNewBody('');
      setNewFiles('');
      setShowAddForm(false);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshNote(null);
    try {
      const pending = await onRefreshSuggestions();
      setRefreshNote(
        pending === 0 ? { text: 'Nothing to suggest: no new changes since the indexed commit.', isError: false } : null,
      );
    } catch (err) {
      setRefreshNote({ text: errorMessage(err), isError: true });
    } finally {
      setIsRefreshing(false);
    }
  };

  const filteredItems = items.filter((item) => {
    if (activeTab === 'all') return true;
    return item.type === activeTab;
  });

  const pendingSuggestions = suggestions.filter((s) => s.status === 'pending');

  return (
    <div
      id="screen-context-drawer"
      className="fixed inset-y-0 right-0 z-40 w-full max-w-xl bg-neutral-950 border-l border-neutral-800 shadow-2xl flex flex-col font-mono animate-in slide-in-from-right duration-200"
    >
      {/* Drawer Header */}
      <div className="h-14 border-b border-neutral-800 px-4 flex items-center justify-between shrink-0 bg-neutral-900/70">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-400">
            SHARED REPOSITORY BRAIN
          </div>
          <h2 className="text-sm font-bold text-white uppercase tracking-wider">
            TEAM CONTEXT
          </h2>
          {repoName && <div className="text-[10px] text-neutral-400 truncate max-w-[260px]">{repoName}</div>}
        </div>

        <div className="flex items-center gap-2">
          <button
            id="btn-export-context"
            onClick={onOpenExport}
            className="px-2.5 py-1.5 border border-neutral-800 hover:border-neutral-700 bg-neutral-900 text-neutral-300 hover:text-white text-xs uppercase tracking-wider flex items-center gap-1.5 transition-colors cursor-pointer rounded-md"
            title="Export context to Markdown"
          >
            <FileDown className="w-3.5 h-3.5" />
            <span>EXPORT</span>
          </button>

          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-white transition-colors cursor-pointer rounded-md"
            title="Close drawer (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Action Bar: New Record button & Filter Tabs */}
      <div className="px-4 py-2.5 border-b border-neutral-850 bg-neutral-950 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1">
          {(['all', 'decision', 'dead-end', 'constraint'] as TabType[]).map((tab) => {
            const label =
              tab === 'all'
                ? 'ALL'
                : tab === 'decision'
                ? 'DECISIONS'
                : tab === 'dead-end'
                ? 'DEAD ENDS'
                : 'CONSTRAINTS';

            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-2 py-1 text-[11px] uppercase tracking-wider transition-colors cursor-pointer rounded ${
                  activeTab === tab
                    ? 'bg-neutral-800 text-white font-bold border-b border-neutral-400'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            title="Draft suggestions from the commits since this repo was indexed"
            className="px-2 py-1 bg-neutral-900 border border-neutral-700 hover:bg-neutral-800 text-amber-300 text-[11px] uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-colors rounded-md disabled:opacity-60 disabled:cursor-wait"
          >
            {isRefreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitPullRequestArrow className="w-3 h-3" />}
            <span>{isRefreshing ? 'READING DIFF…' : 'SUGGEST'}</span>
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-2 py-1 bg-neutral-900 border border-neutral-700 hover:bg-neutral-800 text-neutral-200 text-[11px] uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-colors rounded-md"
          >
            <Plus className="w-3 h-3" />
            <span>{showAddForm ? 'CANCEL' : 'RECORD'}</span>
          </button>
        </div>
      </div>

      {/* Drawer Content Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {refreshNote && (
          <div
            role={refreshNote.isError ? 'alert' : 'status'}
            className={`text-[11px] px-3 py-2 border rounded-lg ${
              refreshNote.isError
                ? 'text-red-300 bg-red-950/40 border-red-500/40'
                : 'text-neutral-300 bg-neutral-900/60 border-neutral-800'
            }`}
          >
            {refreshNote.text}
          </div>
        )}

        {/* Manual Record Form */}
        {showAddForm && (
          <form
            onSubmit={handleCreateSubmit}
            className="border border-neutral-700 bg-neutral-900/90 p-3.5 space-y-3 font-mono text-xs rounded-xl"
          >
            <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center justify-between">
              <span>RECORD REPOSITORY MEMORY</span>
            </div>

            <div>
              <label className="text-[10px] uppercase text-neutral-400 block mb-1">
                Category
              </label>
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as ContextType)}
                className="w-full bg-neutral-950 border border-neutral-700 px-2.5 py-1.5 text-neutral-200 text-xs rounded-lg"
              >
                <option value="decision">DECISION (Architectural choices)</option>
                <option value="dead-end">DEAD END (Tested & removed approaches)</option>
                <option value="constraint">CONSTRAINT (Strict rules & runtimes)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] uppercase text-neutral-400 block mb-1">
                Summary Title
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Keep API validation inside route middleware"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-700 px-2.5 py-1.5 text-neutral-200 text-xs placeholder:text-neutral-600 font-mono rounded-lg"
              />
            </div>

            <div>
              <label className="text-[10px] uppercase text-neutral-400 block mb-1">
                Context Details
              </label>
              <textarea
                required
                rows={3}
                placeholder="Why was this chosen? What failed before? What must agents remember?"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-700 px-2.5 py-1.5 text-neutral-200 text-xs placeholder:text-neutral-600 font-mono rounded-lg"
              />
            </div>

            <div>
              <label className="text-[10px] uppercase text-neutral-400 block mb-1">
                Relevant Files (Optional, comma-separated)
              </label>
              <input
                type="text"
                placeholder="src/routes/auth.ts, src/middleware/auth.ts"
                value={newFiles}
                onChange={(e) => setNewFiles(e.target.value)}
                className="w-full bg-neutral-950 border border-neutral-700 px-2.5 py-1.5 text-neutral-200 text-xs placeholder:text-neutral-600 font-mono rounded-lg"
              />
            </div>

            {saveError && (
              <div role="alert" className="text-[11px] text-red-300 bg-red-950/40 border border-red-500/40 px-2.5 py-1.5 rounded-lg">
                {saveError}
              </div>
            )}

            <button
              type="submit"
              disabled={isSaving}
              className="w-full py-2 bg-neutral-100 hover:bg-white text-neutral-950 font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer rounded-lg disabled:opacity-60 disabled:cursor-wait flex items-center justify-center gap-2"
            >
              {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isSaving ? 'SAVING…' : 'SAVE TO TEAM CONTEXT'}
            </button>
          </form>
        )}

        {/* Section 21: Git-aware Suggestions */}
        {pendingSuggestions.length > 0 && (
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-400 uppercase tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>PENDING SUGGESTIONS ({pendingSuggestions.length})</span>
            </div>
            {pendingSuggestions.map((sug) => (
              <SuggestionCard
                key={sug.id}
                suggestion={sug}
                onApprove={onApproveSuggestion}
                onDismiss={onDismissSuggestion}
              />
            ))}
          </div>
        )}

        {/* Section 22: Context Empty State */}
        {isLoading ? (
          <div className="space-y-3 animate-pulse">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border border-neutral-800 bg-neutral-900/40 p-3.5 rounded-xl space-y-2">
                <div className="h-3 w-20 bg-neutral-800 rounded" />
                <div className="h-3 w-2/3 bg-neutral-800 rounded" />
                <div className="h-10 w-full bg-neutral-900 rounded" />
              </div>
            ))}
          </div>
        ) : loadError ? (
          <ErrorState title="COULD NOT LOAD TEAM CONTEXT" reason={loadError} actionLabel="TRY AGAIN" onRetry={onReload} />
        ) : filteredItems.length === 0 ? (
          <EmptyState
            title="NO TEAM CONTEXT YET"
            description="Dune remembers decisions, failed approaches and constraints so the next engineer — or AI agent — doesn't repeat the same work."
            example="Passport.js was removed from auth."
            actionLabel="+ RECORD FIRST DECISION"
            onAction={() => setShowAddForm(true)}
          />
        ) : (
          <div className="space-y-3">
            <div className="text-[10px] uppercase tracking-widest text-neutral-400">
              RECORDED CONTEXT ({filteredItems.length})
            </div>
            {filteredItems.map((item) => (
              <ContextItemCard
                key={item.id}
                item={item}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        )}
      </div>

      {/* Section 24: MCP Integration — shown only once the MCP service is deployed */}
      {mcpUrl && (
      <div
        id="mcp-connection-section"
        className="border-t border-neutral-800 bg-neutral-900/60 p-4 shrink-0 font-mono text-xs"
      >
        <div className="flex items-center gap-2 text-white font-bold text-xs uppercase tracking-wider mb-1">
          <Server className="w-3.5 h-3.5 text-neutral-400" />
          <span>CONNECT AN AI AGENT</span>
        </div>

        <p className="text-[11px] text-neutral-400 leading-normal mb-2.5">
          Give your coding agent access to the same repository brain.
        </p>

        <div className="mb-2">
          <span className="text-[10px] text-neutral-400 uppercase tracking-wider block mb-1">
            MCP ENDPOINT
          </span>
          <div className="flex items-center gap-1.5 bg-neutral-950 border border-neutral-800 px-2.5 py-1.5 text-[11px] text-neutral-300 rounded-lg">
            <span className="truncate flex-1">{mcpUrl}</span>
            <button
              id="btn-copy-mcp"
              onClick={handleCopyMcp}
              className="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[10px] uppercase tracking-wider flex items-center gap-1 transition-colors cursor-pointer shrink-0 rounded"
            >
              {mcpCopied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span>COPIED</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  <span>COPY</span>
                </>
              )}
            </button>
          </div>
        </div>

        <div className="text-[10px] text-neutral-400 flex items-center justify-between">
          <span>Exposes: get_project_context • find_where_to_change • save_decision</span>
        </div>
      </div>
      )}
    </div>
  );
}
