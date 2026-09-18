/**
 * Shared types. The source of truth is `docs/03-API.md`; this file and that doc must
 * agree, and if they drift they are fixed in the same commit.
 *
 * Two rules from the contract are encoded structurally here, so read them before editing:
 *
 * - **Never omit a key.** Unknown or not-applicable values are `null`, never absent.
 *   That is why nothing below is optional (`?:`) — a missing key crashes the UI mid-demo,
 *   a null renders as a dash.
 * - **Arrays are never null.** An empty array is `[]`.
 */

/* ── Core answer shape ──────────────────────────────────────────────────────── */

export type Confidence = 'high' | 'medium' | 'low';

export interface Source {
  file: string;
  lines: [number, number];
}

export interface Answer {
  recommendedFile: string | null;
  attachTo: string | null;
  reason: string;
  affected: string[];
  testsToUpdate: string[];
  sources: Source[];
  confidence: Confidence;
  candidates: Candidate[] | null; // populated when confidence is low
}

export interface Candidate {
  file: string;
  reason: string;
}

/* ── Graph ──────────────────────────────────────────────────────────────────── */

export interface GraphNode {
  id: string; // repo-relative path, also the display key
  label: string; // filename only
  cluster: string; // top-level directory, for grouping and colour
  kind: 'entry' | 'route' | 'service' | 'model' | 'util';
  entryPoint: boolean;
  importedByCount: number;
  importsCount: number;
  x: number; // pre-computed layout, frontend never lays out
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'import';
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  hiddenCount: number; // isolated nodes not included
}

/* ── Team context ───────────────────────────────────────────────────────────── */

export type ContextType = 'decision' | 'dead-end' | 'constraint';

export interface ContextItem {
  id: string;
  repoId: string;
  type: ContextType;
  title: string;
  body: string;
  files: string[];
  authoredBy: 'human' | 'agent'; // agent-written items are badged in the UI
  createdAt: string;
}

export interface Suggestion {
  id: string;
  type: ContextType;
  title: string;
  body: string; // editable draft text
  files: string[];
  status: 'pending' | 'saved' | 'dismissed';
  createdAt: string;
}

/* ── Indexing job and repo ──────────────────────────────────────────────────── */

export type JobStage =
  | 'queued'
  | 'cloning'
  | 'parsing'
  | 'embedding'
  | 'finalising'
  | 'ready'
  | 'failed';

export interface JobStatus {
  repoId: string;
  jobId: string;
  stage: JobStage;
  progress: number; // 0 to 100
  detail: string | null; // "1,204 / 2,180 chunks"
  failedStage: JobStage | null;
  failureReason: string | null; // human sentence
}

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  name: string; // "owner/repo"
  commitSha: string;
  fileCount: number;
  lineCount: number;
  truncated: boolean;
  parseFailures: number;
  indexedAt: string;
}

/* ── Errors ─────────────────────────────────────────────────────────────────── */

/**
 * `retryable` drives whether the UI shows a retry button. The frontend does not decide
 * this; the backend states it. `message` is written for a human and is rendered directly.
 */
export type ErrorCode =
  | 'INVALID_REPO_URL'
  | 'REPO_NOT_FOUND'
  | 'REPO_TOO_LARGE'
  | 'NO_SUPPORTED_FILES'
  | 'INDEX_NOT_READY'
  | 'INDEX_FAILED'
  | 'QUERY_FAILED'
  | 'MODEL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

/* ── Request and response envelopes ─────────────────────────────────────────── */

export type Language = 'ts' | 'tsx' | 'js' | 'jsx';

/** POST /repos */
export interface CreateRepoRequest {
  repoUrl: string;
  teamId: string;
}

/** POST /repos -> 202 */
export interface CreateRepoResponse {
  repoId: string;
  jobId: string;
  alreadyIndexed: boolean;
}

/** GET /repos/:repoId -> 200. All three keys are always present; nulls while indexing. */
export interface RepoStateResponse {
  meta: RepoMeta | null;
  job: JobStatus | null;
  graph: Graph | null;
}

/** GET /repos/:repoId/files/* -> 200 */
export interface FileContentResponse {
  path: string;
  content: string;
  lineCount: number;
  language: Language;
}

/** POST /query */
export interface QueryRequest {
  repoId: string;
  teamId: string;
  question: string;
}

/** POST /query -> 200. `tookMs` is real and is shown in the UI. */
export interface QueryResponse {
  answer: Answer;
  tookMs: number;
}

/** GET /context/:repoId -> 200. Items newest first; only pending suggestions. */
export interface ContextListResponse {
  items: ContextItem[];
  suggestions: Suggestion[];
}

/** POST /context. `fromSuggestionId` marks that suggestion saved in the same write. */
export interface CreateContextRequest {
  repoId: string;
  teamId: string;
  type: ContextType;
  title: string;
  body: string;
  files: string[];
  fromSuggestionId: string | null;
  authoredBy: 'human' | 'agent';
}

/** POST /suggestions/:repoId/refresh -> 200. Capped at 5. */
export interface RefreshSuggestionsResponse {
  suggestions: Suggestion[];
}

/** POST /suggestions/:id/dismiss -> 200 */
export interface DismissSuggestionResponse {
  ok: boolean;
}

/** GET /export/:repoId -> 200 */
export interface ExportResponse {
  markdown: string;
}

/** GET /v1/health -> 200. Not part of the public contract; deploy and wiring check. */
export interface HealthResponse {
  ok: boolean;
}
