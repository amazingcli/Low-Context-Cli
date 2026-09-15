/**
 * BM25 lexical search with an explicit, serialisable inverted index.
 *
 * This is the backbone of retrieval when no embedding model is configured
 * (§42: "Low Context must still function without an embedding model"). It is a
 * real inverted index with postings lists, document lengths and BM25 scoring —
 * not a linear scan over recent records.
 *
 * Design notes
 * ------------
 * - Postings are `term -> docId -> weight` where weight accumulates tf, scaled
 *   by an optional per-field boost. Indexing a file's symbol names with a boost
 *   while indexing its body at 1.0 makes symbol hits outrank incidental prose.
 * - `serialize()`/`deserialize()` round-trip through plain JSON so the index is
 *   portable and inspectable with `jq`.
 * - Incremental updates are first-class: `upsert` removes the previous postings
 *   for a doc id before adding new ones, which is what keeps re-indexing cheap
 *   (§37).
 */
import { tokenize, termFrequencies } from './tokenize.js';
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export class InvertedIndex {
    postings = new Map();
    lengths = new Map();
    totalLength = 0;
    updatedAt = new Date().toISOString();
    get docCount() {
        return this.lengths.size;
    }
    get termCount() {
        return this.postings.size;
    }
    get averageLength() {
        return this.docCount === 0 ? 0 : this.totalLength / this.docCount;
    }
    has(docId) {
        return this.lengths.has(docId);
    }
    /**
     * Add or replace a document. `boost` scales term frequencies so callers can
     * index high-signal text (names, summaries, paths) more heavily than bodies.
     */
    upsert(docId, text, boost = 1) {
        if (this.lengths.has(docId))
            this.remove(docId);
        this.addText(docId, text, boost, false);
    }
    /** Append text to an existing document (multi-field indexing). */
    addText(docId, text, boost = 1, create = true) {
        const tokens = tokenize(text);
        if (tokens.length === 0) {
            if (create && !this.lengths.has(docId))
                this.lengths.set(docId, 0);
            return;
        }
        const tf = termFrequencies(tokens);
        for (const [term, count] of tf) {
            let list = this.postings.get(term);
            if (!list) {
                list = new Map();
                this.postings.set(term, list);
            }
            const weight = count * boost;
            list.set(docId, (list.get(docId) ?? 0) + weight);
        }
        const added = tokens.length * boost;
        this.lengths.set(docId, (this.lengths.get(docId) ?? 0) + added);
        this.totalLength += added;
        this.updatedAt = new Date().toISOString();
    }
    upsertMany(docs) {
        for (const doc of docs)
            this.upsert(doc.id, doc.text, doc.boost ?? 1);
    }
    remove(docId) {
        const length = this.lengths.get(docId);
        if (length === undefined)
            return false;
        this.totalLength -= length;
        this.lengths.delete(docId);
        // Postings are not indexed by doc; scan terms that were touched. For the
        // index sizes Low Context handles (>=1M docs would need a forward index)
        // a guarded scan is faster than maintaining one more map.
        for (const [term, list] of this.postings) {
            if (list.delete(docId) && list.size === 0)
                this.postings.delete(term);
        }
        return true;
    }
    /** Search with pre-tokenised query terms. */
    search(terms, options = {}) {
        const limit = options.limit ?? 50;
        const minScore = options.minScore ?? 0;
        const unique = [...new Set(terms)].filter((t) => t !== '');
        if (unique.length === 0 || this.docCount === 0)
            return [];
        const avg = this.averageLength || 1;
        const N = this.docCount;
        const scores = new Map();
        const matched = new Map();
        for (const term of unique) {
            const list = this.postings.get(term);
            if (!list || list.size === 0)
                continue;
            const df = list.size;
            const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
            const queryWeight = options.termWeights?.[term] ?? 1;
            for (const [docId, tf] of list) {
                const length = this.lengths.get(docId) ?? 0;
                const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avg);
                const contribution = idf * ((tf * (BM25_K1 + 1)) / (denom || 1)) * queryWeight;
                scores.set(docId, (scores.get(docId) ?? 0) + contribution);
                const list2 = matched.get(docId);
                if (list2)
                    list2.push(term);
                else
                    matched.set(docId, [term]);
            }
        }
        const hits = [];
        for (const [id, score] of scores) {
            if (score < minScore)
                continue;
            const matchedTerms = matched.get(id) ?? [];
            hits.push({ id, score, matched: matchedTerms, coverage: matchedTerms.length / unique.length });
        }
        hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return hits.slice(0, limit);
    }
    /** Convenience: tokenise the query text and search. */
    searchText(query, options = {}) {
        const terms = tokenize(query);
        // Boost any identifier-looking term that appears verbatim in the query.
        const termWeights = {};
        for (const term of terms)
            termWeights[term] = (termWeights[term] ?? 1) * 1;
        return this.search(terms, { ...options, termWeights: { ...termWeights, ...options.termWeights } });
    }
    /** Documents containing every term (cheap boolean filter used by retrieval). */
    intersect(terms) {
        const unique = [...new Set(terms)].filter((t) => t !== '');
        if (unique.length === 0)
            return [];
        let result;
        for (const term of unique) {
            const list = this.postings.get(term);
            const set = new Set(list ? list.keys() : []);
            if (result === undefined)
                result = set;
            else {
                for (const id of result)
                    if (!set.has(id))
                        result.delete(id);
            }
            if (result.size === 0)
                return [];
        }
        return [...(result ?? [])];
    }
    serialize() {
        const postings = {};
        for (const [term, list] of this.postings)
            postings[term] = [...list.entries()];
        const lengths = {};
        for (const [id, length] of this.lengths)
            lengths[id] = length;
        return {
            version: 1,
            doc_count: this.docCount,
            total_length: this.totalLength,
            lengths,
            postings,
            updated_at: this.updatedAt,
        };
    }
    static deserialize(data) {
        const index = new InvertedIndex();
        if (!data || data.version !== 1)
            return index;
        for (const [id, length] of Object.entries(data.lengths ?? {}))
            index.lengths.set(id, length);
        index.totalLength = data.total_length ?? 0;
        for (const [term, entries] of Object.entries(data.postings ?? {})) {
            const map = new Map();
            for (const [docId, weight] of entries)
                map.set(docId, weight);
            if (map.size > 0)
                index.postings.set(term, map);
        }
        index.updatedAt = data.updated_at ?? new Date().toISOString();
        return index;
    }
    /** Drop documents not present in `keep` — used by retention/pruning. */
    prune(keep) {
        let removed = 0;
        for (const id of [...this.lengths.keys()]) {
            if (!keep(id)) {
                this.remove(id);
                removed += 1;
            }
        }
        return removed;
    }
    /** Approximate resident size, useful for `doctor` and benchmarks. */
    approximateBytes() {
        let bytes = 0;
        for (const [term, list] of this.postings) {
            bytes += term.length * 2 + 16;
            bytes += list.size * 24;
        }
        bytes += this.lengths.size * 32;
        return bytes;
    }
}
//# sourceMappingURL=bm25.js.map