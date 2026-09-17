/**
 * Context builder (§14, §55).
 *
 * The one place where the request is packed for the model, and the place that
 * enforces the Low Context rule "small + relevant + verified" (§13):
 *
 *  1. Everything enters as a `ContextItem` with a kind, a token cost and a
 *     priority. No raw data is special-cased.
 *  2. Strategy shares (§14: minimal/balanced/deep/maximum) cap how many tokens
 *     each retrieval category may consume. This is what stops "maximum" from
 *     meaning "send everything".
 *  3. Items are sorted by priority and filled up to the usable budget; anything
 *     that does not fit is *reported* (dropped list), never silently omitted.
 *
 * The class exposes `report()` so `low-context context show` renders exactly
 * what a real request would send (§39).
 */
import type {
  ContextBudgetReport,
  ContextItem,
  ContextItemKind,
  ContextStrategy,
  TaskState,
} from '../core/types.js';
import { STRATEGY_SHARE } from '../core/types.js';
import { estimateTokens, formatTokens } from './estimator.js';
import { clamp } from '../core/util.js';

export interface ContextBuildInput {
  taskState?: TaskState;
  projectMap?: string;
  memoryItems?: ContextItem[];
  codeItems?: ContextItem[];
  toolResultItems?: ContextItem[];
  conversationSummary?: ContextItem;
  recentMessages?: ContextItem[];
  retrievalTrace?: string;
  systemInstruction: string;
  userRequest: string;
}

export interface ContextBuildOptions {
  modelContextLimit: number;
  reserveOutputTokens: number;
  strategy: ContextStrategy;
  /** When set, total usage triggers compaction upstream. */
  compactionFeature?: { threshold: number };
  /**
   * Multiplier on the usable budget. `1` is normal. `0.3` is used after a
   * provider rejects a request as too large — usually because the configured
   * `context_limit` is optimistic for that model.
   */
  budgetScale?: number;
}

export const KIND_PRIORITY: Record<ContextItemKind, number> = {
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
  private items: ContextItem[] = [];
  private readonly options: ContextBuildOptions;
  private dropped: ContextBudgetReport['dropped'] = [];

  constructor(options: ContextBuildOptions) {
    this.options = options;
  }

  add(item: Omit<ContextItem, 'tokens'> & { content: string; tokens?: number }): void {
    const tokens = item.tokens ?? estimateTokens(item.content).tokens;
    this.items.push({ ...item, tokens });
  }

  /**
   * Assemble the final ordered item list under the usable budget.
   * Slices are *per-kind caps based on strategy shares*; the surplus from one
   * kind is never silently given to another kind.
   */
  build(): ContextItem[] {
    const { strategy, modelContextLimit, reserveOutputTokens } = this.options;
    const scale = this.options.budgetScale !== undefined && this.options.budgetScale > 0 ? Math.min(1, this.options.budgetScale) : 1;
    const usable = Math.max(1, Math.floor((modelContextLimit - reserveOutputTokens) * scale));
    const shares = STRATEGY_SHARE[strategy];

    const byKind = new Map<ContextItemKind, ContextItem[]>();
    for (const item of this.items) {
      const list = byKind.get(item.kind) ?? [];
      list.push(item);
      byKind.set(item.kind, list);
    }

    const kindCaps = capsForStrategy(strategy, usable, shares);
    const selected: ContextItem[] = [];
    const dropped: ContextBudgetReport['dropped'] = [];
    let usedTokens = 0;

    // System + task always win regardless of strategy (they are required to
    // behave correctly, not retrieval choices).
    const claim = (item: ContextItem): boolean => {
      if (item.kind === 'system' || item.kind === 'task') return true;
      return false;
    };

    const ordered = [...this.items].sort((a, b) => {
      const pa = claim(a) ? 2 : KIND_PRIORITY[a.kind];
      const pb = claim(b) ? 2 : KIND_PRIORITY[b.kind];
      return pb - pa || b.priority - a.priority;
    });

    const spent = new Map<ContextItemKind, number>();
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
  report(selected: readonly ContextItem[]): ContextBudgetReport {
    const { modelContextLimit, reserveOutputTokens, strategy } = this.options;
    const usable = Math.max(1, modelContextLimit - reserveOutputTokens);
    const usedTokens = selected.reduce((sum, item) => sum + item.tokens, 0);

    const slices: ContextBudgetReport['slices'] = [];
    const byKind = new Map<ContextItemKind, number>();
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

function capsForStrategy(
  strategy: ContextStrategy,
  usable: number,
  shares: Record<'memory' | 'code' | 'tool' | 'map', number>,
): Partial<Record<ContextItemKind, number>> {
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
function orderForProvider(items: readonly ContextItem[]): ContextItem[] {
  return [...items].sort((a, b) => {
    if (a.kind === 'system' && b.kind !== 'system') return -1;
    if (b.kind === 'system' && a.kind !== 'system') return 1;
    return 0;
  });
}

/** Render the memory slice compactly: id, type, scope, summary, confidence. */
export function renderMemoryItems(items: readonly ContextItem[]): string {
  if (items.length === 0) return 'No memories retrieved.';
  const lines = items.map((item, i) => {
    const meta = item.content.split('\n')[0] ?? item.content;
    return `${i + 1}. ${meta} [${item.tokens}t]`;
  });
  return lines.join('\n');
}

export function renderBudgetLine(report: ContextBudgetReport): string {
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

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

export function clampInclude(min: number, value: number, max: number): number {
  return clamp(value, min, max);
}