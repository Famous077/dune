import type {
  ContextItem,
  ContextListResponse,
  CreateContextRequest,
  DismissSuggestionResponse,
  ExportResponse,
  RefreshSuggestionsResponse,
} from '@dune/shared/types';
import { TEAM_ID, isMockMode, request, withTeam } from './client';
import * as mock from './mock';

/** GET /context/:repoId — saved items, newest first, and the pending suggestions. */
export function getContext(repoId: string): Promise<ContextListResponse> {
  if (isMockMode()) return mock.getContext(repoId);
  return request(withTeam(`/context/${encodeURIComponent(repoId)}`));
}

/** The fields a person fills in; the rest of the request is fixed by who is asking. */
export interface ContextDraft {
  type: CreateContextRequest['type'];
  title: string;
  body: string;
  files: string[];
}

/**
 * POST /context, always as a human: this is the console, and agents write through MCP.
 * With `fromSuggestionId`, that suggestion is marked saved in the same write.
 */
export function createContextItem(
  repoId: string,
  draft: ContextDraft,
  fromSuggestionId: string | null = null,
): Promise<ContextItem> {
  const body: CreateContextRequest = {
    repoId,
    teamId: TEAM_ID,
    ...draft,
    fromSuggestionId,
    authoredBy: 'human',
  };
  if (isMockMode()) return mock.createContextItem(body);
  return request('/context', { method: 'POST', body });
}

/** POST /suggestions/:repoId/refresh — drafts from the diff since the indexed commit. */
export function refreshSuggestions(repoId: string): Promise<RefreshSuggestionsResponse> {
  if (isMockMode()) return mock.refreshSuggestions(repoId);
  return request(withTeam(`/suggestions/${encodeURIComponent(repoId)}/refresh`), { method: 'POST' });
}

/** POST /suggestions/:id/dismiss — marked, never deleted, never suggested again. */
export function dismissSuggestion(suggestionId: string): Promise<DismissSuggestionResponse> {
  if (isMockMode()) return mock.dismissSuggestion(suggestionId);
  return request(withTeam(`/suggestions/${encodeURIComponent(suggestionId)}/dismiss`), { method: 'POST' });
}

/** GET /export/:repoId — markdown written by the backend, ready to paste into an agent. */
export function getExport(repoId: string): Promise<ExportResponse> {
  if (isMockMode()) return mock.getExport(repoId);
  return request(withTeam(`/export/${encodeURIComponent(repoId)}`));
}
