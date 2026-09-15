/**
 * Memory tools (§19, §48, §65).
 *
 * The agent may *search* memory freely, but it may only *write* memory under
 * narrow rules. `remember` exists for the case where the user said something
 * durable and wants it kept; it records the source reference so the record can
 * always be traced back. Nothing here lets a model promote its own guess into a
 * project fact (§35, §82).
 *
 * Reading a memory answers "what do I know", never "what is true". Anything the
 * agent acts on must still be verified against the source (§16).
 */
import { newId } from '../core/ids.js';
import { asNumber, asOptionalString, asString, asStringArray, booleanProp, enumProp, numberProp, objectSchema, stringProp } from './types.js';
import { parseMemoryControl } from '../memory/engine.js';
const MEMORY_TYPES = [
    'FACT',
    'DECISION',
    'PREFERENCE',
    'TASK',
    'PROJECT_KNOWLEDGE',
    'ARCHITECTURE',
    'BUG',
    'FIX',
    'FILE_KNOWLEDGE',
    'COMMAND_RESULT',
    'CONVERSATION_SUMMARY',
    'USER_INSTRUCTION',
];
const rememberTool = {
    name: 'remember',
    description: 'Store a durable memory record. Only use this for information the user explicitly asked to keep, or for a decision that was actually made in this conversation. Records are external storage, not model training.',
    category: 'memory',
    mutating: true,
    parameters: objectSchema({
        summary: stringProp('The fact, decision or preference to keep, stated plainly.'),
        type: enumProp('Memory category.', MEMORY_TYPES),
        importance: enumProp('How strongly this should surface later.', ['temporary', 'normal', 'important', 'critical']),
        tags: stringProp('Comma-separated tags.'),
        source_message_id: stringProp('Message id this memory came from, when known.'),
        file_path: stringProp('Related project-relative file, when the memory is about a file.'),
    }, ['summary']),
    permission: () => ({ summary: 'write a memory record', resource: 'tool', subject: 'remember', destructive: false }),
    async run(args, ctx) {
        if (!ctx.memoryStore)
            return { ok: false, summary: 'Memory storage is not available.', error: 'no memory store' };
        const summary = asString(args, 'summary').trim();
        if (summary === '')
            return { ok: false, summary: 'summary must not be empty', error: 'empty summary' };
        const type = asOptionalString(args, 'type') ?? 'FACT';
        if (!MEMORY_TYPES.includes(type))
            return { ok: false, summary: `unknown memory type: ${type}`, error: 'bad type' };
        const importance = asOptionalString(args, 'importance') ?? 'important';
        const tags = asStringArray({ tags: asOptionalString(args, 'tags') ?? '' }, 'tags')
            .flatMap((t) => t.split(','))
            .map((t) => t.trim())
            .filter((t) => t !== '');
        const sourceMessageId = asOptionalString(args, 'source_message_id');
        const filePath = asOptionalString(args, 'file_path');
        const record = await ctx.memoryStore.write({
            type,
            scope: ctx.projectId ? (ctx.taskId ? 'task' : 'project') : 'global',
            summary: summary.slice(0, 600),
            tags,
            confidence: 'verified',
            importance,
            verification_state: 'verified',
            source_refs: [
                ...(sourceMessageId || ctx.sessionId
                    ? [
                        {
                            kind: 'message',
                            ...(ctx.projectId === undefined ? {} : { project_id: ctx.projectId }),
                            ...(sourceMessageId === undefined ? {} : { message_id: sourceMessageId }),
                            ...(ctx.sessionId === undefined ? {} : { session_id: ctx.sessionId }),
                        },
                    ]
                    : []),
                ...(filePath ? [{ kind: 'file', file_path: filePath }] : []),
            ],
            ...(ctx.projectId === undefined ? {} : { project_id: ctx.projectId }),
            ...(ctx.sessionId === undefined ? {} : { session_id: ctx.sessionId }),
            ...(ctx.taskId === undefined ? {} : { task_id: ctx.taskId }),
        });
        ctx.events.record('memory_write', `remembered ${type}: ${summary.slice(0, 80)}`, { memory_id: record.id });
        return {
            summary: `Stored memory ${record.id} (${record.type}, ${record.importance}, confidence ${record.confidence}). This is external storage; it does not change the model.`,
            verification_state: 'verified',
            data: { memory_id: record.id },
        };
    },
};
const searchMemoryTool = {
    name: 'search_memory',
    description: 'Search stored memory records by keyword. Returns summaries with ids, confidence and importance. A memory summarises the past — verify against the source before acting on it.',
    category: 'memory',
    mutating: false,
    parameters: objectSchema({
        query: stringProp('What to search for.'),
        type: enumProp('Restrict to one memory category.', MEMORY_TYPES),
        limit: numberProp('Maximum records to return. Default 8.', { minimum: 1, maximum: 50 }),
        include_superseded: booleanProp('Include records that have been replaced by a newer one.'),
    }, ['query']),
    async run(args, ctx) {
        if (!ctx.memoryStore)
            return { ok: false, summary: 'Memory storage is not available.', error: 'no memory store' };
        const query = asString(args, 'query');
        const type = asOptionalString(args, 'type');
        const limit = asNumber(args, 'limit', { fallback: 8 });
        const hits = await ctx.memoryStore.search({
            text: query,
            limit,
            include_superseded: args.include_superseded === true,
            ...(ctx.projectId === undefined ? {} : { project_id: ctx.projectId }),
            ...(type === undefined ? {} : { types: [type] }),
        });
        if (hits.length === 0)
            return { summary: `No memory records match "${query}".`, verification_state: 'unknown' };
        const lines = hits.map((hit, i) => `${i + 1}. [${hit.record.id}] ${hit.record.type}/${hit.record.importance}/${hit.record.confidence} score=${hit.score.toFixed(2)}\n   ${hit.record.summary}\n   (${hit.reason}${hit.record.status !== 'current' ? `, ${hit.record.status}` : ''})`);
        return {
            summary: `${hits.length} memory record(s) for "${query}":\n${lines.join('\n')}`,
            verification_state: 'indexed',
            data: { memory_ids: hits.map((h) => h.record.id) },
        };
    },
};
const showMemoryTool = {
    name: 'show_memory',
    description: 'Show one memory record in full, including its source references, so the original material can be retrieved.',
    category: 'memory',
    mutating: false,
    parameters: objectSchema({ id: stringProp('Memory id, e.g. mem_xxx.') }, ['id']),
    async run(args, ctx) {
        if (!ctx.memoryStore)
            return { ok: false, summary: 'Memory storage is not available.', error: 'no memory store' };
        const record = await ctx.memoryStore.get(asString(args, 'id'));
        if (!record)
            return { ok: false, summary: 'No such memory record.', error: 'not found' };
        const lines = [
            `${record.id}  ${record.type}  scope=${record.scope}  importance=${record.importance}  confidence=${record.confidence}  status=${record.status}`,
            `created: ${record.created_at}   updated: ${record.updated_at}`,
            `summary: ${record.summary}`,
        ];
        if (record.detail)
            lines.push(`detail: ${record.detail}`);
        if (record.tags.length > 0)
            lines.push(`tags: ${record.tags.join(', ')}`);
        if (record.superseded_by)
            lines.push(`superseded by: ${record.superseded_by}`);
        if (record.source_refs.length > 0) {
            lines.push('sources:');
            for (const ref of record.source_refs) {
                lines.push(`  - ${ref.kind}${ref.file_path ? ` file=${ref.file_path}` : ''}${ref.message_id ? ` message=${ref.message_id}` : ''}${ref.commit ? ` commit=${ref.commit}` : ''}`);
            }
        }
        else {
            lines.push('sources: (none recorded — treat this as unverified)');
        }
        return { summary: lines.join('\n'), verification_state: record.verification_state };
    },
};
const forgetTool = {
    name: 'forget',
    description: 'Delete memory records matching a query. The user is always in control of persistent memory.',
    category: 'memory',
    mutating: true,
    parameters: objectSchema({
        query: stringProp('Text to match against memory summaries.'),
        limit: numberProp('Maximum records to delete. Default 5.', { minimum: 1, maximum: 100 }),
    }, ['query']),
    permission: (args) => ({
        summary: `delete memory matching "${asOptionalString(args, 'query') ?? '?'}"`,
        resource: 'tool',
        subject: 'forget',
        destructive: true,
    }),
    async run(args, ctx) {
        if (!ctx.memoryStore)
            return { ok: false, summary: 'Memory storage is not available.', error: 'no memory store' };
        const query = asString(args, 'query');
        const limit = asNumber(args, 'limit', { fallback: 5 });
        const hits = await ctx.memoryStore.search({ text: query, limit });
        if (hits.length === 0)
            return { summary: `No memory records matched "${query}"; nothing deleted.`, verification_state: 'unknown' };
        let deleted = 0;
        const removed = [];
        for (const hit of hits) {
            if (await ctx.memoryStore.delete(hit.record.id)) {
                deleted += 1;
                removed.push(hit.record.id);
            }
        }
        return {
            summary: `Deleted ${deleted} memory record(s): ${removed.join(', ')}`,
            verification_state: 'verified',
            data: { deleted },
        };
    },
};
const searchConversationsTool = {
    name: 'search_conversations',
    description: 'Search historical conversation messages across sessions and projects. Use this for "what did we decide earlier" questions instead of relying on the current chat window.',
    category: 'memory',
    mutating: false,
    parameters: objectSchema({
        query: stringProp('What to search for.'),
        limit: numberProp('Maximum messages to return. Default 10.', { minimum: 1, maximum: 50 }),
        project_only: booleanProp('Restrict to the current project. Defaults to true.'),
    }, ['query']),
    async run(args, ctx) {
        if (!ctx.conversationStore)
            return { ok: false, summary: 'Conversation storage is not available.', error: 'no conversation store' };
        const query = asString(args, 'query');
        const limit = asNumber(args, 'limit', { fallback: 10 });
        const projectOnly = args.project_only !== false;
        const hits = await ctx.conversationStore.searchMessages({
            text: query,
            limit,
            ...(projectOnly && ctx.projectId ? { project_id: ctx.projectId } : {}),
        });
        if (hits.length === 0)
            return { summary: `No historical messages match "${query}".`, verification_state: 'unknown' };
        const lines = hits.map((hit, i) => {
            const snippet = hit.message.content.replace(/\s+/g, ' ').slice(0, 260);
            return `${i + 1}. [${hit.message.id}] ${hit.message.role} @ ${hit.message.timestamp.slice(0, 19)} (conv ${hit.message.conversation_id})\n   ${snippet}`;
        });
        return {
            summary: `${hits.length} historical message(s) for "${query}":\n${lines.join('\n')}`,
            verification_state: 'verified',
            data: { message_ids: hits.map((h) => h.message.id) },
        };
    },
};
const readMessagesTool = {
    name: 'read_messages',
    description: 'Read the original text of specific conversation messages by id, to check a summary against its source.',
    category: 'memory',
    mutating: false,
    parameters: objectSchema({
        ids: stringProp('Comma-separated message ids.'),
        limit: numberProp('Maximum messages to return. Default 10.', { minimum: 1, maximum: 50 }),
    }, ['ids']),
    async run(args, ctx) {
        if (!ctx.conversationStore)
            return { ok: false, summary: 'Conversation storage is not available.', error: 'no conversation store' };
        const ids = asString(args, 'ids')
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id !== '');
        if (ids.length === 0)
            return { ok: false, summary: 'no message ids given', error: 'no ids' };
        const messages = await ctx.conversationStore.messagesByIds(ids);
        if (messages.length === 0)
            return { ok: false, summary: 'none of those message ids exist', error: 'not found' };
        const body = messages.map((m) => `[${m.id}] ${m.role} @ ${m.timestamp}\n${m.content}`).join('\n\n');
        return { summary: body.slice(0, 16_000), output: body, verification_state: 'verified' };
    },
};
/** Detect and apply an explicit memory directive inside a user message. */
export async function applyMemoryDirective(message, ctx) {
    const control = parseMemoryControl(message);
    if (control.type === 'none')
        return { handled: false, cleaned: message };
    if (!ctx.memoryStore)
        return { handled: false, cleaned: message };
    if (control.type === 'remember') {
        const match = /^(?:please\s+)?(?:remember|memorize|note(?: down)?)\s*(?:this|that)?\s*:?\s*(.+)$/is.exec(message.trim());
        const payload = (match?.[1] ?? '').trim();
        if (payload.length >= 4) {
            const record = await ctx.memoryStore.write({
                type: 'USER_INSTRUCTION',
                scope: ctx.projectId ? (ctx.taskId ? 'task' : 'project') : 'global',
                summary: payload.replace(/\s+/g, ' ').slice(0, 600),
                tags: ['user-instruction'],
                confidence: 'verified',
                importance: 'important',
                verification_state: 'verified',
                source_refs: [],
                ...(ctx.projectId === undefined ? {} : { project_id: ctx.projectId }),
                ...(ctx.sessionId === undefined ? {} : { session_id: ctx.sessionId }),
                ...(ctx.taskId === undefined ? {} : { task_id: ctx.taskId }),
            });
            return { handled: true, note: `Stored memory ${record.id}.`, cleaned: '' };
        }
    }
    if (control.type === 'forget') {
        const target = (control.target ?? '').trim();
        if (target !== '') {
            const hits = await ctx.memoryStore.search({ text: target, limit: 10 });
            for (const hit of hits)
                await ctx.memoryStore.delete(hit.record.id);
            return { handled: true, note: `Forgot ${hits.length} memory record(s) matching "${target}".`, cleaned: '' };
        }
    }
    return { handled: false, cleaned: message };
}
/** Stable id for a synthesized memory in tests. */
export function memoryId() {
    return newId('mem');
}
export function memoryTools() {
    return [rememberTool, searchMemoryTool, showMemoryTool, forgetTool, searchConversationsTool, readMessagesTool];
}
//# sourceMappingURL=memory.js.map