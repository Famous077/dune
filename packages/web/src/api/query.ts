import type { QueryRequest, QueryResponse } from '@dune/shared/types';
import { TEAM_ID, isMockMode, request } from './client';
import * as mock from './mock';

/** POST /query. `tookMs` is the server's own measurement and is shown with the answer. */
export function askQuestion(repoId: string, question: string): Promise<QueryResponse> {
  if (isMockMode()) return mock.askQuestion(repoId, question);
  const body: QueryRequest = { repoId, teamId: TEAM_ID, question };
  return request('/query', { method: 'POST', body });
}
