/**
 * Persistent conversation storage (§7).
 *
 * Layout (under a session base directory):
 *
 *   conversations/<conv_id>.meta.json      conversation metadata
 *   conversations/<conv_id>.jsonl          append-only message log
 *   conversations/<conv_id>.jsonl.offsets.json
 *   conversations/messages.lex.json        global BM25 index over message text
 *   conversations/catalog.jsonl            message id -> (conversation, ordinal)
 *
 * Why the catalog exists: a memory record's `source_refs` point at individual
 * message ids. Resolving `msg_abc` back to its original content must be O(1)
 * even when the project has a million messages, and it must not require
 * replaying the conversation into the model's context (§8, §27).
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonlLog } from './jsonl.js';
import { PersistentLexicalIndex } from './lexical-index.js';
import { ensureDir, nowIso, atomicWrite, readJsonIfExists, safeJsonParse } from '../core/util.js';
import { newId } from '../core/ids.js';
import { estimateTokens } from '../context/estimator.js';
export class FileConversationStore {
    dir;
    logs = new Map();
    metas = new Map();
    index;
    catalog;
    catalogLog;
    indexDirtyIds = new Set();
    constructor(options) {
        this.dir = join(options.baseDir, 'conversations');
        this.index = new PersistentLexicalIndex(join(this.dir, 'messages.lex.json'));
    }
    async ensure() {
        await ensureDir(this.dir);
    }
    metaPath(id) {
        return join(this.dir, `${id}.meta.json`);
    }
    logPath(id) {
        return join(this.dir, `${id}.jsonl`);
    }
    async log(id) {
        let existing = this.logs.get(id);
        if (!existing) {
            existing = new JsonlLog(this.logPath(id));
            await existing.open();
            this.logs.set(id, existing);
        }
        return existing;
    }
    async loadCatalog() {
        if (this.catalog)
            return this.catalog;
        await this.ensure();
        const path = join(this.dir, 'catalog.jsonl');
        const log = new JsonlLog(path, { flushEvery: 256 });
        await log.open();
        this.catalogLog = log;
        const map = new Map();
        for await (const entry of log.iterate())
            map.set(entry.id, entry);
        this.catalog = map;
        return map;
    }
    async create(input = {}) {
        await this.ensure();
        const now = nowIso();
        const conversation = {
            id: newId('conv'),
            created_at: now,
            updated_at: now,
            message_count: 0,
            byte_length: 0,
            ...(input.project_id === undefined ? {} : { project_id: input.project_id }),
            ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
            ...(input.title === undefined ? {} : { title: input.title }),
        };
        this.metas.set(conversation.id, conversation);
        await atomicWrite(this.metaPath(conversation.id), `${JSON.stringify(conversation, null, 2)}\n`);
        await this.log(conversation.id);
        return conversation;
    }
    async get(id) {
        const cached = this.metas.get(id);
        if (cached)
            return cached;
        const meta = await readJsonIfExists(this.metaPath(id));
        if (meta)
            this.metas.set(id, meta);
        return meta;
    }
    async list(input = {}) {
        await this.ensure();
        const entries = await readdir(this.dir).catch(() => []);
        const out = [];
        for (const name of entries) {
            if (!name.endsWith('.meta.json'))
                continue;
            const id = name.slice(0, -'.meta.json'.length);
            const meta = await this.get(id);
            if (!meta)
                continue;
            if (input.project_id && meta.project_id !== input.project_id)
                continue;
            out.push(meta);
        }
        out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return input.limit ? out.slice(0, input.limit) : out;
    }
    async append(conversationId, input) {
        const [message] = await this.appendMany(conversationId, [input]);
        return message;
    }
    async appendMany(conversationId, inputs) {
        await this.ensure();
        if (inputs.length === 0)
            return [];
        const conversation = (await this.get(conversationId)) ?? (await this.create({}));
        const log = await this.log(conversationId);
        const catalog = await this.loadCatalog();
        const messages = [];
        for (const input of inputs) {
            const message = {
                id: input.id ?? newId('msg'),
                conversation_id: conversationId,
                timestamp: input.timestamp ?? nowIso(),
                role: input.role,
                content: input.content,
                tokens_estimate: input.tokens_estimate ?? estimateTokens(input.content).tokens,
                ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
                ...(input.tool_calls === undefined ? {} : { tool_calls: input.tool_calls }),
                ...(input.tool_call_id === undefined ? {} : { tool_call_id: input.tool_call_id }),
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.importance === undefined ? {} : { importance: input.importance }),
                ...(input.topic === undefined ? {} : { topic: input.topic }),
                ...(input.summary === undefined ? {} : { summary: input.summary }),
                ...(input.references === undefined ? {} : { references: input.references }),
                ...(input.synthetic === undefined ? {} : { synthetic: input.synthetic }),
            };
            messages.push(message);
        }
        await log.appendMany(messages);
        for (let i = 0; i < messages.length; i += 1) {
            const message = messages[i];
            const ordinal = log.size - messages.length + i;
            catalog.set(message.id, { id: message.id, conversation_id: conversationId, ordinal });
            await this.catalogLog?.append({ id: message.id, conversation_id: conversationId, ordinal });
            message.tokens_estimate = message.tokens_estimate ?? 0;
            this.indexDirtyIds.add(message.id);
        }
        conversation.message_count += messages.length;
        conversation.updated_at = nowIso();
        conversation.byte_length = log.size;
        conversation.last_message_id = messages[messages.length - 1]?.id;
        this.metas.set(conversationId, conversation);
        await atomicWrite(this.metaPath(conversationId), `${JSON.stringify(conversation, null, 2)}\n`);
        // Index the new content. Only user/assistant/tool text is searchable —
        // system prompts are noise and would pollute retrieval.
        for (const message of messages) {
            if (message.role === 'system')
                continue;
            if (message.content.trim() === '')
                continue;
            const label = message.topic ? `${message.topic} ${message.content}` : message.content;
            await this.index.upsert(message.id, label, message.role === 'user' ? 1.2 : 1);
        }
        this.indexDirtyIds.clear();
        return messages;
    }
    async messages(conversationId, options = {}) {
        const log = await this.log(conversationId);
        const offset = options.offset ?? 0;
        const count = options.limit ?? log.size;
        return log.range(offset, count);
    }
    async recentMessages(conversationId, count) {
        const log = await this.log(conversationId);
        return log.tail(count);
    }
    async searchMessages(query) {
        const limit = query.limit ?? 20;
        if (query.text.trim() === '')
            return [];
        // Over-fetch so metadata filters (conversation, role, time) can be applied
        // after scoring without a second index pass.
        const hits = await this.index.search(query.text, { limit: limit * 6 });
        if (hits.length === 0)
            return [];
        const catalog = await this.loadCatalog();
        const results = [];
        const metaCache = new Map();
        for (const hit of hits) {
            const entry = catalog.get(hit.id);
            if (!entry)
                continue;
            if (query.conversation_id && entry.conversation_id !== query.conversation_id)
                continue;
            let message = metaCache.get(hit.id);
            if (!message) {
                const log = await this.log(entry.conversation_id);
                const found = await log.at(entry.ordinal);
                if (!found)
                    continue;
                message = found;
                metaCache.set(hit.id, found);
            }
            if (query.roles && !query.roles.includes(message.role))
                continue;
            if (query.session_id && message.session_id !== query.session_id)
                continue;
            if (query.since && message.timestamp < query.since)
                continue;
            if (query.project_id) {
                const conversation = await this.get(entry.conversation_id);
                if (conversation?.project_id !== query.project_id)
                    continue;
            }
            results.push({
                message,
                score: hit.score,
                reason: `lexical match (${hit.matched.slice(0, 5).join(', ')})`,
            });
            if (results.length >= limit)
                break;
        }
        return results;
    }
    async messagesByIds(ids) {
        if (ids.length === 0)
            return [];
        const catalog = await this.loadCatalog();
        const out = [];
        for (const id of ids) {
            const entry = catalog.get(id);
            if (!entry)
                continue;
            const log = await this.log(entry.conversation_id);
            const message = await log.at(entry.ordinal);
            if (message)
                out.push(message);
        }
        return out;
    }
    async updateSummary(conversationId, summary, throughMessageId) {
        const conversation = await this.get(conversationId);
        if (!conversation)
            return;
        conversation.summary = summary;
        conversation.summary_through_message_id = throughMessageId;
        conversation.updated_at = nowIso();
        this.metas.set(conversationId, conversation);
        await atomicWrite(this.metaPath(conversationId), `${JSON.stringify(conversation, null, 2)}\n`);
    }
    async delete(conversationId) {
        const existed = (await this.get(conversationId)) !== undefined;
        this.metas.delete(conversationId);
        const log = this.logs.get(conversationId);
        if (log) {
            await log.close();
            this.logs.delete(conversationId);
        }
        await rm(this.metaPath(conversationId), { force: true });
        await rm(this.logPath(conversationId), { force: true });
        await rm(`${this.logPath(conversationId)}.offsets.json`, { force: true });
        // Drop the deleted messages from the search index.
        const catalog = await this.loadCatalog();
        const gone = [...catalog.values()].filter((e) => e.conversation_id === conversationId).map((e) => e.id);
        for (const id of gone)
            catalog.delete(id);
        await this.index.removeMany(gone);
        return existed;
    }
    async count(conversationId) {
        if (conversationId) {
            const conversation = await this.get(conversationId);
            return conversation?.message_count ?? 0;
        }
        const conversations = await this.list();
        return conversations.reduce((sum, c) => sum + c.message_count, 0);
    }
    async retain(conversationId, keep) {
        const log = await this.log(conversationId);
        const removed = [];
        const { removed: removedCount } = await log.retain((message) => {
            const verdict = keep(message);
            if (!verdict)
                removed.push(message.id);
            return verdict;
        });
        await this.index.removeMany(removed);
        const catalog = await this.loadCatalog();
        for (const id of removed)
            catalog.delete(id);
        const conversation = await this.get(conversationId);
        if (conversation) {
            conversation.message_count = log.size;
            conversation.updated_at = nowIso();
            await atomicWrite(this.metaPath(conversationId), `${JSON.stringify(conversation, null, 2)}\n`);
        }
        return removedCount;
    }
    async flush() {
        for (const log of this.logs.values())
            await log.flush();
        await this.catalogLog?.flush();
        await this.index.flush();
    }
    /** Diagnostics for `doctor`. */
    async stats() {
        const conversations = await this.list();
        const catalog = await this.loadCatalog();
        return {
            conversations: conversations.length,
            messages: conversations.reduce((sum, c) => sum + c.message_count, 0),
            indexed_docs: this.index.docCount,
            catalog_entries: catalog.size,
        };
    }
    /** Repair pass: rebuild the catalog and search index from the message logs. */
    async rebuild() {
        const started = Date.now();
        await this.index.reset();
        const conversations = await this.list();
        let messages = 0;
        const entries = [];
        for (const conversation of conversations) {
            const log = await this.log(conversation.id);
            let ordinal = 0;
            for await (const message of log.iterate()) {
                entries.push({ id: message.id, conversation_id: conversation.id, ordinal });
                ordinal += 1;
                messages += 1;
                if (message.role === 'system' || message.content.trim() === '')
                    continue;
                const label = message.topic ? `${message.topic} ${message.content}` : message.content;
                await this.index.upsert(message.id, label, message.role === 'user' ? 1.2 : 1);
            }
            conversation.message_count = ordinal;
        }
        await this.catalogLog?.rewrite(entries);
        this.catalog = new Map(entries.map((e) => [e.id, e]));
        await this.index.flush();
        return { conversations: conversations.length, messages, duration_ms: Date.now() - started };
    }
}
/** Convenience: parse a message id without throwing on garbage input. */
export function isMessageId(value) {
    return safeJsonParse(JSON.stringify(value)).ok && value.startsWith('msg_');
}
//# sourceMappingURL=conversation-store.js.map