/**
 * The only file in the indexer that talks to DynamoDB.
 *
 * The graph is stored packed and sharded from day one. A single item is capped at 400 KB
 * and a real repo's graph goes past that; discovering it on Saturday with a large repo is
 * the failure this avoids.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { GraphSchema, RepoMetaSchema } from '@dune/shared';
import type { Graph, RepoMeta } from '@dune/shared';

/** Comfortably inside the 400 KB item limit, leaving room for keys and attribute names. */
const MAX_SHARD_BYTES = 300_000;

/**
 * Shard keys are zero-padded so they sort in the order they were written. `GRAPH#10` sorts
 * before `GRAPH#2` without it, and the reassembled blob is then garbage.
 */
function shardKey(index: number): string {
  return `GRAPH#${String(index).padStart(4, '0')}`;
}

function client(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env['AWS_REGION'] ?? 'ap-south-1' }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}

function tableName(): string {
  return process.env['TABLE_NAME'] ?? 'dune';
}

export interface StoredGraphInfo {
  shardCount: number;
  packedBytes: number;
}

/** Extra attributes on the repo record that are not part of the public RepoMeta shape. */
export interface RepoRecordExtras {
  s3Prefix: string | null;
  graphShardCount: number;
  nodeCount: number;
  edgeCount: number;
  hiddenCount: number;
  sourceFileCount: number;
}

export async function putGraph(repoId: string, graph: Graph): Promise<StoredGraphInfo> {
  // Validated with the same schema the API will serve it through, so a shape problem
  // surfaces here rather than in the browser.
  const validated = GraphSchema.parse(graph);

  const packed = gzipSync(Buffer.from(JSON.stringify(validated), 'utf8'));
  const shardCount = Math.max(1, Math.ceil(packed.byteLength / MAX_SHARD_BYTES));
  const db = client();

  for (let index = 0; index < shardCount; index += 1) {
    const slice = packed.subarray(index * MAX_SHARD_BYTES, (index + 1) * MAX_SHARD_BYTES);
    await db.send(
      new PutCommand({
        TableName: tableName(),
        Item: {
          pk: `REPO#${repoId}`,
          sk: shardKey(index),
          part: index,
          encoding: 'gzip+json',
          data: new Uint8Array(slice),
        },
      }),
    );
  }

  await deleteStaleShards(db, repoId, shardCount);

  return { shardCount, packedBytes: packed.byteLength };
}

/** Re-indexing a repo overwrites it. A shorter graph must not leave old shards behind. */
async function deleteStaleShards(
  db: DynamoDBDocumentClient,
  repoId: string,
  keep: number,
): Promise<void> {
  const existing = await db.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `REPO#${repoId}`, ':prefix': 'GRAPH#' },
      ProjectionExpression: 'sk, part',
    }),
  );

  for (const item of existing.Items ?? []) {
    const part = item['part'];
    if (typeof part === 'number' && part >= keep) {
      await db.send(
        new DeleteCommand({
          TableName: tableName(),
          Key: { pk: `REPO#${repoId}`, sk: shardKey(part) },
        }),
      );
    }
  }
}

export async function getGraph(repoId: string): Promise<Graph | null> {
  const db = client();
  const result = await db.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `REPO#${repoId}`, ':prefix': 'GRAPH#' },
      // Shards are written in key order, so the query returns them in order.
      ScanIndexForward: true,
    }),
  );

  const items = result.Items ?? [];
  if (items.length === 0) return null;

  const parts = items.map((item) => Buffer.from(item['data'] as Uint8Array));
  const graph: unknown = JSON.parse(gunzipSync(Buffer.concat(parts)).toString('utf8'));
  return GraphSchema.parse(graph);
}

export async function putRepoMeta(meta: RepoMeta, extras: RepoRecordExtras): Promise<void> {
  const validated = RepoMetaSchema.parse(meta);

  await client().send(
    new PutCommand({
      TableName: tableName(),
      Item: {
        pk: `REPO#${validated.repoId}`,
        sk: 'META',
        ...validated,
        ...extras,
        status: 'ready',
      },
    }),
  );
}
