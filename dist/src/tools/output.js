/**
 * Tool output management (§56, §58).
 *
 * A 10 MB build log must not enter the context window. The rule is:
 *
 *   full output -> artifact on disk (retrievable on demand)
 *   relevant slice -> active context
 *
 * "Relevant slice" is computed, not guessed: known error/warning patterns are
 * extracted, and the head/tail are kept so the beginning and the end of a run
 * are always visible. The user can still ask for the full artifact.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, formatBytes, headLines, tailLines } from '../core/util.js';
export const DEFAULT_OUTPUT_POLICY = {
    inline_limit: 12_000,
    spill_head_lines: 40,
    spill_tail_lines: 60,
    error_budget: 4_000,
};
/**
 * Error extraction patterns. Ordered by signal strength; matched case
 * insensitively, with the `global` flag avoided so the lastIndex bug in a
 * shared regex cannot leak between calls.
 */
const ERROR_PATTERNS = [
    { name: 'typescript', re: /\berror TS\d+:/i },
    { name: 'compiler', re: /\berror\b[:\s]/i },
    { name: 'panic', re: /\bpanic:|\bfatal error:/i },
    { name: 'python', re: /^[A-Za-z_.]*(Error|Exception):/ },
    { name: 'go', re: /\.go:\d+:\d+:/ },
    { name: 'rust', re: /^error\[E\d+\]/ },
    { name: 'test-fail', re: /\b(failing|failed|FAIL)\b/ },
    { name: 'warning', re: /\bwarning\b[:\s]/i },
    { name: 'exception', re: /Unhandled (Promise )?[Rr]ejection|Traceback \(most recent call last\)/ },
    { name: 'notfound', re: /\b(not found|no such file|cannot find module|module not found)\b/i },
];
export class OutputManager {
    artifactsDir;
    policy;
    constructor(artifactsDir, policy = {}) {
        this.artifactsDir = artifactsDir;
        this.policy = { ...DEFAULT_OUTPUT_POLICY, ...policy };
    }
    /** Extract lines that look like errors, deduplicated, in order of appearance. */
    static extractErrors(text, budget = DEFAULT_OUTPUT_POLICY.error_budget) {
        const out = [];
        const seen = new Set();
        let used = 0;
        for (const line of text.split('\n')) {
            const trimmed = line.trimEnd();
            if (trimmed.trim() === '')
                continue;
            if (trimmed.length > 400)
                continue; // a wall of text is not a diagnostic
            if (!ERROR_PATTERNS.some((pattern) => pattern.re.test(trimmed)))
                continue;
            const key = trimmed.trim();
            if (seen.has(key))
                continue;
            seen.add(key);
            if (used + key.length > budget)
                break;
            out.push(key);
            used += key.length + 1;
        }
        return out;
    }
    /**
     * Decide how a tool's output reaches the model. Small outputs pass through
     * untouched; large ones are written to an artifact and replaced by a
     * head + extracted-errors + tail view.
     */
    async process(input) {
        const text = input.text ?? '';
        const bytes = Buffer.byteLength(text, 'utf8');
        const errors = OutputManager.extractErrors(text, this.policy.error_budget);
        if (text.length <= this.policy.inline_limit && errors.length === 0) {
            return { inline: text, bytes, truncated: false, errors: [], spilled: false };
        }
        if (text.length <= this.policy.inline_limit && errors.length > 0) {
            // Small but noisy: still fine inline; callers display errors separately.
            return { inline: text, bytes, truncated: false, errors, spilled: false };
        }
        const artifactPath = await this.writeArtifact(input.label, text);
        const sections = [];
        sections.push(`[output ${formatBytes(bytes)} — full copy at ${artifactPath}]`);
        const head = headLines(text, this.policy.spill_head_lines);
        if (head.trim() !== '')
            sections.push(`--- first ${this.policy.spill_head_lines} lines ---\n${head}`);
        if (errors.length > 0) {
            sections.push(`--- ${errors.length} diagnostic line(s) ---\n${errors.join('\n')}`);
        }
        const tail = tailLines(text, this.policy.spill_tail_lines);
        if (tail.trim() !== '' && text.split('\n').length > this.policy.spill_head_lines + this.policy.spill_tail_lines) {
            sections.push(`--- last ${this.policy.spill_tail_lines} lines ---\n${tail}`);
        }
        if (input.error)
            sections.push(`--- error ---\n${input.error}`);
        return {
            inline: sections.join('\n\n'),
            artifactPath,
            bytes,
            truncated: true,
            errors,
            spilled: true,
        };
    }
    /** Write the full output to a deterministic artifact path. */
    async writeArtifact(label, text) {
        await ensureDir(this.artifactsDir);
        const safe = label.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 60);
        const hash = createHash('sha1').update(text).digest('hex').slice(0, 10);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const path = join(this.artifactsDir, `${stamp}_${safe}_${hash}.log`);
        await writeFile(path, text, 'utf8');
        return path;
    }
}
//# sourceMappingURL=output.js.map