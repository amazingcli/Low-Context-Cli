/**
 * Persistent project index store (§43, §5, §37).
 *
 * Layout under the project's `index/` directory:
 *
 *   manifest.json      ProjectIndex — file/module id maps + stats
 *   files.jsonl        one IndexedFile per line, appended on change
 *   files.lex.json     persistent BM25 index over path + summary + symbols
 *   modules.json       IndexedModule records
 *
 * Appends are the common case (a few files changed), so the store appends and
 * only rewrites the log when files are removed or compacted. `markStale` is
 * driven by the scanner's hash comparison: the index is allowed to be
 * *possibly* wrong, but it must never claim to be verified when it is not (§51).
 */
import { join } from 'node:path';
import { JsonlLog } from '../storage/jsonl.js';
import { PersistentLexicalIndex } from '../storage/lexical-index.js';
import { atomicWrite, ensureDir, nowIso, readJsonIfExists } from '../core/util.js';
import { newId } from '../core/ids.js';
const INDEX_FORMAT = 1;
/**
 * Increment whenever `analysis.ts` changes what it extracts. Entries written by
 * an older analyser are re-analysed on the next refresh instead of being
 * carried forward with stale (or empty) symbol lists.
 */
export const ANALYZER_VERSION = 3;
export class FileIndexStore {
    dir;
    log;
    lexical;
    byId = new Map();
    byPath = new Map();
    modules = [];
    manifest;
    loaded = false;
    logDirty = false;
    constructor(baseDir) {
        this.dir = join(baseDir, 'index');
        this.log = new JsonlLog(join(this.dir, 'files.jsonl'), { flushEvery: 64 });
        this.lexical = new PersistentLexicalIndex(join(this.dir, 'files.lex.json'));
    }
    manifestPath() {
        return join(this.dir, 'manifest.json');
    }
    modulesPath() {
        return join(this.dir, 'modules.json');
    }
    async load(projectId, root) {
        if (this.loaded && this.manifest?.project_id === projectId)
            return this.manifest;
        await ensureDir(this.dir);
        await this.log.open();
        await this.lexical.load();
        this.byId.clear();
        this.byPath.clear();
        for await (const record of this.log.iterate()) {
            // Later lines win: the log is append-only and edits append a new revision.
            this.byId.set(record.id, record);
            this.byPath.set(record.path, record);
        }
        const seen = await readJsonIfExists(this.manifestPath());
        const modulesFile = await readJsonIfExists(this.modulesPath());
        this.modules = modulesFile?.modules ?? [];
        if (!seen || seen.format !== INDEX_FORMAT || seen.project_id !== projectId) {
            this.manifest = {
                id: newId('idx'),
                project_id: projectId,
                root,
                format: INDEX_FORMAT,
                analyzer: ANALYZER_VERSION,
                created_at: nowIso(),
                updated_at: nowIso(),
                files: {},
                modules: {},
                stats: this.computeStats(),
            };
        }
        else {
            this.manifest = seen;
            this.manifest.root = root;
        }
        this.syncManifestMaps();
        this.loaded = true;
        return this.manifest;
    }
    syncManifestMaps() {
        if (!this.manifest)
            return;
        const files = {};
        for (const file of this.byPath.values())
            files[file.path] = file.id;
        const modules = {};
        for (const module of this.modules)
            modules[module.path] = module.id;
        this.manifest.files = files;
        this.manifest.modules = modules;
    }
    computeStats() {
        const languages = {};
        let symbols = 0;
        let bytes = 0;
        for (const file of this.byPath.values()) {
            languages[file.language] = (languages[file.language] ?? 0) + 1;
            symbols += file.symbols.length;
            bytes += file.size;
        }
        return { files: this.byPath.size, symbols, modules: this.modules.length, bytes, languages, skipped: 0, duration_ms: 0 };
    }
    /* -------------------------------- interface ------------------------------ */
    async loadOrCreate(projectId, root) {
        return this.load(projectId, root);
    }
    async save(index) {
        this.manifest = { ...index, updated_at: nowIso(), stats: this.computeStats() };
        await ensureDir(this.dir);
        await atomicWrite(this.manifestPath(), `${JSON.stringify(this.manifest, null, 2)}\n`);
    }
    async getFile(projectId, path) {
        void projectId;
        await this.ensureLoaded();
        return this.byPath.get(path);
    }
    async getFileById(projectId, fileId) {
        void projectId;
        await this.ensureLoaded();
        return this.byId.get(fileId);
    }
    async upsertFile(projectId, file) {
        void projectId;
        await this.ensureLoaded();
        this.byId.set(file.id, file);
        this.byPath.set(file.path, file);
        await this.log.append(file);
        this.logDirty = true;
        await this.lexical.upsert(file.id, this.searchableText(file), boostFor(file));
    }
    async upsertFiles(projectId, files) {
        void projectId;
        await this.ensureLoaded();
        if (files.length === 0)
            return;
        await this.log.appendMany(files);
        this.logDirty = true;
        for (const file of files) {
            this.byId.set(file.id, file);
            this.byPath.set(file.path, file);
            await this.lexical.upsert(file.id, this.searchableText(file), boostFor(file));
        }
    }
    async removeFile(projectId, path) {
        void projectId;
        await this.ensureLoaded();
        const file = this.byPath.get(path);
        if (!file)
            return false;
        this.byPath.delete(path);
        this.byId.delete(file.id);
        await this.lexical.remove(file.id);
        await this.rewriteLog();
        return true;
    }
    async listFiles(projectId) {
        void projectId;
        await this.ensureLoaded();
        return [...this.byPath.values()];
    }
    async listModules(projectId) {
        void projectId;
        await this.ensureLoaded();
        return [...this.modules];
    }
    async upsertModules(projectId, modules) {
        void projectId;
        await this.ensureLoaded();
        const byPath = new Map(this.modules.map((m) => [m.path, m]));
        for (const module of modules)
            byPath.set(module.path, module);
        this.modules = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
        await atomicWrite(this.modulesPath(), `${JSON.stringify({ version: 1, modules: this.modules }, null, 2)}\n`);
        this.syncManifestMaps();
    }
    async markStale(projectId, paths) {
        void projectId;
        await this.ensureLoaded();
        let marked = 0;
        const updated = [];
        for (const path of paths) {
            const file = this.byPath.get(path);
            if (!file || file.stale)
                continue;
            const next = { ...file, stale: true, verification_state: 'stale' };
            this.byPath.set(path, next);
            this.byId.set(next.id, next);
            updated.push(next);
            marked += 1;
        }
        if (updated.length > 0) {
            await this.log.appendMany(updated);
            this.logDirty = true;
        }
        return marked;
    }
    async searchFiles(projectId, text, limit = 20) {
        void projectId;
        await this.ensureLoaded();
        const hits = await this.lexical.search(text, { limit: Math.max(limit * 3, limit) });
        const out = [];
        for (const hit of hits) {
            const file = this.byId.get(hit.id);
            if (!file)
                continue;
            const symbolMatches = hit.matched.filter((term) => file.symbols.some((symbol) => symbol.toLowerCase().includes(term)));
            out.push({
                file,
                score: hit.score,
                matched: [...new Set([...symbolMatches, ...hit.matched.slice(0, 3)])].slice(0, 6),
            });
            if (out.length >= limit)
                break;
        }
        return out;
    }
    async findSymbol(projectId, name, limit = 20) {
        void projectId;
        await this.ensureLoaded();
        const needle = name.toLowerCase();
        const out = [];
        for (const file of this.byPath.values()) {
            for (const symbol of file.symbols) {
                const lower = symbol.toLowerCase();
                if (lower === needle)
                    out.push({ file, symbol, score: 1 });
                else if (lower.includes(needle))
                    out.push({ file, symbol, score: 0.6 });
                else if (lower.replace(/_/g, '').includes(needle.replace(/_/g, '')))
                    out.push({ file, symbol, score: 0.4 });
                if (out.length >= limit * 2)
                    break;
            }
            if (out.length >= limit * 2)
                break;
        }
        return out.sort((a, b) => b.score - a.score).slice(0, limit);
    }
    async dropProject(projectId) {
        void projectId;
        await this.ensureLoaded();
        this.byId.clear();
        this.byPath.clear();
        this.modules = [];
        await this.log.rewrite([]);
        await this.lexical.reset();
        if (this.manifest) {
            this.manifest.files = {};
            this.manifest.modules = {};
            await this.save(this.manifest);
        }
    }
    async flush() {
        if (!this.loaded)
            return;
        if (this.logDirty) {
            await this.rewriteLog();
            this.logDirty = false;
        }
        await this.log.flush();
        await this.lexical.flush();
        if (this.manifest)
            await this.save(this.manifest);
    }
    /* -------------------------------- internals ------------------------------ */
    async ensureLoaded() {
        if (!this.loaded)
            await this.load(this.manifest?.project_id ?? 'unknown', this.manifest?.root ?? '.');
    }
    searchableText(file) {
        return [
            file.path,
            file.path.replace(/[/._-]/g, ' '),
            file.summary ?? '',
            file.symbols.join(' '),
            file.imports.slice(0, 40).join(' '),
            file.routes?.join(' ') ?? '',
            file.tags?.join(' ') ?? '',
            `lang:${file.language}`,
        ]
            .filter((part) => part !== '')
            .join(' ');
    }
    /** Rewrite the JSONL compactly, dropping superseded revisions. */
    async rewriteLog() {
        const files = [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
        await this.log.rewrite(files);
    }
    /** Remove index entries for paths that no longer exist. */
    async pruneMissing(projectId, existing) {
        void projectId;
        await this.ensureLoaded();
        const toRemove = [];
        for (const path of this.byPath.keys())
            if (!existing.has(path))
                toRemove.push(path);
        for (const path of toRemove)
            await this.removeFile(projectId, path);
        return toRemove.length;
    }
    get fileCount() {
        return this.byPath.size;
    }
    get moduleCount() {
        return this.modules.length;
    }
}
function boostFor(file) {
    // Path-shaped and code-shaped content should outrank prose in the same file.
    return /\.[a-z]{1,5}$/.test(file.path) ? 1.3 : 1;
}
//# sourceMappingURL=index-store.js.map