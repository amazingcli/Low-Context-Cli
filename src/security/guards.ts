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
import { describeFindings, frameUntrusted, scanForInjection, type InjectionFinding } from './injection.js';
import type { LowContextConfig } from '../core/config.js';

export interface GuardResult {
  content: string;
  redacted: boolean;
  findings: InjectionFinding[];
  /** Short human-readable note, when something was changed. */
  note?: string;
}

export interface GuardOptions {
  config: Pick<LowContextConfig, 'privacy' | 'security'>;
  /** Label for the untrusted block, e.g. `file src/auth/service.ts`. */
  source?: string;
  /** Set false for text the user wrote directly. */
  untrusted?: boolean;
}

export function guardOutbound(content: string, options: GuardOptions): GuardResult {
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

  const notes: string[] = [];
  if (redacted) notes.push('secrets redacted before sending');
  if (findings.length > 0) notes.push(`instruction-shaped content: ${describeFindings(findings)}`);

  return {
    content: text,
    redacted,
    findings,
    ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
  };
}

/** Redact only — used for logs and memory records, which never reach a model. */
export function sanitizeForStorage<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeForStorage(item)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = sanitizeForStorage(entry);
    return out as unknown as T;
  }
  return value;
}
