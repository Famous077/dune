/**
 * Response helpers. Everything the API returns goes through here, so the error envelope
 * in `docs/03-API.md` is impossible to get wrong by hand.
 *
 * CORS headers are not set here — the HTTP API adds them from `CorsConfiguration` in
 * `infra/template.yaml`. Setting them in both places sends duplicate headers, which the
 * browser rejects.
 */

import { IndexerError } from '@dune/indexer/errors';
import { KeyIdSchema } from '@dune/shared';
import type { ApiError, ErrorCode } from '@dune/shared';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

import { ApiFailure } from './errors';

/**
 * The error code table from `docs/03-API.md`. The frontend does not decide whether
 * something is retryable; this table does.
 */
const ERROR_META: Record<ErrorCode, { status: number; retryable: boolean }> = {
  INVALID_REPO_URL: { status: 400, retryable: false },
  INVALID_REQUEST: { status: 400, retryable: false },
  REPO_NOT_FOUND: { status: 404, retryable: false },
  REPO_TOO_LARGE: { status: 400, retryable: false },
  NO_SUPPORTED_FILES: { status: 400, retryable: false },
  INDEX_NOT_READY: { status: 409, retryable: true },
  INDEX_FAILED: { status: 500, retryable: true },
  QUERY_FAILED: { status: 500, retryable: true },
  MODEL_UNAVAILABLE: { status: 503, retryable: true },
  RATE_LIMITED: { status: 429, retryable: true },
  NOT_FOUND: { status: 404, retryable: false },
  INTERNAL: { status: 500, retryable: true },
};

/**
 * `?teamId=`, defaulting to `demo` — no auth this weekend, so everyone with the link shares
 * a team. Null when present but not a safe key id.
 */
export function teamIdOf(event: APIGatewayProxyEventV2): string | null {
  const parsed = KeyIdSchema.safeParse(event.queryStringParameters?.['teamId'] ?? 'demo');
  return parsed.success ? parsed.data : null;
}

/**
 * A failure that already carries a contract code becomes that error; anything else is
 * logged in full and reported as a sentence.
 */
export function failFrom(err: unknown, where: string, fallback: string): APIGatewayProxyStructuredResultV2 {
  if (err instanceof ApiFailure || err instanceof IndexerError) {
    console.error(`${where}: failed`, { code: err.code, message: err.message, cause: err.cause });
    return fail(err.code, err.message);
  }
  console.error(`${where}: failed`, { err });
  return fail('INTERNAL', fallback);
}

/** The parsed JSON body, or null when there is none or it is not JSON. Validation is the caller's. */
export function readJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined) return null;
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * `message` is rendered directly in the UI, so it is a sentence written for a person:
 * never a stack trace, never an exception string.
 */
export function fail(code: ErrorCode, message: string): APIGatewayProxyStructuredResultV2 {
  const { status, retryable } = ERROR_META[code];
  const body: ApiError = { error: { code, message, retryable } };
  return json(status, body);
}
