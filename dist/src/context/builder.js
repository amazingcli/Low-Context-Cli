import { STRATEGY_SHARE } from '../core/types.js';
import { estimateTokens, formatTokens } from './estimator.js';
import { clamp } from '../core/util.js';
export const KIND_PRIORITY = {
    system: 1,
    recent: 0.95,
    task: 0.92,
    conversation_summary: 0.8,
    project_map: 0.6,
    memory: 0.7,
    code: 0.75,
    symbol: 0.65,
    tool_result: 0.6,
    retrieval_trace: 0.1,
};
export class ContextBuilder {
    items = [];
    options;
    dropped = [];
    constructor(options) {
        this.options = options;
    }
    add(item) {
        const tokens = item.tokens ?? estimateTokens(item.content).tokens;
        this.items.push({ ...item, tokens });
    }
    /**
     * Assemble the final ordered item list under the usable budget.
     * Slices are *per-kind caps based on strategy shares*; the surplus from one
     * kind is never silently given to another kind.
     */
    build() {
        const { strategy, modelContextLimit, reserveOutputTokens } = this.options;
        const scale = this.options.budgetScale !== undefined && this.options.budgetScale > 0 ? Math.min(1, this.options.budgetScale) : 1;
        const usable = Math.max(1, Math.floor((modelContextLimit - reserveOutputTokens) * scale));
        const shares = STRATEGY_SHARE[strategy];
        const byKind = new Map();
        for (const item of this.items) {
            const list = byKind.get(item.kind) ?? [];
            list.push(item);
            byKind.set(item.kind, list);
        }
        const kindCaps = capsForStrategy(strategy, usable, shares);
        const selected = [];
        const dropped = [];
        let usedTokens = 0;
        // System + task always win regardless of strategy (they are required to
        // behave correctly, not retrieval choices).
        const claim = (item) => {
            if (item.kind === 'system' || item.kind === 'task')
                return true;
            return false;
        };
        const ordered = [...this.items].sort((a, b) => {
            const pa = claim(a) ? 2 : KIND_PRIORITY[a.kind];
            const pb = claim(b) ? 2 : KIND_PRIORITY[b.kind];
            return pb - pa || b.priority - a.priority;
        });
        const spent = new Map();
        for (const item of ordered) {
            const required = claim(item);
            const cap = required || item.kind === 'recent' ? Infinity : kindCaps[item.kind] ?? Infinity;
            const current = spent.get(item.kind) ?? 0;
            if (item.kind !== 'system' && current + item.tokens > cap) {
                dropped.push({ label: item.label, tokens: item.tokens, reason: `${item.kind} over strategy share` });
                continue;
            }
            if (item.kind !== 'system' && usedTokens + item.tokens > usable) {
                dropped.push({ label: item.label, tokens: item.tokens, reason: 'budget exhausted' });
                continue;
            }
            selected.push(item);
            usedTokens += item.tokens;
            spent.set(item.kind, (spent.get(item.kind) ?? 0) + item.tokens);
        }
        this.dropped = dropped;
        return orderForProvider(selected);
    }
    /** Render the budget report — the core of `low-context context show` (§39). */
    report(selected) {
        const { modelContextLimit, reserveOutputTokens, strategy } = this.options;
        const usable = Math.max(1, modelContextLimit - reserveOutputTokens);
        const usedTokens = selected.reduce((sum, item) => sum + item.tokens, 0);
        const slices = [];
        const byKind = new Map();
        for (const item of selected) {
            byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + item.tokens);
        }
        for (const [kind, tokens] of byKind.entries()) {
            slices.push({ kind, tokens, items: selected.filter((i) => i.kind === kind).length });
        }
        slices.sort((a, b) => b.tokens - a.tokens);
        return {
            strategy,
            model_context_limit: modelContextLimit,
            reserved_output_tokens: reserveOutputTokens,
            usable_tokens: usable,
            used_tokens: usedTokens,
            utilization: usedTokens / usable,
            slices,
            dropped: this.dropped,
            estimated: true,
        };
    }
}
function capsForStrategy(strategy, usable, shares) {
    void strategy;
    return {
        memory: Math.floor(usable * shares.memory),
        code: Math.floor(usable * shares.code),
        tool_result: Math.floor(usable * shares.tool),
        project_map: Math.floor(usable * shares.map),
        conversation_summary: Math.floor(usable * 0.08),
        recent: Math.floor(usable * 0.12),
    };
}
/** Reorder for provider message arrays: system messages first. */
function orderForProvider(items) {
    return [...items].sort((a, b) => {
        if (a.kind === 'system' && b.kind !== 'system')
            return -1;
        if (b.kind === 'system' && a.kind !== 'system')
            return 1;
        return 0;
    });
}
/** Render the memory slice compactly: id, type, scope, summary, confidence. */
export function renderMemoryItems(items) {
    if (items.length === 0)
        return 'No memories retrieved.';
    const lines = items.map((item, i) => {
        const meta = item.content.split('\n')[0] ?? item.content;
        return `${i + 1}. ${meta} [${item.tokens}t]`;
    });
    return lines.join('\n');
}
export function renderBudgetLine(report) {
    const rows = report.slices.map((slice) => `${pad(slice.kind, 22)} ${formatTokens(slice.tokens)}`).join('\n');
    return [
        `Context Budget (strategy: ${report.strategy})`,
        '─'.repeat(36),
        rows,
        '─'.repeat(36),
        `Total used          ${formatTokens(report.used_tokens)} / ${formatTokens(report.usable_tokens)}`,
        `Utilization         ${Math.round(report.utilization * 100)}%`,
    ].join('\n');
}
function pad(text, width) {
    return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}
export function clampInclude(min, value, max) {
    return clamp(value, min, max);
}
//# sourceMappingURL=builder.js.map