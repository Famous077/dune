/**
 * GET /v1/export/:repoId?teamId= — the team context as standalone markdown. Never fails on
 * empty context; with nothing saved it is the repo summary and structure alone.
 */

import { ExportResponseSchema, KeyIdSchema } from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import * as db from '../lib/db';
import { buildExport } from '../lib/export';
import { fail, failFrom, json, teamIdOf } from '../lib/http';

export async function exportContext(
  event: APIGatewayProxyEventV2,
  params: { repoId: string },
): Promise<APIGatewayProxyStructuredResultV2> {
  const teamId = teamIdOf(event);
  const repoId = KeyIdSchema.safeParse(params.repoId);
  if (teamId === null || !repoId.success) {
    return fail('INVALID_REQUEST', 'The repository and team ids may only contain letters, digits, - and _.');
  }

  try {
    const record = await db.getRepoRecord(repoId.data);
    if (record === null) return fail('NOT_FOUND', 'This repository has not been indexed yet. Index it first.');

    const [items, graph, routes] = await Promise.all([
      db.getTeamContext(teamId, repoId.data),
      db.getGraph(repoId.data),
      db.getRoutes(repoId.data),
    ]);
    return json(200, ExportResponseSchema.parse({ markdown: buildExport({ record, items, graph, routes }) }));
  } catch (err) {
    return failFrom(err, 'export', 'Could not build the export just now. Try again in a moment.');
  }
}
