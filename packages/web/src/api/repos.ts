import type {
  CreateRepoRequest,
  CreateRepoResponse,
  FileContentResponse,
  RepoStateResponse,
} from '@dune/shared/types';
import { TEAM_ID, isMockMode, request } from './client';
import * as mock from './mock';

/** POST /repos. `alreadyIndexed` means skip the progress screen and go straight to the map. */
export function createRepo(repoUrl: string): Promise<CreateRepoResponse> {
  if (isMockMode()) return mock.createRepo(repoUrl);
  const body: CreateRepoRequest = { repoUrl, teamId: TEAM_ID };
  return request('/repos', { method: 'POST', body });
}

/**
 * GET /repos/:repoId — the job while indexing, then meta and graph once ready. A failed
 * job is still a 200: the failure is in `job`, not in the HTTP status.
 */
export function getRepoState(repoId: string): Promise<RepoStateResponse> {
  if (isMockMode()) return mock.getRepoState(repoId);
  return request(`/repos/${encodeURIComponent(repoId)}`);
}

/** GET /repos/:repoId/files/* — NOT_FOUND when the path is not in the indexed set. */
export function getFile(repoId: string, path: string): Promise<FileContentResponse> {
  if (isMockMode()) return mock.getFile(repoId, path);
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return request(`/repos/${encodeURIComponent(repoId)}/files/${encoded}`);
}
