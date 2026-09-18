/**
 * The Dune HTTP API, as the MCP server sees it. The same endpoints the web app calls, with the
 * same error envelope (docs/03-API.md). No logic lives here that the API does not already own.
 */
import type {
  ApiError,
  ContextItem,
  CreateContextRequest,
  ErrorCode,
  ExportResponse,
  QueryRequest,
  QueryResponse,
  RepoStateResponse,
} from '@dune/shared/types';

/** Queries can take up to the API Gateway limit; leave a little room above it. */
const TIMEOUT_MS = 35_000;

export class DuneApiError extends Error {
  constructor(
    public readonly code: ErrorCode | 'NETWORK',
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DuneApiError';
  }
}

async function request<T>(root: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${root}/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new DuneApiError('NETWORK', 'Could not reach the Dune API. Try again.', true);
  }

  const payload = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const envelope = (payload as Partial<ApiError> | null)?.error;
    if (envelope && typeof envelope.message === 'string') {
      throw new DuneApiError(envelope.code, envelope.message, envelope.retryable);
    }
    throw new DuneApiError('INTERNAL', `The Dune API returned HTTP ${res.status}. Try again.`, true);
  }
  return payload as T;
}

const team = (teamId: string) => `teamId=${encodeURIComponent(teamId)}`;

/** `apiUrl` is the stack's ApiUrl output, with or without a trailing /v1. */
export function createApiClient(apiUrl: string) {
  const root = apiUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return {
    repoState: (repoId: string) => request<RepoStateResponse>(root, `/repos/${encodeURIComponent(repoId)}`),

    exportContext: (repoId: string, teamId: string) =>
      request<ExportResponse>(root, `/export/${encodeURIComponent(repoId)}?${team(teamId)}`),

    query: (input: QueryRequest) => request<QueryResponse>(root, '/query', input),

    createContext: (input: CreateContextRequest) => request<ContextItem>(root, '/context', input),
  };
}

export type DuneApi = ReturnType<typeof createApiClient>;
