/**
 * Pipeline step 4 — Embed.
 *
 * Embedding sits behind the `Embedder` interface. `LocalEmbedder` is the default and needs
 * no model access; `TitanEmbedder` is the Bedrock path, for when access arrives. `EMBEDDER`
 * selects one: `local` (default) or `titan`.
 *
 * The two produce vectors of different dimension in different spaces, so every stored set
 * records which embedder made it, and `assertCompatible` refuses a mismatch.
 */

import type { Chunk, EmbeddingSetHeader } from '@dune/shared';

import { LocalEmbedder } from './embedders/local';
import { TitanEmbedder } from './embedders/titan';
import { IndexerError } from './lib/errors';

export interface Embedder {
  /** Names the model, e.g. `local:Xenova/all-MiniLM-L6-v2`. Stored with every vector set. */
  readonly id: string;
  readonly dimension: number;
  /** One vector per text, in order, each of length `dimension`. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbedderKind = 'local' | 'titan';

export function createEmbedder(kind: string = process.env['EMBEDDER'] ?? 'local'): Embedder {
  switch (kind) {
    case 'local':
      return new LocalEmbedder();
    case 'titan':
      return new TitanEmbedder({
        region: process.env['AWS_REGION'] ?? 'ap-south-1',
        modelId: process.env['BEDROCK_EMBED_MODEL_ID'] ?? 'amazon.titan-embed-text-v2:0',
      });
    default:
      throw new IndexerError(
        'INTERNAL',
        `EMBEDDER is set to "${kind}", which is not an embedder. Use "local" or "titan".`,
      );
  }
}

/**
 * What actually gets embedded: the chunk prefixed with its path and symbol name.
 * `src/routes/auth.ts :: loginHandler` followed by the source retrieves noticeably better
 * than bare source, because path tokens carry real signal for "where" questions.
 */
export function embeddingText(chunk: Chunk): string {
  const part = chunk.part === null ? '' : ` (part ${chunk.part[0]} of ${chunk.part[1]})`;
  const label = chunk.symbolName ?? (chunk.kind === 'module' ? 'module code' : 'file summary');
  return `${chunk.path} :: ${label}${part}\n${chunk.content}`;
}

/** Refuses to compare vectors across embedders. The message says how to fix it. */
export function assertCompatible(header: EmbeddingSetHeader, embedder: Embedder): void {
  if (header.embedderId === embedder.id && header.dimension === embedder.dimension) return;

  throw new IndexerError(
    'INDEX_NOT_READY',
    `This repo was indexed with ${header.embedderId} (${header.dimension} dimensions), but the current embedder is ${embedder.id} (${embedder.dimension} dimensions). Their vectors are not comparable. Re-index the repo, or set EMBEDDER to match.`,
  );
}

export interface EmbedResult {
  header: EmbeddingSetHeader;
  /** count × dimension, row-major, row i for header.chunkIds[i]. */
  vectors: Float32Array;
  /** Chunks whose batch failed. They are left out of the set, not fatal to the index. */
  failed: string[];
}

export async function embedChunks(
  chunks: Chunk[],
  embedder: Embedder,
  batchSize = 32,
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<EmbedResult> {
  const embeddedIds: string[] = [];
  const rows: Float32Array[] = [];
  const failed: string[] = [];

  for (let start = 0; start < chunks.length; start += batchSize) {
    const batch = chunks.slice(start, start + batchSize);
    try {
      const vectors = await embedder.embed(batch.map(embeddingText));
      if (vectors.length !== batch.length) {
        throw new Error(`expected ${batch.length} vectors, got ${vectors.length}`);
      }
      batch.forEach((chunk, index) => {
        const vector = vectors[index];
        if (vector === undefined || vector.length !== embedder.dimension) {
          throw new Error(`vector for ${chunk.chunkId} has the wrong dimension`);
        }
        embeddedIds.push(chunk.chunkId);
        rows.push(vector);
      });
    } catch (err) {
      // An unavailable model fails every batch the same way; stop rather than repeat it.
      if (err instanceof IndexerError && err.code === 'MODEL_UNAVAILABLE') throw err;

      // One bad batch does not fail the index. Log it and continue.
      console.error(`embed: batch at ${start} failed:`, err instanceof Error ? err.message : err);
      failed.push(...batch.map((chunk) => chunk.chunkId));
    }
    await onProgress?.(Math.min(start + batchSize, chunks.length), chunks.length);
  }

  const vectors = new Float32Array(rows.length * embedder.dimension);
  rows.forEach((row, index) => vectors.set(row, index * embedder.dimension));

  return {
    header: {
      embedderId: embedder.id,
      dimension: embedder.dimension,
      count: embeddedIds.length,
      chunkIds: embeddedIds,
    },
    vectors,
    failed,
  };
}
