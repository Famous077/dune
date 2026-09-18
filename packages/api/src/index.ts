/**
 * ApiFn — one Lambda, all HTTP handlers, internal routing. Fewer cold starts, one deploy,
 * one set of permissions. See `docs/04-INFRA.md`, "Lambda sizing notes".
 *
 * Routes are added here as the build order reaches them. Today there is one.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { health } from './handlers/health';
import { fail } from './lib/http';

/** Trailing slashes are stripped so `/v1/health/` and `/v1/health` are the same route. */
function normalisePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = normalisePath(event.requestContext.http.path);

  console.log('request', { method, path, requestId: event.requestContext.requestId });

  try {
    if (method === 'GET' && path === '/v1/health') {
      return await health();
    }

    return fail('NOT_FOUND', `There is no endpoint at ${method} ${path}.`);
  } catch (err) {
    // The frontend must never receive an unhandled exception. Log the detail, return a
    // sentence.
    console.error('unhandled error', { method, path, err });
    return fail('INTERNAL', 'Something went wrong on our side. Try again in a moment.');
  }
};
