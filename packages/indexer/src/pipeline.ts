/**
 * The indexing pipeline, in one process: clone → parse → graph → chunk → embed → store.
 *
 * The design in `docs/01-BACKEND.md` runs these as Step Functions states. For the weekend
 * they run here instead, in sequence, called by the local runner and by IndexFn alike, so
 * both exercise exactly the same code. Progress goes to a reporter at each stage — the job
 * record the progress screen polls, or nothing when run locally.
 */

import type { Chunk, Graph, JobStage } from '@dune/shared';

import { chunkRepo } from './chunk';
import { clone } from './clone';
import type { CloneResult } from './clone';
import { createEmbedder, embedChunks } from './embed';
import type { EmbedResult } from './embed';
import { buildGraph } from './graph';
import type { GraphStats } from './graph';
import {
  getGraph,
  getVectorSet,
  putChunks,
  putGraph,
  putRepoMeta,
  putRoutes,
  putVectors,
} from './lib/db';
import { IndexerError } from './lib/errors';
import { parseRepo } from './parse';
import type { ParseResult } from './parse';

/** Where each stage starts on the 0–100 bar. Embedding owns most of it; it is the slow part. */
const PROGRESS: Record<Exclude<JobStage, 'queued' | 'failed'>, number> = {
  cloning: 5,
  parsing: 20,
  embedding: 35,
  finalising: 92,
  ready: 100,
};

/** Embedding progress is written at most this often, not once per batch. */
const PROGRESS_INTERVAL_MS = 1500;

export type Reporter = (stage: JobStage, progress: number, detail: string | null) => Promise<void>;

export interface IndexOptions {
  repoUrl: string;
  workDir: string;
  /** S3 bucket for the snapshot; null writes nothing to S3 or DynamoDB (a dry run). */
  bucket: string | null;
  region: string;
  /** The job this run belongs to, recorded on the repo record. Null from the local runner. */
  jobId: string | null;
  report: Reporter;
  /** Human-readable progress lines: the terminal locally, CloudWatch in Lambda. */
  log: (name: string, detail: string) => void;
}

export interface IndexSummary {
  cloned: CloneResult;
  parsed: ParseResult;
  graph: Graph;
  stats: GraphStats;
  chunks: Chunk[];
  embedded: EmbedResult;
  lineCount: number;
}

const seconds = (from: number): string => `${((Date.now() - from) / 1000).toFixed(1)}s`;

export async function indexRepository(options: IndexOptions): Promise<IndexSummary> {
  const { report, log } = options;
  const write = options.bucket !== null;

  /* Clone ------------------------------------------------------------------ */
  await report('cloning', PROGRESS.cloning, null);
  const cloneStarted = Date.now();
  const cloned = await clone({
    repoUrl: options.repoUrl,
    workDir: options.workDir,
    bucket: options.bucket,
    region: options.region,
  });

  const sourceFiles = cloned.files.filter((file) => file.parse);
  log('cloning', `${cloned.name} @ ${cloned.commitSha.slice(0, 7)} (repoId ${cloned.repoId}): ${cloned.fileCount} files kept, ${sourceFiles.length} to parse · skipped ${cloned.skipped.excludedDir} in excluded dirs, ${cloned.skipped.envFile} env, ${cloned.skipped.tooLarge} over 500 KB · ${seconds(cloneStarted)}`);
  if (cloned.s3Prefix !== null) log('uploading', `${cloned.uploaded} files to ${cloned.s3Prefix}`);
  if (cloned.truncated) log('truncated', 'more source files than the parse cap; the overflow was not parsed');

  /* Parse ------------------------------------------------------------------ */
  await report('parsing', PROGRESS.parsing, `${sourceFiles.length.toLocaleString()} files`);
  const parseStarted = Date.now();
  const parsed = await parseRepo({
    rootDir: options.workDir,
    files: sourceFiles.map((file) => file.path),
    allFiles: cloned.files.map((file) => file.path),
  });
  log('parsing', `${parsed.files.length} parsed, ${parsed.failures.length} failed, ${parsed.syntaxErrors.length} with syntax errors · ${seconds(parseStarted)}`);
  for (const failure of parsed.failures) log('', `! ${failure.path}: ${failure.reason}`);

  const routeList = parsed.files.flatMap((file) =>
    file.routes.map((route) => ({ method: route.method, path: route.path, file: file.path, line: route.line })),
  );
  log('routes', routeList.length === 0 ? 'none found' : `${routeList.length}: ${routeList.map((route) => `${route.method.toUpperCase()} ${route.path}`).join(', ')}`);

  /* Graph ------------------------------------------------------------------ */
  const { graph, stats } = buildGraph(parsed.files);
  log('graph', `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.hiddenCount} isolated files hidden`);
  log('', `${stats.externalImports} external imports ignored, ${stats.droppedEdges} edges to non-module files dropped`);

  /* Chunk ------------------------------------------------------------------ */
  const chunks = await chunkRepo({ repoId: cloned.repoId, rootDir: options.workDir, files: parsed.files });
  const byKind = (kind: string): number => chunks.filter((chunk) => chunk.kind === kind).length;
  log('chunking', `${chunks.length} chunks: ${byKind('file-summary')} file summaries, ${byKind('declaration')} declarations, ${byKind('module')} module · ${chunks.filter((chunk) => chunk.part !== null).length} split parts`);

  /* Embed ------------------------------------------------------------------ */
  const span = PROGRESS.finalising - PROGRESS.embedding;
  await report('embedding', PROGRESS.embedding, `0 / ${chunks.length.toLocaleString()} chunks`);
  const embedStarted = Date.now();
  const embedder = createEmbedder();
  let lastReport = 0;
  const embedded = await embedChunks(chunks, embedder, 32, async (done, total) => {
    if (done < total && Date.now() - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = Date.now();
    await report(
      'embedding',
      PROGRESS.embedding + Math.floor((span * done) / Math.max(1, total)),
      `${done.toLocaleString()} / ${total.toLocaleString()} chunks`,
    );
  });
  log('embedding', `${embedded.header.count} vectors × ${embedder.dimension} dims with ${embedder.id}, ${embedded.failed.length} failed · ${seconds(embedStarted)}`);

  const lineCount = parsed.files.reduce((total, file) => total + file.lineCount, 0);

  /* Store ------------------------------------------------------------------ */
  await report('finalising', PROGRESS.finalising, null);
  if (write) {
    const storedGraph = await putGraph(cloned.repoId, graph);
    // Chunks before vectors: a vector set must never point at chunks that are not there.
    await putChunks(cloned.repoId, chunks);
    const storedVectors = await putVectors(cloned.repoId, embedded);
    await putRoutes(cloned.repoId, routeList);
    // The repo record last: it is what marks the index ready, so it only exists once every
    // other part of the index does.
    await putRepoMeta(
      {
        repoId: cloned.repoId,
        repoUrl: cloned.repoUrl,
        name: cloned.name,
        commitSha: cloned.commitSha,
        fileCount: cloned.fileCount,
        lineCount,
        truncated: cloned.truncated,
        parseFailures: parsed.failures.length,
        indexedAt: new Date().toISOString(),
      },
      {
        jobId: options.jobId,
        s3Prefix: cloned.s3Prefix,
        graphShardCount: storedGraph.shardCount,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        hiddenCount: graph.hiddenCount,
        sourceFileCount: sourceFiles.length,
        chunkCount: chunks.length,
        embedFailures: embedded.failed.length,
        embedderId: embedded.header.embedderId,
        embeddingDimension: embedded.header.dimension,
        vectorShardCount: storedVectors.shardCount,
      },
    );
    log('stored', `graph ${storedGraph.shardCount} shard(s), ${(storedGraph.bytes / 1024).toFixed(1)} KB · ${chunks.length} chunk items · vectors ${storedVectors.shardCount} shard(s), ${(storedVectors.bytes / 1024).toFixed(1)} KB · repo record`);

    // Read it straight back, so "it is in DynamoDB" is proven rather than assumed.
    const readBack = await getGraph(cloned.repoId);
    const vectorsBack = await getVectorSet(cloned.repoId);
    if (readBack === null || vectorsBack === null) {
      throw new IndexerError('INDEX_FAILED', 'The index was written but could not be read back. Try indexing again.');
    }
    log('verified', `read back ${readBack.nodes.length} nodes, ${readBack.edges.length} edges, ${vectorsBack.header.count} vectors`);
  }

  await report('ready', PROGRESS.ready, null);
  return { cloned, parsed, graph, stats, chunks, embedded, lineCount };
}
