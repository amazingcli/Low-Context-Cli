/**
 * A persistent BM25 index shared by the memory store and the conversation store.
 *
 * Both need the same thing: "given a query, which records scored highest, and
 * how recently were they touched?" Rather than each store inventing its own
 * scanning strategy, they both delegate here.
 *
 * The index is written through a debounced flush so that hot paths (appending
 * one message) do not pay a full file rewrite, and `flush()` is exposed for
 * shutdown and for `index/status` commands that need a consistent view.
 */
import { readJsonIfExists, atomicWrite, debounce } from '../core/util.js';
import { InvertedIndex } from '../search/bm25.js';
export class PersistentLexicalIndex {
    path;
    index;
    loaded = false;
    dirty = false;
    scheduleFlush;
    constructor(path, flushDelayMs = 800) {
        this.path = path;
        this.index = new InvertedIndex();
        // The debounced callback must call `persistIfDirty`, not `flush`: `flush()`
        // itself drains the pending timer, so calling back into it would recurse.
        this.scheduleFlush = debounce(() => {
            void this.persistIfDirty();
        }, flushDelayMs);
    }
    async load() {
        if (this.loaded)
            return;
        const data = await readJsonIfExists(this.path);
        this.index = InvertedIndex.deserialize(data);
        this.loaded = true;
    }
    get docCount() {
        return this.index.docCount;
    }
    get termCount() {
        return this.index.termCount;
    }
    get approximateBytes() {
        return this.index.approximateBytes();
    }
    has(id) {
        return this.index.has(id);
    }
    /** Insert or replace a document and schedule a flush. */
    async upsert(id, text, boost = 1) {
        await this.load();
        this.index.upsert(id, text, boost);
        this.markDirty();
    }
    /** Add another field to an existing document (e.g. tags after body). */
    async addField(id, text, boost = 1) {
        await this.load();
        this.index.addText(id, text, boost, true);
        this.markDirty();
    }
    async remove(id) {
        await this.load();
        if (this.index.remove(id))
            this.markDirty();
    }
    async removeMany(ids) {
        await this.load();
        let changed = false;
        for (const id of ids)
            if (this.index.remove(id))
                changed = true;
        if (changed)
            this.markDirty();
    }
    async search(text, options = {}) {
        await this.load();
        return this.index.searchText(text, options);
    }
    async searchTerms(terms, options = {}) {
        await this.load();
        return this.index.search(terms, options);
    }
    async prune(keep) {
        await this.load();
        const removed = this.index.prune(keep);
        if (removed > 0)
            this.markDirty();
        return removed;
    }
    markDirty() {
        this.dirty = true;
        this.scheduleFlush();
    }
    async flush() {
        // Drain any pending debounced write, then persist whatever is left.
        this.scheduleFlush.flush();
        await this.persistIfDirty();
    }
    async persistIfDirty() {
        await this.load();
        if (!this.dirty)
            return;
        await atomicWrite(this.path, JSON.stringify(this.index.serialize()));
        this.dirty = false;
    }
    /** Force a full rewrite, ignoring the dirty flag (used by `memory rebuild`). */
    async persist(force = true) {
        if (!force && !this.dirty)
            return;
        await atomicWrite(this.path, JSON.stringify(this.index.serialize()));
        this.dirty = false;
    }
    /** Drop all indexed documents but keep the file (rebuild path). */
    async reset() {
        this.index = new InvertedIndex();
        this.loaded = true;
        this.dirty = true;
        await this.persist();
    }
    snapshot() {
        return this.index.serialize();
    }
}
//# sourceMappingURL=lexical-index.js.map