/**
 * GET /v1/health — step 1 of the build order.
 *
 * Proves the whole stack is wired: API Gateway reaches the Lambda, the Lambda's IAM role
 * reaches DynamoDB, and a write comes back out of a read in the right region. A unique
 * nonce is written and read back, so a stale item or a silently-wrong table cannot pass.
 *
 * On success the body is exactly `{ ok: true }`. If the round trip does not hold, the
 * response is the standard error envelope with a human sentence — never an exception.
 */

import { randomUUID } from 'node:crypto';

import type { HealthResponse } from '@dune/shared';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { readHealthPing, writeHealthPing } from '../lib/db';
import { fail, json } from '../lib/http';

export async function health(): Promise<APIGatewayProxyStructuredResultV2> {
  const nonce = randomUUID();
  const at = new Date().toISOString();

  await writeHealthPing({ nonce, at });
  const stored = await readHealthPing();

  // CloudWatch is the only debugging tool for a deployed Lambda, so log the round trip.
  console.log('health: dynamodb round trip', { wrote: nonce, read: stored?.nonce ?? null });

  if (stored?.nonce !== nonce) {
    return fail(
      'INTERNAL',
      'The service could not confirm its connection to the database. Try again in a moment.',
    );
  }

  const body: HealthResponse = { ok: true };
  return json(200, body);
}
