/**
 * The only file in the indexer that talks to DynamoDB.
 *
 * The graph and the vectors are stored packed and sharded from day one. A single item is
 * capped at 400 KB and a real repo goes past that; discovering it on Saturday with a large
 * repo is the failure this avoids. Chunks are one item each, so retrieval can fetch just the
 * top-ranked ones with BatchGetItem.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { NativeAttributeValue } from '@aws-sdk/util-dynamodb';
import { ChunkSchema, GraphSchema, JobStatusSchema, RepoMetaSchema, RouteTableSchema } from '@dune/shared';
import type { Chunk, Graph, JobStatus, RepoMeta, RepoRecord, RouteEntry, RouteTable } from '@dune/shared';
import { z } from 'zod';

import { packVectors, unpackVectors } from './vectors';
import type { VectorSet } from './vectors';

type Item = Record<string, NativeAttributeValue>;

/** Comfortably inside the 400 KB item limit, leaving room for keys and attribute names. */
const MAX_SHARD_BYTES = 300_000;

/** DynamoDB's own batch limits. */
const BATCH_WRITE_LIMIT = 25;
const BATCH_GET_LIMIT = 100;

let sharedClient: DynamoDBDocumentClient | null = null;

/** One client per process, so a warm Lambda reuses its connections across requests. */
function client(): DynamoDBDocumentClient {
  sharedClient ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'ap-south-1' }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  return sharedClient;
}

function tableName(): string {
  return process.env['TABLE_NAME'] ?? 'dune';
}

const repoKey = (repoId: string): string => `REPO#${repoId}`;

/**
 * Shard keys are zero-padded so they sort in the order they were written. `GRAPH#10` sorts
 * before `GRAPH#2` without it, and the reassembled blob is then garbage.
 */
function shardKey(prefix: string, index: number): string {
  return `${prefix}#${String(index).padStart(4, '0')}`;
}

/** `CHUNK#{path}#{startLine}#{kind}` — the chunk id without its repo prefix. */
function chunkKey(chunk: Pick<Chunk, 'chunkId' | 'repoId'>): string {
  return `CHUNK#${chunk.chunkId.slice(chunk.repoId.length + 1)}`;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every item under a key prefix, following pagination. A query page stops at 1 MB. */
async function queryPrefix(
  db: DynamoDBDocumentClient,
  repoId: string,
  prefix: string,
  projection?: string,
): Promise<Item[]> {
  const items: Item[] = [];
  let startKey: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await db.send(
      new QueryCommand({
        TableName: tableName(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': repoKey(repoId), ':prefix': prefix },
        ScanIndexForward: true,
        ...(projection === undefined ? {} : { ProjectionExpression: projection }),
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);

  return items;
}

/** Writes and deletes in batches of 25, retrying whatever DynamoDB hands back unprocessed. */
async function batchWrite(
  db: DynamoDBDocumentClient,
  requests: ({ PutRequest: { Item: Item } } | { DeleteRequest: { Key: Item } })[],
): Promise<void> {
  for (let start = 0; start < requests.length; start += BATCH_WRITE_LIMIT) {
    let pending = requests.slice(start, start + BATCH_WRITE_LIMIT);

    for (let attempt = 0; pending.length > 0; attempt += 1) {
      if (attempt > 0) await pause(Math.min(2000, 100 * 2 ** attempt));
      if (attempt > 8) throw new Error('DynamoDB kept returning unprocessed items');

      const result = await db.send(
        new BatchWriteCommand({ RequestItems: { [tableName()]: pending } }),
      );
      pending = (result.UnprocessedItems?.[tableName()] ?? []) as typeof pending;
    }
  }
}

/**
 * Writes `bytes` as `{prefix}#0000…` shards, then removes shards left over from a previous,
 * larger write. Re-indexing overwrites; it never leaves stale data behind.
 */
async function writeShards(
  db: DynamoDBDocumentClient,
  repoId: string,
  prefix: string,
  bytes: Uint8Array,
  attributes: Item,
): Promise<number> {
  const shardCount = Math.max(1, Math.ceil(bytes.byteLength / MAX_SHARD_BYTES));

  for (let index = 0; index < shardCount; index += 1) {
    await db.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          pk: repoKey(repoId),
          sk: shardKey(prefix, index),
          part: index,
          ...attributes,
          data: bytes.slice(index * MAX_SHARD_BYTES, (index + 1) * MAX_SHARD_BYTES),
        },
      }),
    );
  }

  const existing = await queryPrefix(db, repoId, `${prefix}#`, 'sk, part');
  const stale = existing.filter((item) => typeof item['part'] === 'number' && item['part'] >= shardCount);
  await batchWrite(
    db,
    stale.map((item) => ({ DeleteRequest: { Key: { pk: repoKey(repoId), sk: item['sk'] } } })),
  );

  return shardCount;
}

/** Reassembles shards in key order. Null when nothing is stored under the prefix. */
async function readShards(db: DynamoDBDocumentClient, repoId: string, prefix: string): Promise<{
  bytes: Uint8Array;
  first: Item;
} | null> {
  const items = await queryPrefix(db, repoId, `${prefix}#`);
  const first = items[0];
  if (first === undefined) return null;

  const parts = items.map((item) => item['data'] as Uint8Array);
  return { bytes: Buffer.concat(parts), first };
}

/* ── Graph ──────────────────────────────────────────────────────────────────── */

export interface StoredShardsInfo {
  shardCount: number;
  bytes: number;
}

export async function putGraph(repoId: string, graph: Graph): Promise<StoredShardsInfo> {
  // Validated with the same schema the API will serve it through, so a shape problem
  // surfaces here rather than in the browser.
  const validated = GraphSchema.parse(graph);
  const packed = gzipSync(Buffer.from(JSON.stringify(validated), 'utf8'));

  const shardCount = await writeShards(client(), repoId, 'GRAPH', packed, { encoding: 'gzip+json' });
  return { shardCount, bytes: packed.byteLength };
}

export async function getGraph(repoId: string): Promise<Graph | null> {
  const stored = await readShards(client(), repoId, 'GRAPH');
  if (stored === null) return null;

  return GraphSchema.parse(JSON.parse(gunzipSync(stored.bytes).toString('utf8')));
}

/* ── Chunks ─────────────────────────────────────────────────────────────────── */

/** Writes every chunk, then deletes chunk items from a previous index that no longer exist. */
export async function putChunks(repoId: string, chunks: Chunk[]): Promise<void> {
  const db = client();
  const keep = new Set<string>();

  await batchWrite(
    db,
    chunks.map((chunk) => {
      const validated = ChunkSchema.parse(chunk);
      const sk = chunkKey(validated);
      keep.add(sk);
      return { PutRequest: { Item: { pk: repoKey(repoId), sk, ...validated } } };
    }),
  );

  const existing = await queryPrefix(db, repoId, 'CHUNK#', 'sk');
  await batchWrite(
    db,
    existing
      .filter((item) => !keep.has(String(item['sk'])))
      .map((item) => ({ DeleteRequest: { Key: { pk: repoKey(repoId), sk: item['sk'] } } })),
  );
}

/**
 * Fetches chunks by id, in the order asked for. Ids with no stored chunk are skipped, and
 * repeated ids are fetched once — BatchGetItem rejects a request with duplicate keys.
 */
export async function getChunks(repoId: string, chunkIds: string[]): Promise<Chunk[]> {
  const db = client();
  const found = new Map<string, Chunk>();
  const unique = [...new Set(chunkIds)];

  for (let start = 0; start < unique.length; start += BATCH_GET_LIMIT) {
    let keys: Item[] = unique
      .slice(start, start + BATCH_GET_LIMIT)
      .map((chunkId) => ({ pk: repoKey(repoId), sk: chunkKey({ chunkId, repoId }) }));

    for (let attempt = 0; keys.length > 0; attempt += 1) {
      if (attempt > 0) await pause(Math.min(2000, 100 * 2 ** attempt));
      if (attempt > 8) throw new Error('DynamoDB kept returning unprocessed keys');

      const result = await db.send(
        new BatchGetCommand({ RequestItems: { [tableName()]: { Keys: keys } } }),
      );
      for (const item of result.Responses?.[tableName()] ?? []) {
        const chunk = ChunkSchema.parse(item);
        found.set(chunk.chunkId, chunk);
      }
      keys = (result.UnprocessedKeys?.[tableName()]?.Keys ?? []) as Item[];
    }
  }

  return chunkIds.flatMap((chunkId) => {
    const chunk = found.get(chunkId);
    return chunk === undefined ? [] : [chunk];
  });
}

/* ── Vectors ────────────────────────────────────────────────────────────────── */

/**
 * The embedder id and dimension go on every shard as well as inside the blob, so what
 * produced a set is visible in the console without decoding anything.
 */
export async function putVectors(repoId: string, set: VectorSet): Promise<StoredShardsInfo> {
  const packed = packVectors(set);
  const shardCount = await writeShards(client(), repoId, 'VECTORS', packed, {
    encoding: 'dvec-v1',
    embedderId: set.header.embedderId,
    dimension: set.header.dimension,
    count: set.header.count,
  });
  return { shardCount, bytes: packed.byteLength };
}

export async function getVectorSet(repoId: string): Promise<VectorSet | null> {
  const stored = await readShards(client(), repoId, 'VECTORS');
  if (stored === null) return null;
  return unpackVectors(stored.bytes);
}

/* ── Routes ─────────────────────────────────────────────────────────────────── */

/**
 * Stored lists are capped so the item stays well inside 400 KB. Retrieval only uses the
 * table when it is under 50 entries, so a repo past this cap never needs the full list.
 */
const MAX_STORED_ROUTES = 500;

export async function putRoutes(repoId: string, routes: RouteEntry[]): Promise<void> {
  const table = RouteTableSchema.parse({
    count: routes.length,
    routes: routes.slice(0, MAX_STORED_ROUTES),
  });
  await client().send(
    new PutCommand({ TableName: tableName(), Item: { pk: repoKey(repoId), sk: 'ROUTES', ...table } }),
  );
}

export async function getRoutes(repoId: string): Promise<RouteTable> {
  const result = await client().send(
    new GetCommand({ TableName: tableName(), Key: { pk: repoKey(repoId), sk: 'ROUTES' } }),
  );
  // A repo indexed before route tables were stored simply has none.
  if (result.Item === undefined) return { count: 0, routes: [] };
  return RouteTableSchema.parse(result.Item);
}

/* ── Jobs ───────────────────────────────────────────────────────────────────── */

/** Job records expire after 7 days, which keeps the table clean without a cleanup job. */
const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `job_` + the start time in base 36 + a random tail. The time part is fixed-width until
 * 2059, so job keys sort by start time and the latest job is one query.
 */
export function newJobId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export interface StoredJob {
  status: JobStatus;
  updatedAt: string;
}

export async function putJob(status: JobStatus): Promise<void> {
  const validated = JobStatusSchema.parse(status);
  await client().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: repoKey(validated.repoId),
        sk: `JOB#${validated.jobId}`,
        ...validated,
        updatedAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
      },
    }),
  );
}

export async function getLatestJob(repoId: string): Promise<StoredJob | null> {
  const result = await client().send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': repoKey(repoId), ':prefix': 'JOB#' },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  if (item === undefined) return null;
  return { status: JobStatusSchema.parse(item), updatedAt: String(item['updatedAt'] ?? '') };
}

/* ── Repo record ────────────────────────────────────────────────────────────── */

const RepoRecordExtrasSchema = z.object({
  status: z.literal('ready'),
  // Absent on repos indexed before jobs existed, or by the local runner.
  jobId: z.string().nullable().default(null),
  embedderId: z.string().min(1),
  embeddingDimension: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
});

/** Null when the repo has never been indexed, or was indexed before step 3 stored vectors. */
export async function getRepoRecord(repoId: string): Promise<RepoRecord | null> {
  const result = await client().send(
    new GetCommand({ TableName: tableName(), Key: { pk: repoKey(repoId), sk: 'META' } }),
  );
  if (result.Item === undefined) return null;

  const extras = RepoRecordExtrasSchema.safeParse(result.Item);
  if (!extras.success) return null;

  return { meta: RepoMetaSchema.parse(result.Item), ...extras.data };
}

/** Extra attributes on the repo record that are not part of the public RepoMeta shape. */
export interface RepoRecordExtras {
  /** The job that produced this index; null from the local runner. */
  jobId: string | null;
  s3Prefix: string | null;
  graphShardCount: number;
  nodeCount: number;
  edgeCount: number;
  hiddenCount: number;
  sourceFileCount: number;
  chunkCount: number;
  embedFailures: number;
  embedderId: string;
  embeddingDimension: number;
  vectorShardCount: number;
}

export async function putRepoMeta(meta: RepoMeta, extras: RepoRecordExtras): Promise<void> {
  const validated = RepoMetaSchema.parse(meta);

  await client().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: repoKey(validated.repoId),
        sk: 'META',
        ...validated,
        ...extras,
        status: 'ready',
      },
    }),
  );
}
