/**
 * Secret redaction (§46, §47, §80).
 *
 * Applied to everything persisted (logs, memory records, command artifacts) and
 * to anything fed back into model context. The rule is simple: a value that is
 * never written cannot leak.
 */
import { isSensitiveEnvName } from './secrets.js';
/** Literal secret values registered at runtime (resolved API keys etc.). */
const registeredSecrets = new Set();
/** Register a concrete secret value so it can be redacted wherever it appears. */
export function registerSecret(value) {
    if (!value)
        return;
    const trimmed = value.trim();
    if (trimmed.length < 6)
        return;
    registeredSecrets.add(trimmed);
}
export function clearRegisteredSecrets() {
    registeredSecrets.clear();
}
export const REDACTED = '[redacted]';
const PATTERNS = [
    // Well-known key shapes.
    { name: 'openai', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
    { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
    { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
    { name: 'slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
    { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
    { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    // Generic `password = "..."` / `token: ...` assignments in config-ish text.
    {
        name: 'assignment',
        re: /\b(pass(?:word|wd)?|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*(['"])([^'"\n]{4,})\2/gi,
    },
    // Authorization headers.
    { name: 'bearer', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/g },
    // Env-style assignments: FOO_API_KEY=xyz
    { name: 'env_assignment', re: /\b([A-Z_][A-Z0-9_]{2,})\s*=\s*([^\s'"`]{6,})/g },
];
function labelFor(name) {
    return `[redacted:${name}]`;
}
/** Redact secrets inside an arbitrary string. */
export function redactString(input) {
    let out = input;
    for (const secret of registeredSecrets) {
        if (secret.length >= 6 && out.includes(secret))
            out = out.split(secret).join(REDACTED);
    }
    for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        out = out.replace(re, (...args) => {
            const match = args[0];
            if (name === 'assignment') {
                const key = args[1];
                const quote = args[2];
                return `${key} = ${quote}${REDACTED}${quote}`;
            }
            if (name === 'env_assignment') {
                const key = args[1];
                if (!isSensitiveEnvName(key))
                    return match;
                return `${key}=${REDACTED}`;
            }
            if (name === 'bearer') {
                const scheme = args[1];
                return `${scheme} ${REDACTED}`;
            }
            return labelFor(name);
        });
    }
    return out;
}
/**
 * Recursively redact a JSON-ish value. Keys whose *name* looks sensitive are
 * replaced wholesale regardless of their content.
 */
export function redact(value, depth = 0) {
    if (depth > 12)
        return '[depth-limit]';
    if (typeof value === 'string')
        return redactString(value);
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map((item) => redact(item, depth + 1));
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
        if (isSensitiveEnvName(key) && (typeof inner === 'string' || typeof inner === 'number')) {
            out[key] = REDACTED;
            continue;
        }
        out[key] = redact(inner, depth + 1);
    }
    return out;
}
/** True when a string contains something that looks like a live credential. */
export function containsSecret(text) {
    const redacted = redactString(text);
    return redacted !== text;
}
/** Build a filtered environment for child processes (§20). */
export function buildChildEnv(base, options = {}) {
    const allow = new Set((options.allow ?? []).map((v) => v.toUpperCase()));
    const deny = new Set((options.deny ?? []).map((v) => v.toUpperCase()));
    const out = {};
    for (const [key, value] of Object.entries(base)) {
        if (value === undefined)
            continue;
        const upper = key.toUpperCase();
        if (deny.has(upper))
            continue;
        if (allow.size > 0) {
            if (allow.has(upper))
                out[key] = value;
            continue;
        }
        // By default drop anything that looks like a credential.
        if (isSensitiveEnvName(key))
            continue;
        out[key] = value;
    }
    for (const [key, value] of Object.entries(options.extra ?? {}))
        out[key] = value;
    return out;
}
//# sourceMappingURL=redact.js.map