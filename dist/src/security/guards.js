/**
 * Outbound guards (§80, §81).
 *
 * Everything that leaves Low Context for a model provider passes through
 * `guardOutbound`. It does two jobs in one place:
 *
 *   1. **Secret redaction.** If a `.env` file, a dump or a tool result happens
 *      to contain a live credential, it is masked before it crosses the network.
 *      The result reports whether redaction happened so the UI can tell the user
 *      rather than silently altering their data.
 *   2. **Untrusted framing.** Repository and tool content is wrapped so the
 *      model can tell data from instructions, and instruction-shaped passages
 *      are reported.
 */
import { redactString, containsSecret } from './redact.js';
import { describeFindings, frameUntrusted, scanForInjection } from './injection.js';
export function guardOutbound(content, options) {
    let text = content;
    let redacted = false;
    if (options.config.privacy.redact_secrets && containsSecret(text)) {
        text = redactString(text);
        redacted = true;
    }
    const findings = options.config.security.scan_for_injection_patterns ? scanForInjection(text) : [];
    if (findings.length > 0 && options.config.security.injection_defense) {
        text = text
            .split('\n')
            .map((line, index) => {
            const hit = findings.find((f) => f.line === index + 1);
            return hit ? `${line}   // [low-context: instruction-shaped content ${hit.kind}]` : line;
        })
            .join('\n');
    }
    if (options.untrusted !== false && options.config.security.tag_untrusted_content) {
        text = frameUntrusted(text, options.source ?? 'content', findings);
    }
    const notes = [];
    if (redacted)
        notes.push('secrets redacted before sending');
    if (findings.length > 0)
        notes.push(`instruction-shaped content: ${describeFindings(findings)}`);
    return {
        content: text,
        redacted,
        findings,
        ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    };
}
/** Redact only — used for logs and memory records, which never reach a model. */
export function sanitizeForStorage(value) {
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value))
        return value.map((item) => sanitizeForStorage(item));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const [key, entry] of Object.entries(value))
            out[key] = sanitizeForStorage(entry);
        return out;
    }
    return value;
}
//# sourceMappingURL=guards.js.map