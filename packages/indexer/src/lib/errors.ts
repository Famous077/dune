/**
 * Pipeline errors carry an API error code, so whatever surfaces a failure — the local
 * runner today, the API and Step Functions later — has a code and a human sentence to
 * hand on rather than an exception string.
 */

import type { ErrorCode } from '@dune/shared';

export class IndexerError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IndexerError';
    this.code = code;
  }
}
