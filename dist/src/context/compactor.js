import { estimateTokens } from './estimator.js';
// Stem prefixes deliberately have no trailing \b: "decid" must also match
// "decided", and "migrat" must match "migrated".
const DECISION_RE = /\b(decid\w*|we use|we chose|we picked|let'?s use|go with|the reason|because|architect\w*|migrat\w*|adopt\w*|replac\w*|upgrad\w*|downgrad\w*|refactor\w*)\b/i;
const TRY_RE = /\b(try|tried|attempt\w*|fail\w*|error|bug|issue|fix\w*|worked|solved|found)\b/i;
/** Deterministic high-signal extraction when no LLM is available. */
export function extractiveSummarize(messages) {
    const decisions = [];
    const facts = [];
    const notes = [];
    for (const message of messages) {
        if (message.role !== 'user' && message.role !== 'assistant')
            continue;
        const content = message.content.trim();
        if (content.length < 20)
            continue;
        if (message.role === 'user' && DECISION_RE.test(content)) {
            decisions.push(content.slice(0, 260));
        }
        else if (message.role === 'user') {
            facts.push(content.slice(0, 200));
        }
        else if (TRY_RE.test(content)) {
            notes.push(content.slice(0, 200));
        }
    }
    const summaryLines = [];
    if (decisions.length > 0)
        summaryLines.push(`Decisions:\n${decisions.map((d) => `- ${d}`).join('\n')}`);
    if (notes.length > 0)
        summaryLines.push(`Outcomes:\n${notes.slice(-4).map((n) => `- ${n}`).join('\n')}`);
    if (facts.length > 0)
        summaryLines.push(`Context:\n${facts.slice(-5).map((f) => `- ${f}`).join('\n')}`);
    return {
        summary: summaryLines.slice(0, 3).join('\n\n') || 'Conversation contained no extractable decisions.',
        decisions,
        facts,
    };
}
export function shouldCompact(estimatedTokens, usableTokens, threshold) {
    return usableTokens > 0 && estimatedTokens / usableTokens >= threshold;
}
/** Execute a compaction pass over a window of old messages. */
export async function compactMessages(input) {
    const { messages, conversationId, conversationStore, llmSummarize } = input;
    // The window to summarize: assume the first chunk is old history.
    const splitAt = Math.max(1, Math.floor(messages.length / 2));
    const old = messages.slice(0, splitAt);
    const kept = messages.slice(splitAt);
    const extraction = llmSummarize
        ? await llmSummarize(old).catch(() => extractiveSummarize(old))
        : extractiveSummarize(old);
    const tokens_freed = old.reduce((sum, m) => sum + (m.tokens_estimate ?? estimateTokens(m.content).tokens), 0);
    // 1. Persist conversation summary with provenance.
    await conversationStore.updateSummary(conversationId, extraction.summary, old[old.length - 1]?.id ?? '');
    // 2. Write compact memory records, each carrying source references back to
    //    the original messages (§8).
    const writes = [];
    const memoryRecords = [];
    const add = (type, summary, refs) => {
        const record = {
            type,
            scope: input.projectId ? 'project' : 'global',
            summary: summary.slice(0, 400),
            source_refs: refs.slice(0, 8).map((m) => ({
                kind: 'message',
                conversation_id: m.conversation_id,
                message_id: m.id,
                session_id: m.session_id,
            })),
            confidence: 'high',
            importance: type === 'DECISION' ? 'important' : 'normal',
            ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
            ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
            tags: ['compaction', type.toLowerCase()],
        };
        writes.push(record);
        memoryRecords.push({ summary: record.summary, type });
    };
    const last8 = old.slice(-8);
    if (extraction.decisions.length > 0) {
        for (const decision of extraction.decisions.slice(0, 4)) {
            add('DECISION', decision, decisionRefs(decision, last8));
        }
    }
    add('CONVERSATION_SUMMARY', `Conversation ${conversationId} summary: ${extraction.summary}`, last8);
    // Correctness guard: never store refs to messages we did not read.
    writes.forEach((w) => {
        w.source_refs = (w.source_refs ?? []).filter((ref) => ref.message_id && messages.some((m) => m.id === ref.message_id));
    });
    for (const write of writes) {
        await input.memoryStore.write(write).catch(() => undefined);
    }
    return {
        summary: extraction.summary,
        compactedThroughId: old[old.length - 1]?.id ?? '',
        keptMessages: kept,
        memoryRecords,
        tokens_freed,
    };
}
function decisionRefs(decision, messages) {
    const terms = decision.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    return messages.filter((m) => terms.some((t) => m.content.toLowerCase().includes(t)));
}
/** Build the synthetic "conversation summary" context item for the builder. */
export function summaryToInput(summary, throughMessageId, conversationId) {
    return {
        role: 'assistant',
        content: `[Compacted conversation summary (through ${throughMessageId})]\n${summary}`,
        synthetic: true,
        importance: 'important',
        topic: 'conversation-summary',
        session_id: undefined,
        references: [{ kind: 'message', conversation_id: conversationId, message_id: throughMessageId }],
    };
}
//# sourceMappingURL=compactor.js.map