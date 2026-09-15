/**
 * Ranking and de-duplication (§54, §55).
 *
 * The scoring model is deliberately explicit so it can be explained in a
 * retrieval trace:
 *
 *     score =  lexical*w.lexical
 *            + semantic*w.semantic
 *            + recency*w.recency
 *            + importance*w.importance
 *            + confidence*w.confidence
 *            + exact*w.exact
 *            + task*w.task
 *            - staleness*w.staleness
 *            - redundancy*w.redundancy
 *
 * Every input is normalised to 0..1 first, so a single weight change has a
 * predictable effect. The final term is applied during selection rather than
 * per-candidate, because redundancy is a property of the chosen set.
 */
import { CONFIDENCE_SCORE, IMPORTANCE_ORDER, DEFAULT_WEIGHTS } from '../core/types.js';
import { clamp, jaccard } from '../core/util.js';
import { tokenize } from './tokenize.js';
/** Normalise a BM25 score into 0..1 with a saturating curve. */
export function normalizeLexical(raw, saturation = 8) {
    if (!raw || raw <= 0)
        return 0;
    return clamp(raw / (raw + saturation), 0, 1);
}
/** Exponential recency decay. `halfLifeDays` controls how fast old items fade. */
export function recencyScore(iso, halfLifeDays = 30, at = Date.now()) {
    if (!iso)
        return 0.2;
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return 0.2;
    const ageDays = Math.max(0, at - t) / 86_400_000;
    return clamp(0.5 ** (ageDays / halfLifeDays), 0, 1);
}
export function importanceScore(importance) {
    if (!importance)
        return 0.4;
    return IMPORTANCE_ORDER[importance] / 3;
}
export function confidenceScore(confidence) {
    if (!confidence)
        return 0.4;
    return CONFIDENCE_SCORE[confidence];
}
export function scoreCandidate(input, weights = DEFAULT_WEIGHTS) {
    const lexical = normalizeLexical(input.lexical);
    const semantic = clamp(input.semantic ?? 0, 0, 1);
    const recency = recencyScore(input.updated_at ?? input.created_at);
    const importance = importanceScore(input.importance);
    const confidence = confidenceScore(input.confidence);
    const exact = clamp(input.exact ?? 0, 0, 1);
    const task = clamp(input.task ?? 0, 0, 1);
    const staleness = clamp(input.staleness ?? 0, 0, 1);
    const verified = clamp(input.verified ?? 0, 0, 1);
    const components = {
        lexical: lexical * weights.lexical,
        semantic: semantic * weights.semantic,
        recency: recency * weights.recency,
        importance: importance * weights.importance,
        confidence: confidence * weights.confidence,
        exact: exact * weights.exact,
        task: task * weights.task,
        verified: verified * weights.confidence * 0.5,
        staleness: -(staleness * weights.staleness),
    };
    let score = 0;
    for (const value of Object.values(components))
        score += value;
    const reasons = [];
    if (exact > 0.5)
        reasons.push('exact match');
    if (lexical > 0.05)
        reasons.push('lexical match');
    if (semantic > 0.3)
        reasons.push('semantic match');
    if (task > 0.5)
        reasons.push('task relevance');
    if (importance >= 0.66)
        reasons.push('important');
    if (confidence >= 0.8)
        reasons.push('high confidence');
    if (staleness > 0.5)
        reasons.push('possibly stale');
    if (verified > 0.5)
        reasons.push('source verified');
    return { ...input, score, components, reasons };
}
export function rankCandidates(inputs, weights = DEFAULT_WEIGHTS) {
    return inputs
        .map((input) => scoreCandidate(input, weights))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
/**
 * Greedy maximal-marginal-relevance style selection. Without an embedding
 * model, similarity is lexical (token Jaccard), which already suppresses the
 * common case: the same file retrieved through three different stages (§55).
 */
export function dedupe(items, options = {}) {
    const threshold = options.threshold ?? 0.7;
    const redundancyWeight = options.redundancyWeight ?? DEFAULT_WEIGHTS.redundancy;
    const kept = [];
    const keptTokens = [];
    const keyCounts = new Map();
    const dropped = [];
    for (const item of [...items].sort((a, b) => b.score - a.score)) {
        if (options.keyOf) {
            const key = options.keyOf(item);
            const count = keyCounts.get(key) ?? 0;
            const max = options.maxPerKey ?? 1;
            if (count >= max) {
                dropped.push({ id: item.id, reason: `duplicate ${key}`, similarity: 1 });
                continue;
            }
            keyCounts.set(key, count + 1);
        }
        // Items with no comparable text cannot be judged redundant against each
        // other (Jaccard of two empty sets is 1, which would drop everything).
        const tokens = new Set(tokenize(describeForSimilarity(item)));
        let worst = 0;
        if (tokens.size > 0) {
            for (const existing of keptTokens) {
                if (existing.size === 0)
                    continue;
                const similarity = jaccard(tokens, existing);
                if (similarity > worst)
                    worst = similarity;
            }
        }
        if (worst >= threshold) {
            dropped.push({ id: item.id, reason: 'redundant with higher-ranked item', similarity: worst });
            continue;
        }
        // Apply the redundancy penalty to the score so downstream consumers see it.
        const penalised = worst * redundancyWeight;
        kept.push({
            ...item,
            score: item.score - penalised,
            components: { ...item.components, redundancy: -penalised },
            reasons: penalised > 0 ? [...item.reasons, `redundancy -${penalised.toFixed(3)}`] : item.reasons,
        });
        keptTokens.push(tokens);
    }
    return { kept, dropped };
}
function describeForSimilarity(item) {
    const record = item;
    const parts = [];
    for (const key of ['label', 'content', 'excerpt', 'summary', 'file_path', 'symbol']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '')
            parts.push(value);
    }
    return parts.join(' ');
}
/**
 * Pick the highest-scoring items that fit a token budget. This is the point at
 * which Low Context refuses to "retrieve large quantities simply because they
 * are available" (§13).
 */
export function selectWithinBudget(items, options) {
    const tokensOf = options.tokensOf ?? ((item) => estimateTokensLoose(describeForSimilarity(item)));
    const minScore = options.minScore ?? -Infinity;
    const selected = [];
    const skipped = [];
    let tokens = 0;
    for (const item of [...items].sort((a, b) => b.score - a.score)) {
        if (item.score < minScore) {
            skipped.push({ id: item.id, reason: 'score' });
            continue;
        }
        const cost = tokensOf(item);
        if (tokens + cost > options.maxTokens) {
            skipped.push({ id: item.id, reason: 'budget' });
            continue;
        }
        selected.push(item);
        tokens += cost;
    }
    return { selected, skipped, tokens };
}
export function estimateTokensLoose(text) {
    if (text === '')
        return 0;
    // Rough, provider-agnostic estimate. Context budget code uses the richer
    // estimator in `core/context`; this exists for ranking-time decisions only.
    return Math.ceil(text.length / 4);
}
//# sourceMappingURL=rank.js.map