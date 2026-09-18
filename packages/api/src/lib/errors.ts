/**
 * A failure that already knows how the API should report it: a contract error code and a
 * sentence written for the person reading the UI. Handlers turn it straight into the
 * error envelope; anything else becomes a generic failure with the detail kept in the logs.
 */

import type { ErrorCode } from '@dune/shared';

export class ApiFailure extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApiFailure';
    this.code = code;
  }
}
