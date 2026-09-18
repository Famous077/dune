/**
 * Response helpers. Everything the API returns goes through here, so the error envelope
 * in `docs/03-API.md` is impossible to get wrong by hand.
 *
 * CORS headers are not set here — the HTTP API adds them from `CorsConfiguration` in
 * `infra/template.yaml`. Setting them in both places sends duplicate headers, which the
 * browser rejects.
 */

import type { ApiError, ErrorCode } from '@dune/shared';
import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * The error code table from `docs/03-API.md`. The frontend does not decide whether
 * something is retryable; this table does.
 */
const ERROR_META: Record<ErrorCode, { status: number; retryable: boolean }> = {
  INVALID_REPO_URL: { status: 400, retryable: false },
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
