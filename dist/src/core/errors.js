/**
 * Error types.
 *
 * Every failure a user might have to act on carries a stable `code` and an
 * optional `fix` hint, so the CLI can explain how to recover rather than only
 * what broke (§45, §90). Failures must never silently corrupt memory or index
 * state — callers are expected to catch these and degrade explicitly.
 */
export class LowContextError extends Error {
    code;
    fix;
    details;
    constructor(code, message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'LowContextError';
        this.code = code;
        if (options.fix !== undefined)
            this.fix = options.fix;
        if (options.details !== undefined)
            this.details = options.details;
    }
}
export function isLowContextError(value) {
    return value instanceof LowContextError;
}
/** Human-facing one-liner including the fix hint when present. */
export function describeError(error) {
    if (isLowContextError(error)) {
        return error.fix ? `${error.message} — ${error.fix}` : error.message;
    }
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export function cancelled(what) {
    return new LowContextError('CANCELLED', `${what} was cancelled`);
}
/** Wrap an unknown throwable, preserving a LowContextError unchanged. */
export function wrapError(code, message, cause) {
    if (isLowContextError(cause))
        return cause;
    return new LowContextError(code, message, { cause });
}
//# sourceMappingURL=errors.js.map