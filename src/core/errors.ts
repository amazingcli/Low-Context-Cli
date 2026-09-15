/**
 * Error types.
 *
 * Every failure a user might have to act on carries a stable `code` and an
 * optional `fix` hint, so the CLI can explain how to recover rather than only
 * what broke (§45, §90). Failures must never silently corrupt memory or index
 * state — callers are expected to catch these and degrade explicitly.
 */

export type ErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'PROVIDER_UNKNOWN'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_HTTP'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNSUPPORTED'
  | 'MODEL_UNKNOWN'
  | 'STORAGE_IO'
  | 'STORAGE_CORRUPT'
  | 'INDEX_MISSING'
  | 'INDEX_STALE'
  | 'MEMORY_ERROR'
  | 'SEARCH_ERROR'
  | 'CONTEXT_OVERFLOW'
  | 'TOOL_UNKNOWN'
  | 'TOOL_DENIED'
  | 'TOOL_FAILED'
  | 'TOOL_TIMEOUT'
  | 'PATH_DENIED'
  | 'COMMAND_DENIED'
  | 'SESSION_MISSING'
  | 'SESSION_CORRUPT'
  | 'CANCELLED'
  | 'UNSUPPORTED';

export class LowContextError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { fix?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LowContextError';
    this.code = code;
    if (options.fix !== undefined) this.fix = options.fix;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isLowContextError(value: unknown): value is LowContextError {
  return value instanceof LowContextError;
}

/** Human-facing one-liner including the fix hint when present. */
export function describeError(error: unknown): string {
  if (isLowContextError(error)) {
    return error.fix ? `${error.message} — ${error.fix}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function cancelled(what: string): LowContextError {
  return new LowContextError('CANCELLED', `${what} was cancelled`);
}

/** Wrap an unknown throwable, preserving a LowContextError unchanged. */
export function wrapError(code: ErrorCode, message: string, cause: unknown): LowContextError {
  if (isLowContextError(cause)) return cause;
  return new LowContextError(code, message, { cause });
}
