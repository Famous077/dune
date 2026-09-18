/**
 * Git-aware suggestions — `docs/03-API.md`.
 *
 *   POST /v1/suggestions/:repoId/refresh?teamId=   draft from the diff since indexing
 *   POST /v1/suggestions/:id/dismiss?teamId=       mark dismissed, never deleted
 */

import {
  DismissSuggestionResponseSchema,
  KeyIdSchema,
  RefreshSuggestionsRequestSchema,
  RefreshSuggestionsResponseSchema,
} from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import * as db from '../lib/db';
import { fail, failFrom, json, readJsonBody, teamIdOf } from '../lib/http';
import { refreshSuggestions, repoIdOfSuggestion } from '../lib/suggestions';

export async function refresh(
  event: APIGatewayProxyEventV2,
  params: { repoId: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const teamId = teamIdOf(event);
  const repoId = KeyIdSchema.safeParse(params.repoId);
  if (teamId === null || !repoId.success) {
    return fail('INVALID_REQUEST', 'The repository and team ids may only contain letters, digits, - and _.');
  }

  // The body is optional; an absent or empty body means "since the indexed commit".
  const body = RefreshSuggestionsRequestSchema.safeParse(readJsonBody(event) ?? {});
  if (!body.success) {
    return fail('INVALID_REQUEST', '"since" must be a commit SHA: 7 to 40 hexadecimal characters.');
  }

  try {
    const record = await db.getRepoRecord(repoId.data);
    if (record === null) return fail('NOT_FOUND', 'This repository has not been indexed yet. Index it first.');

    const started = Date.now();
    const result = await refreshSuggestions({ record, teamId, since: body.data.since });
    console.log('suggestions: refreshed', {
      teamId,
      repoId: repoId.data,
      diff: result.diff,
      drafted: result.drafted,
      discarded: result.discarded,
      pending: result.suggestions.length,
      tookMs: Date.now() - started,
    });

    return json(200, RefreshSuggestionsResponseSchema.parse({ suggestions: result.suggestions }));
  } catch (err) {
    return failFrom(err, 'suggestions refresh', 'Could not draft suggestions just now. Try again in a moment.');
  }
}

export async function dismiss(
  event: APIGatewayProxyEventV2,
  params: { id: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const teamId = teamIdOf(event);
  const id = KeyIdSchema.safeParse(params.id);
  const repoId = id.success ? repoIdOfSuggestion(id.data) : null;
  if (teamId === null) return fail('INVALID_REQUEST', 'The team id may only contain letters, digits, - and _.');
  if (!id.success || repoId === null) return fail('NOT_FOUND', 'There is no suggestion with that id.');

  try {
    const outcome = await db.dismissSuggestion(teamId, repoId, id.data);
    if (outcome === 'missing') return fail('NOT_FOUND', 'There is no suggestion with that id for this team.');
    if (outcome === 'already-saved') {
      return fail('INVALID_REQUEST', 'This suggestion was already saved as team context, so it cannot be dismissed.');
    }
    console.log('suggestions: dismissed', { teamId, id: id.data, outcome });
    return json(200, DismissSuggestionResponseSchema.parse({ ok: true }));
  } catch (err) {
    return failFrom(err, 'suggestions dismiss', 'Could not dismiss this suggestion just now. Try again in a moment.');
  }
}
