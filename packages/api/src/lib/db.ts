/**
 * The only file in the API package that talks to DynamoDB. Handlers call functions here;
 * they never touch the SDK directly.
 *
 * Single table, keyed `pk` / `sk`, per the key layout in `docs/01-BACKEND.md`.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

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
