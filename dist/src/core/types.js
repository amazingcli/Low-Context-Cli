/**
 * Core domain types for Low Context (see §83 "Important internal objects").
 *
 * These are the stable vocabulary that every subsystem shares. Two invariants
 * are encoded here on purpose:
 *
 *  1. Every durable record can point back at its *source* (`SourceReference`).
 *     A summary or index entry never replaces the original (§8, §50).
 *  2. Every durable record carries `confidence` and `status`, so retrieval can
 *     tell a verified fact apart from an old inference (§36, §51).
 *
 * Nothing here implies model training. Memory is external storage that is
 * indexed and retrieved (§3, §52).
 */
export const DEFAULT_WEIGHTS = {
    lexical: 1,
    semantic: 0.8,
    recency: 0.25,
    importance: 0.35,
    confidence: 0.3,
    exact: 0.6,
    task: 0.4,
    staleness: 0.5,
    redundancy: 0.7,
};
export const IMPORTANCE_ORDER = {
    temporary: 0,
    normal: 1,
    important: 2,
    critical: 3,
};
export const CONFIDENCE_SCORE = {
    verified: 1,
    high: 0.8,
    medium: 0.55,
    low: 0.3,
    unknown: 0.15,
};
export const STRATEGY_SHARE = {
    minimal: { memory: 0.08, code: 0.3, tool: 0.08, map: 0.04 },
    balanced: { memory: 0.12, code: 0.42, tool: 0.14, map: 0.07 },
    deep: { memory: 0.18, code: 0.5, tool: 0.18, map: 0.09 },
    maximum: { memory: 0.24, code: 0.55, tool: 0.22, map: 0.12 },
};
//# sourceMappingURL=types.js.map