/**
 * POST /v1/query — the core call. Returns `{ answer, tookMs }` exactly as `docs/03-API.md`
 * specifies: retrieve, assemble, generate, then hold the answer to the contract's
 * guarantees before it leaves.
 */

import { IndexerError } from '@dune/indexer/errors';
import { QueryRequestSchema, QueryResponseSchema } from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { finaliseAnswer } from '../lib/answer';
import { assembleContext } from '../lib/context';
import * as db from '../lib/db';
import { ApiFailure } from '../lib/errors';
import { getGenerator } from '../lib/generation';
import { fail, json, readJsonBody } from '../lib/http';
import { NotIndexedError, retrieve } from '../lib/retrieval';

export async function query(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const started = Date.now();

  const body = QueryRequestSchema.safeParse(readJsonBody(event));
  if (!body.success) {
    const questionIssue = body.error.issues.some((issue) => issue.path[0] === 'question');
    return fail(
      'INVALID_REQUEST',
      questionIssue ? 'Ask a question — it cannot be empty.' : 'Send a JSON body with a repoId and a question.',
    );
  }
  const { repoId, teamId, question } = body.data;

  const record = await db.getRepoRecord(repoId);
  if (record === null) {
    return fail('NOT_FOUND', 'This repository has not been indexed yet. Index it first, then ask again.');
  }

  try {
    const generator = getGenerator();
    const retrieval = await retrieve({ record, teamId, question });
    const context = assembleContext(retrieval);

    const generationStarted = Date.now();
    const generation = await generator.generate(context.text);
    const generationMs = Date.now() - generationStarted;

    const { answer, notes } = finaliseAnswer(generation, retrieval);
    const response = QueryResponseSchema.parse({ answer, tookMs: Date.now() - started });

    // Everything that explains the answer goes to the logs, not the response.
    console.log('query', {
      repoId,
      question,
      generator: generation.generatorId,
      attempts: generation.attempts,
      contextTokens: context.tokenEstimate,
      dropped: context.dropped.length,
      topCandidates: retrieval.candidates.slice(0, 3).map((candidate) => candidate.file),
      signals: retrieval.signals,
      confidence: answer.confidence,
      notes,
      timings: { ...retrieval.timings, generationMs, totalMs: response.tookMs },
    });

    return json(200, response);
  } catch (err) {
    if (err instanceof NotIndexedError) {
      return fail('INDEX_NOT_READY', 'This repository is still being indexed. It will be ready shortly.');
    }
    if (err instanceof ApiFailure || err instanceof IndexerError) {
      console.error('query: failed', { repoId, code: err.code, message: err.message, cause: err.cause });
      return fail(err.code, err.message);
    }
    console.error('query: failed', { repoId, err });
    return fail('QUERY_FAILED', 'Could not answer this question just now. Try again in a moment.');
  }
}
