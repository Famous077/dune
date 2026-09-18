/**
 * Backend-internal storage shapes, shared by the indexer (which writes them) and the API
 * (which reads them at query time). These are not part of the public contract in
 * `docs/03-API.md`; nothing here is ever sent to the frontend.
 */

import { z } from 'zod';

import type { RepoMeta } from './types';

export type ChunkKind = 'file-summary' | 'declaration' | 'module';

/**
 * One retrievable unit of code. Chunks follow declaration boundaries, not fixed windows —
 * a function split across two chunks retrieves badly. The vector is stored separately, in
 * the packed per-repo set, so loading every vector for a query is one read, not thousands.
 */
export interface Chunk {
  /** `${repoId}#${path}#${startLine}#${kind}` — the kind keeps a file summary and a module chunk that both start on line 1 apart. */
  chunkId: string;
  repoId: string;
  path: string;
  kind: ChunkKind;
  /** The declaration's name; null for file summaries and module-level code. */
  symbolName: string | null;
  startLine: number;
  endLine: number;
  /** [part, of] when a declaration over the token cap was split; otherwise null. */
  part: [number, number] | null;
  content: string;
}

/**
 * What produced a stored vector set. Vectors from different embedders, or the same model at
 * a different dimension, live in incompatible spaces: cosine similarity across them returns
 * numbers that look fine and mean nothing. Every set carries this so a mismatch is refused
 * rather than computed.
 */
export interface EmbeddingSetHeader {
  embedderId: string;
  dimension: number;
  count: number;
  /** Row i of the vector blob belongs to chunkIds[i]. */
  chunkIds: string[];
}

/** One route registration: `router.post('/login', …)` in a file. */
export interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
}

/**
 * Every route registration in the repo, stored once per index. Retrieval includes the whole
 * table in the prompt when it is small: most "where do I add X" questions are about request
 * paths, and a short route list answers them better than any similarity search.
 */
export interface RouteTable {
  /** The real total, which can exceed `routes.length` when the stored list is capped. */
  count: number;
  routes: RouteEntry[];
}

/** The repo record as retrieval needs it: the public meta plus what the index recorded. */
export interface RepoRecord {
  meta: RepoMeta;
  status: 'ready';
  /** The job that produced this index, or null when it was built by the local runner. */
  jobId: string | null;
  embedderId: string;
  embeddingDimension: number;
  chunkCount: number;
}

export const ChunkKindSchema = z.enum(['file-summary', 'declaration', 'module']);

export const RouteEntrySchema = z.object({
  method: z.string(),
  path: z.string(),
  file: z.string().min(1),
  line: z.number().int().positive(),
}) satisfies z.ZodType<RouteEntry>;

export const RouteTableSchema = z.object({
  count: z.number().int().nonnegative(),
  routes: z.array(RouteEntrySchema),
}) satisfies z.ZodType<RouteTable>;

export const ChunkSchema = z.object({
  chunkId: z.string().min(1),
  repoId: z.string().min(1),
  path: z.string().min(1),
  kind: ChunkKindSchema,
  symbolName: z.string().nullable(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  part: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable(),
  content: z.string(),
}) satisfies z.ZodType<Chunk>;

export const EmbeddingSetHeaderSchema = z
  .object({
    embedderId: z.string().min(1),
    dimension: z.number().int().positive(),
    count: z.number().int().nonnegative(),
    chunkIds: z.array(z.string().min(1)),
  })
  .refine((header) => header.chunkIds.length === header.count, {
    message: 'chunkIds must have one entry per vector',
  }) satisfies z.ZodType<EmbeddingSetHeader>;
