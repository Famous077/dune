/**
 * The HTTP client for the Dune API. Every call goes through `request`, which turns the
 * contract's error envelope (docs/03-API.md, "Error format") into an `ApiRequestError`
 * whose `message` is written for a human and can be rendered as-is.
 */
import type { ApiError, ErrorCode } from '@dune/shared/types';

/** `VITE_API_URL` is the stack's ApiUrl output, with or without a trailing /v1. */
const API_ROOT = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '').replace(/\/v1$/, '');
export const API_BASE_URL = `${API_ROOT}/v1`;

/**
 * No auth this weekend: the team is a query parameter that defaults to `demo`, and everyone
 * sharing the link shares the team. `?teamId=` on the page URL selects another one.
 */
export const TEAM_ID = new URLSearchParams(window.location.search).get('teamId') || 'demo';

/* ── Mock mode ──────────────────────────────────────────────────────────────── */

const MOCK_STORAGE_KEY = 'dune_use_mocks';

/** The mock toggle is a development fixture. Production builds never show it. */
export const MOCK_TOGGLE_AVAILABLE = import.meta.env.DEV;

/**
 * Live by default. `VITE_USE_MOCKS=true` serves the fixtures in src/mocks; in development
 * the top-bar toggle overrides that per browser. A production build ignores the stored
 * toggle, so a flag left behind in localStorage can never put the deployed site on mocks.
 */
export function isMockMode(): boolean {
  if (MOCK_TOGGLE_AVAILABLE) {
    try {
      const stored = localStorage.getItem(MOCK_STORAGE_KEY);
      if (stored !== null) return stored === 'true';
    } catch {
      // Storage unavailable: fall through to the build flag.
    }
  }
  return import.meta.env.VITE_USE_MOCKS === 'true';
}

export function setMockMode(enabled: boolean): void {
  try {
    localStorage.setItem(MOCK_STORAGE_KEY, String(enabled));
  } catch {
    // Storage unavailable: the toggle simply does not persist.
  }
}

/* ── Errors ─────────────────────────────────────────────────────────────────── */

/** `NETWORK` is the one code the client adds: the API could not be reached at all. */
export type ClientErrorCode = ErrorCode | 'NETWORK';

export class ApiRequestError extends Error {
  constructor(
    public readonly code: ClientErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** A human sentence for any thrown value, for components that render an error. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) return err.message;
  return 'Something went wrong. Try again.';
}

export function isRetryable(err: unknown): boolean {
  return err instanceof ApiRequestError ? err.retryable : true;
}

/* ── Requests ───────────────────────────────────────────────────────────────── */

/** Appends `teamId` to a path that may already carry a query string. */
export function withTeam(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(TEAM_ID)}`;
}

export async function request<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
  // Without it every call goes to the page's own origin and comes back as a bare 404.
  if (!API_ROOT) {
    throw new ApiRequestError(
      'INTERNAL',
      'This build has no API address. Set VITE_API_URL (see packages/web/.env.example) and restart the dev server.',
      false,
      null,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiRequestError(
      'NETWORK',
      'Could not reach the Dune API. Check your connection and try again.',
      true,
      null,
    );
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — an API Gateway error page, for example. Handled below.
  }

  if (!res.ok) {
    const envelope = (payload as Partial<ApiError> | null)?.error;
    if (envelope && typeof envelope.message === 'string') {
      throw new ApiRequestError(envelope.code, envelope.message, envelope.retryable, res.status);
    }
    // Only a gateway-level failure lacks the envelope: a timeout, or the function crashing.
    throw new ApiRequestError(
      'INTERNAL',
      res.status === 503 || res.status === 504
        ? 'The request took too long. Try again.'
        : 'The Dune API returned an unexpected error. Try again.',
      true,
      res.status,
    );
  }

  return payload as T;
}

/** Fixture latency, so loading states are visible in mock mode. */
export async function mockDelay(minMs = 280, maxMs = 450): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
