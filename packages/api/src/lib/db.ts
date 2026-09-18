/**
 * The only file in the API package that talks to DynamoDB. Handlers call functions here;
 * they never touch the SDK directly.
 *
 * Single table, keyed `pk` / `sk`, per the key layout in `docs/01-BACKEND.md`.
 *
 * Reads of what the indexer wrote — the repo record, graph, chunks, vectors and routes —
 * come from the indexer's storage module rather than being written a second time here.
 * The shard layout and the packed vector format exist once; two copies would drift.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ContextItemSchema, SuggestionSchema } from '@dune/shared';
import type { ContextItem, Suggestion } from '@dune/shared';

export {
  getChunks,
  getGraph,
  getLatestJob,
  getRepoRecord,
  getRoutes,
  getVectorSet,
  newJobId,
  putJob,
} from '@dune/indexer/storage';
export type { StoredJob } from '@dune/indexer/storage';

const TABLE_NAME = process.env['TABLE_NAME'] ?? 'dune';

/** Created at module scope so the connection is reused across warm invocations. */
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** TTL attribute, 7 days on job records. The health ping uses a much shorter life. */
function expiresInSeconds(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/* ── Health ─────────────────────────────────────────────────────────────────── */

const HEALTH_PK = 'HEALTH';
const HEALTH_SK = 'PING';

export interface HealthPing {
  nonce: string;
  at: string;
}

/** Writes the ping. Overwrites the previous one; there is only ever a single item. */
export async function writeHealthPing(ping: HealthPing): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: HEALTH_PK,
        sk: HEALTH_SK,
        nonce: ping.nonce,
        at: ping.at,
        expiresAt: expiresInSeconds(60 * 60),
      },
    }),
  );
}

/** Reads it straight back. Strongly consistent, so the nonce comparison is meaningful. */
export async function readHealthPing(): Promise<HealthPing | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: HEALTH_PK, sk: HEALTH_SK },
      ConsistentRead: true,
    }),
  );

  const item = result.Item;
  if (!item || typeof item['nonce'] !== 'string' || typeof item['at'] !== 'string') {
    return null;
  }

  return { nonce: item['nonce'], at: item['at'] };
}

/* ── Team context ───────────────────────────────────────────────────────────── */

/*
 * Keys, from docs/01-BACKEND.md:
 *   context item   TEAM#{teamId} / CTX#{repoId}#{createdAt}#{id}   — sorts by time
 *   suggestion     TEAM#{teamId} / SUGG#{repoId}#{id}
 *
 * Nothing here deletes. Context items are never hard-deleted and suggestions are only ever
 * marked saved or dismissed: the history is the point of the product.
 */

const teamKey = (teamId: string): string => `TEAM#${teamId}`;
const contextKey = (item: ContextItem): string => `CTX#${item.repoId}#${item.createdAt}#${item.id}`;
const suggestionKey = (repoId: string, id: string): string => `SUGG#${repoId}#${id}`;

async function queryAll(pk: string, prefix: string, newestFirst: boolean): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
        ScanIndexForward: !newestFirst,
        ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
      }),
    );
    items.push(...(page.Items ?? []));
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined);
  return items;
}

/** The team's decisions, dead ends and constraints for a repo, newest first. */
export async function getTeamContext(teamId: string, repoId: string): Promise<ContextItem[]> {
  const items = await queryAll(teamKey(teamId), `CTX#${repoId}#`, true);
  return items.map((item) => ContextItemSchema.parse(item));
}

export type ApproveOutcome = 'saved' | 'suggestion-missing' | 'suggestion-not-pending';

/**
 * Writes a context item. When it approves a suggestion, the item and the suggestion's move
 * to `saved` are one transaction: either both happen or neither does, so a suggestion can
 * never be approved twice or left pending beside the item it became.
 */
export async function putContextItem(
  teamId: string,
  item: ContextItem,
  fromSuggestionId: string | null,
): Promise<ApproveOutcome> {
  const put = {
    TableName: TABLE_NAME,
    Item: { pk: teamKey(teamId), sk: contextKey(item), ...item },
    ConditionExpression: 'attribute_not_exists(sk)',
  };

  if (fromSuggestionId === null) {
    await client.send(new PutCommand(put));
    return 'saved';
  }

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: put },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: { pk: teamKey(teamId), sk: suggestionKey(item.repoId, fromSuggestionId) },
              UpdateExpression: 'SET #status = :saved, savedAt = :now, savedAs = :itemId',
              ConditionExpression: 'attribute_exists(sk) AND #status = :pending',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':saved': 'saved',
                ':pending': 'pending',
                ':now': item.createdAt,
                ':itemId': item.id,
              },
              ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
            },
          },
        ],
      }),
    );
    return 'saved';
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'name' in err && err.name === 'TransactionCanceledException') {
      const reasons = (err as { CancellationReasons?: { Code?: string; Item?: Record<string, AttributeValue> }[] })
        .CancellationReasons;
      const suggestion = reasons?.[1];
      if (suggestion?.Code === 'ConditionalCheckFailed') {
        return suggestion.Item === undefined ? 'suggestion-missing' : 'suggestion-not-pending';
      }
    }
    throw err;
  }
}

/** Every suggestion for a repo, whatever its status, newest first. */
export async function listSuggestions(teamId: string, repoId: string): Promise<Suggestion[]> {
  const items = await queryAll(teamKey(teamId), `SUGG#${repoId}#`, false);
  return items
    .map((item) => SuggestionSchema.parse(item))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function putSuggestions(teamId: string, repoId: string, suggestions: Suggestion[]): Promise<void> {
  for (const suggestion of suggestions) {
    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: teamKey(teamId), sk: suggestionKey(repoId, suggestion.id), repoId, ...suggestion },
        ConditionExpression: 'attribute_not_exists(sk)',
      }),
    );
  }
}

export type DismissOutcome = 'dismissed' | 'already-dismissed' | 'already-saved' | 'missing';

/** Marks, never deletes: a dismissed suggestion stays on record so it is never drafted again. */
export async function dismissSuggestion(teamId: string, repoId: string, id: string): Promise<DismissOutcome> {
  try {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: teamKey(teamId), sk: suggestionKey(repoId, id) },
        UpdateExpression: 'SET #status = :dismissed, dismissedAt = :now',
        ConditionExpression: 'attribute_exists(sk) AND #status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':dismissed': 'dismissed', ':pending': 'pending', ':now': new Date().toISOString() },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    return 'dismissed';
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'name' in err && err.name === 'ConditionalCheckFailedException') {
      const old = (err as { Item?: Record<string, AttributeValue> }).Item;
      if (old === undefined) return 'missing';
      return unmarshall(old)['status'] === 'saved' ? 'already-saved' : 'already-dismissed';
    }
    throw err;
  }
}
