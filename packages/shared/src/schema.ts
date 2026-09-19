/**
 * zod schemas — the single validation layer, used in both directions.
 *
 * The same schema validates what Bedrock returns and what the API sends out. No
 * hand-written type guards anywhere in the codebase.
 *
 * Every schema carries `satisfies z.ZodType<T>` against its interface in `types.ts`,
 * so a schema that drifts from the contract fails the typecheck rather than a demo.
 *
 * Note: nothing here is `.optional()`. The contract says keys are never omitted, so a
 * value that may be absent is `.nullable()`, not optional. The only exceptions are
 * request fields with a contractual default (`teamId`, `fromSuggestionId`), where
 * `.default()` keeps the input lenient while the parsed output stays complete.
 */

import { z } from 'zod';

import type {
  Answer,
  ApiError,
  Candidate,
  ContextItem,
  ContextListResponse,
  CreateContextRequest,
  CreateRepoRequest,
  CreateRepoResponse,
  DismissSuggestionResponse,
  ExportResponse,
  FileContentResponse,
  Graph,
  GraphEdge,
  GraphNode,
  HealthResponse,
  JobStatus,
  QueryRequest,
  QueryResponse,
  RefreshSuggestionsRequest,
  RefreshSuggestionsResponse,
  RepoMeta,
  RepoStateResponse,
  Source,
  Suggestion,
} from './types';

/* ── Primitives ─────────────────────────────────────────────────────────────── */

const isoTimestamp = z.iso.datetime({ offset: true });
const lineNumber = z.number().int().nonnegative();
const repoPath = z.string().min(1);

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const ContextTypeSchema = z.enum(['decision', 'dead-end', 'constraint']);
export const AuthoredBySchema = z.enum(['human', 'agent']);
export const LanguageSchema = z.enum(['ts', 'tsx', 'js', 'jsx', 'py']);
export const JobStageSchema = z.enum([
  'queued',
  'cloning',
  'parsing',
  'embedding',
  'finalising',
  'ready',
  'failed',
]);

/* ── Core answer shape ──────────────────────────────────────────────────────── */

export const SourceSchema = z.object({
  file: repoPath,
  lines: z.tuple([lineNumber, lineNumber]),
}) satisfies z.ZodType<Source>;

export const CandidateSchema = z.object({
  file: repoPath,
  reason: z.string(),
}) satisfies z.ZodType<Candidate>;

/**
 * Also the tool input schema handed to Bedrock — the model fills this shape rather than
 * writing prose that gets parsed. See `docs/01-BACKEND.md`, "Schema enforcement".
 */
export const AnswerSchema = z.object({
  recommendedFile: repoPath.nullable(),
  attachTo: repoPath.nullable(),
  reason: z.string(),
  affected: z.array(z.string()),
  testsToUpdate: z.array(repoPath),
  sources: z.array(SourceSchema),
  confidence: ConfidenceSchema,
  candidates: z.array(CandidateSchema).nullable(),
}) satisfies z.ZodType<Answer>;

/* ── Graph ──────────────────────────────────────────────────────────────────── */

export const GraphNodeSchema = z.object({
  id: repoPath,
  label: z.string().min(1),
  cluster: z.string(),
  kind: z.enum(['entry', 'route', 'service', 'model', 'util']),
  entryPoint: z.boolean(),
  importedByCount: z.number().int().nonnegative(),
  importsCount: z.number().int().nonnegative(),
  x: z.number(),
  y: z.number(),
}) satisfies z.ZodType<GraphNode>;

export const GraphEdgeSchema = z.object({
  from: repoPath,
  to: repoPath,
  kind: z.literal('import'),
}) satisfies z.ZodType<GraphEdge>;

export const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  hiddenCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<Graph>;

/* ── Team context ───────────────────────────────────────────────────────────── */

export const ContextItemSchema = z.object({
  id: z.string().min(1),
  repoId: z.string().min(1),
  type: ContextTypeSchema,
  title: z.string().min(1),
  body: z.string(),
  files: z.array(repoPath),
  authoredBy: AuthoredBySchema,
  createdAt: isoTimestamp,
}) satisfies z.ZodType<ContextItem>;

export const SuggestionSchema = z.object({
  id: z.string().min(1),
  type: ContextTypeSchema,
  title: z.string().min(1),
  body: z.string(),
  files: z.array(repoPath),
  status: z.enum(['pending', 'saved', 'dismissed']),
  createdAt: isoTimestamp,
}) satisfies z.ZodType<Suggestion>;

/* ── Indexing job and repo ──────────────────────────────────────────────────── */

export const JobStatusSchema = z.object({
  repoId: z.string().min(1),
  jobId: z.string().min(1),
  stage: JobStageSchema,
  progress: z.number().int().min(0).max(100),
  detail: z.string().nullable(),
  failedStage: JobStageSchema.nullable(),
  failureReason: z.string().nullable(),
}) satisfies z.ZodType<JobStatus>;

export const RepoMetaSchema = z.object({
  repoId: z.string().min(1),
  repoUrl: z.string().min(1),
  name: z.string().min(1),
  commitSha: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  parseFailures: z.number().int().nonnegative(),
  indexedAt: isoTimestamp,
}) satisfies z.ZodType<RepoMeta>;

/* ── Errors ─────────────────────────────────────────────────────────────────── */

export const ErrorCodeSchema = z.enum([
  'INVALID_REPO_URL',
  'INVALID_REQUEST',
  'REPO_NOT_FOUND',
  'REPO_TOO_LARGE',
  'NO_SUPPORTED_FILES',
  'INDEX_NOT_READY',
  'INDEX_FAILED',
  'QUERY_FAILED',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL',
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
}) satisfies z.ZodType<ApiError>;

/* ── Request and response envelopes ─────────────────────────────────────────── */

/** No auth this weekend: `teamId` defaults to `demo` and everyone with the link shares it. */
/**
 * Ids that become part of a storage key are limited to a safe set, so no request can reach
 * another team's or repo's items by putting a `#` in one.
 */
export const KeyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'use letters, digits, - and _ only, up to 64 characters');

const teamId = KeyIdSchema.default('demo');

export const CreateRepoRequestSchema = z.object({
  repoUrl: z.string().min(1),
  teamId,
}) satisfies z.ZodType<CreateRepoRequest>;

export const CreateRepoResponseSchema = z.object({
  repoId: z.string().min(1),
  jobId: z.string().min(1),
  alreadyIndexed: z.boolean(),
}) satisfies z.ZodType<CreateRepoResponse>;

export const RepoStateResponseSchema = z.object({
  meta: RepoMetaSchema.nullable(),
  job: JobStatusSchema.nullable(),
  graph: GraphSchema.nullable(),
}) satisfies z.ZodType<RepoStateResponse>;

export const FileContentResponseSchema = z.object({
  path: repoPath,
  content: z.string(),
  lineCount: z.number().int().nonnegative(),
  language: LanguageSchema,
}) satisfies z.ZodType<FileContentResponse>;

export const QueryRequestSchema = z.object({
  repoId: KeyIdSchema,
  teamId,
  // Trimmed first, so a question of only whitespace is empty and rejected.
  question: z.string().trim().min(1),
}) satisfies z.ZodType<QueryRequest>;

export const QueryResponseSchema = z.object({
  answer: AnswerSchema,
  tookMs: z.number().int().nonnegative(),
}) satisfies z.ZodType<QueryResponse>;

export const ContextListResponseSchema = z.object({
  items: z.array(ContextItemSchema),
  suggestions: z.array(SuggestionSchema),
}) satisfies z.ZodType<ContextListResponse>;

export const CreateContextRequestSchema = z.object({
  repoId: KeyIdSchema,
  teamId,
  type: ContextTypeSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(5000),
  files: z.array(repoPath).max(50),
  fromSuggestionId: KeyIdSchema.nullable().default(null),
  authoredBy: AuthoredBySchema.default('human'),
}) satisfies z.ZodType<CreateContextRequest>;

/** POST /suggestions/:repoId/refresh. The body is optional; without it, `since` is null. */
export const RefreshSuggestionsRequestSchema = z.object({
  since: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'a commit SHA, 7 to 40 hex characters')
    .nullable()
    .default(null),
}) satisfies z.ZodType<RefreshSuggestionsRequest>;

export const RefreshSuggestionsResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema).max(5),
}) satisfies z.ZodType<RefreshSuggestionsResponse>;

export const DismissSuggestionResponseSchema = z.object({
  ok: z.boolean(),
}) satisfies z.ZodType<DismissSuggestionResponse>;

export const ExportResponseSchema = z.object({
  markdown: z.string(),
}) satisfies z.ZodType<ExportResponse>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
}) satisfies z.ZodType<HealthResponse>;
