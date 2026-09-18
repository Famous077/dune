/**
 * ApiFn — one Lambda, all HTTP handlers, internal routing. Fewer cold starts, one deploy,
 * one set of permissions. See `docs/04-INFRA.md`, "Lambda sizing notes".
 *
 * Routes are added here as the build order reaches them.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { createContext, listContext } from './handlers/context';
import { exportContext } from './handlers/export';
import { health } from './handlers/health';
import { query } from './handlers/query';
import { createRepo, getFile, getRepoState } from './handlers/repos';
import { dismiss, refresh } from './handlers/suggestions';
import { fail } from './lib/http';

type Handler = (
  event: APIGatewayProxyEventV2,
  params: Record<string, string>,
) => Promise<APIGatewayProxyStructuredResultV2>;

interface Route {
  method: string;
  /** Named segments like `:repoId` match one segment each; a final `*` matches the rest. */
  path: string;
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/v1/health', handler: () => health() },
  { method: 'POST', path: '/v1/repos', handler: (event) => createRepo(event) },
  { method: 'GET', path: '/v1/repos/:repoId', handler: (event, params) => getRepoState(event, { repoId: params['repoId'] ?? '' }) },
  { method: 'GET', path: '/v1/repos/:repoId/files/*', handler: (event, params) => getFile(event, { repoId: params['repoId'] ?? '', path: params['*'] ?? '' }) },
  { method: 'POST', path: '/v1/query', handler: (event) => query(event) },
  { method: 'GET', path: '/v1/context/:repoId', handler: (event, params) => listContext(event, { repoId: params['repoId'] ?? '' }) },
  { method: 'POST', path: '/v1/context', handler: (event) => createContext(event) },
  { method: 'POST', path: '/v1/suggestions/:repoId/refresh', handler: (event, params) => refresh(event, { repoId: params['repoId'] ?? '' }) },
  { method: 'POST', path: '/v1/suggestions/:id/dismiss', handler: (event, params) => dismiss(event, { id: params['id'] ?? '' }) },
  { method: 'GET', path: '/v1/export/:repoId', handler: (event, params) => exportContext(event, { repoId: params['repoId'] ?? '' }) },
];

/** Trailing slashes are stripped so `/v1/health/` and `/v1/health` are the same route. */
function normalisePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function match(route: Route, path: string): Record<string, string> | null {
  const expected = route.path.split('/');
  const actual = path.split('/');
  const wildcard = expected.at(-1) === '*';
  if (wildcard ? actual.length < expected.length : actual.length !== expected.length) return null;

  const params: Record<string, string> = {};
  try {
    for (let index = 0; index < expected.length; index += 1) {
      const want = expected[index] ?? '';
      if (want === '*' && index === expected.length - 1) {
        params['*'] = actual.slice(index).map(decodeURIComponent).join('/');
        break;
      }
      const got = actual[index] ?? '';
      if (want.startsWith(':')) {
        if (got === '') return null;
        params[want.slice(1)] = decodeURIComponent(got);
      } else if (want !== got) {
        return null;
      }
    }
  } catch {
    // A malformed %-escape: no route can mean that path.
    return null;
  }
  return params;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = normalisePath(event.requestContext.http.path);

  // CORS preflight. The ANY /{proxy+} route sends OPTIONS here instead of letting API
  // Gateway answer it, and a browser rejects any preflight that is not 2xx — which blocked
  // every POST from the web app. API Gateway adds the configured CORS headers to this.
  if (method === 'OPTIONS') return { statusCode: 204 };

  console.log('request', { method, path, requestId: event.requestContext.requestId });

  try {
    for (const route of ROUTES) {
      if (route.method !== method) continue;
      const params = match(route, path);
      if (params !== null) return await route.handler(event, params);
    }
    return fail('NOT_FOUND', `There is no endpoint at ${method} ${path}.`);
  } catch (err) {
    // The frontend must never receive an unhandled exception. Log the detail, return a
    // sentence.
    console.error('unhandled error', { method, path, err });
    return fail('INTERNAL', 'Something went wrong on our side. Try again in a moment.');
  }
};
