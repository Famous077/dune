/**
 * The team knowledge layer — `docs/03-API.md`, "Context endpoints".
 *
 *   GET  /v1/context/:repoId?teamId=   items newest first, and the pending suggestions
 *   POST /v1/context                   create an item, optionally approving a suggestion
 *
 * Items are never deleted. What an agent writes is stored as agent-authored, and only a
 * person can turn a suggestion into team context.
 */

import { randomUUID } from 'node:crypto';

import {
  ContextItemSchema,
  ContextListResponseSchema,
  CreateContextRequestSchema,
  KeyIdSchema,
} from '@dune/shared';
import type { ContextItem } from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import * as db from '../lib/db';
import { fail, failFrom, json, readJsonBody, teamIdOf } from '../lib/http';
import { repoIdOfSuggestion } from '../lib/suggestions';

const NOT_INDEXED = 'This repository has not been indexed yet. Index it first.';

export async function listContext(
  event: APIGatewayProxyEventV2,
  params: { repoId: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const teamId = teamIdOf(event);
  const repoId = KeyIdSchema.safeParse(params.repoId);
  if (teamId === null || !repoId.success) {
    return fail('INVALID_REQUEST', 'The repository and team ids may only contain letters, digits, - and _.');
  }

  try {
    if ((await db.getRepoRecord(repoId.data)) === null) return fail('NOT_FOUND', NOT_INDEXED);

    const [items, suggestions] = await Promise.all([
      db.getTeamContext(teamId, repoId.data),
      db.listSuggestions(teamId, repoId.data),
    ]);
    return json(
      200,
      ContextListResponseSchema.parse({
        items,
        suggestions: suggestions.filter((suggestion) => suggestion.status === 'pending'),
      }),
    );
  } catch (err) {
    return failFrom(err, 'context list', 'Could not load the team context just now. Try again in a moment.');
  }
}

export async function createContext(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const body = CreateContextRequestSchema.safeParse(readJsonBody(event));
  if (!body.success) {
    const field = body.error.issues[0]?.path.join('.') || 'body';
    return fail('INVALID_REQUEST', `The context item is missing something or has an invalid "${field}". It needs a repoId, a type, a title and a body.`);
  }
  const request = body.data;

  // Approving a draft is a human act. An agent records its own items; it never promotes a
  // model-written draft into the team's record.
  if (request.fromSuggestionId !== null && request.authoredBy === 'agent') {
    return fail('INVALID_REQUEST', 'Only a person can approve a suggestion. Agents can record their own items instead.');
  }
  if (request.fromSuggestionId !== null && repoIdOfSuggestion(request.fromSuggestionId) !== request.repoId) {
    return fail('NOT_FOUND', 'That suggestion does not exist for this repository.');
  }

  try {
    if ((await db.getRepoRecord(request.repoId)) === null) return fail('NOT_FOUND', NOT_INDEXED);

    const item: ContextItem = ContextItemSchema.parse({
      id: `ctx_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      repoId: request.repoId,
      type: request.type,
      title: request.title,
      body: request.body,
      files: [...new Set(request.files.map((file) => file.trim().replace(/^\.?\//, '')))],
      authoredBy: request.authoredBy,
      createdAt: new Date().toISOString(),
    });

    const outcome = await db.putContextItem(request.teamId, item, request.fromSuggestionId);
    if (outcome === 'suggestion-missing') {
      return fail('NOT_FOUND', 'That suggestion does not exist. It may belong to another team.');
    }
    if (outcome === 'suggestion-not-pending') {
      return fail('INVALID_REQUEST', 'That suggestion has already been saved or dismissed.');
    }

    console.log('context: saved', { teamId: request.teamId, id: item.id, type: item.type, authoredBy: item.authoredBy, fromSuggestion: request.fromSuggestionId });
    return json(201, item);
  } catch (err) {
    return failFrom(err, 'context create', 'Could not save this to the team context. Try again in a moment.');
  }
}
