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
import type { IndexedFile, IndexedModule, ProjectIndex, VerificationState } from '../core/types.js';
import type { IndexStore } from '../storage/interfaces.js';

const INDEX_FORMAT = 1;

/**
 * Increment whenever `analysis.ts` changes what it extracts. Entries written by
 * an older analyser are re-analysed on the next refresh instead of being
 * carried forward with stale (or empty) symbol lists.
 */
export const ANALYZER_VERSION = 3;

interface ModuleFile {
  version: 1;
  modules: IndexedModule[];
}

export class FileIndexStore implements IndexStore {
  private readonly dir: string;
  private readonly log: JsonlLog<IndexedFile>;
  private readonly lexical: PersistentLexicalIndex;
  private byId = new Map<string, IndexedFile>();
  private byPath = new Map<string, IndexedFile>();
  private modules: IndexedModule[] = [];
  private manifest: ProjectIndex | undefined;
  private loaded = false;
  private logDirty = false;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'index');
    this.log = new JsonlLog<IndexedFile>(join(this.dir, 'files.jsonl'), { flushEvery: 64 });
    this.lexical = new PersistentLexicalIndex(join(this.dir, 'files.lex.json'));
  }

  private manifestPath(): string {
    return join(this.dir, 'manifest.json');
  }

  private modulesPath(): string {
    return join(this.dir, 'modules.json');
  }

  async load(projectId: string, root: string): Promise<ProjectIndex> {
    if (this.loaded && this.manifest?.project_id === projectId) return this.manifest;
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

    const seen = await readJsonIfExists<ProjectIndex>(this.manifestPath());
    const modulesFile = await readJsonIfExists<ModuleFile>(this.modulesPath());
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
    } else {
      this.manifest = seen;
      this.manifest.root = root;
    }
    this.syncManifestMaps();
    this.loaded = true;
    return this.manifest;
  }

  private syncManifestMaps(): void {
    if (!this.manifest) return;
    const files: Record<string, string> = {};
    for (const file of this.byPath.values()) files[file.path] = file.id;
    const modules: Record<string, string> = {};
    for (const module of this.modules) modules[module.path] = module.id;
    this.manifest.files = files;
    this.manifest.modules = modules;
  }

  private computeStats(): ProjectIndex['stats'] {
    const languages: Record<string, number> = {};
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

  async loadOrCreate(projectId: string, root: string): Promise<ProjectIndex> {
    return this.load(projectId, root);
  }

  async save(index: ProjectIndex): Promise<void> {
    this.manifest = { ...index, updated_at: nowIso(), stats: this.computeStats() };
    await ensureDir(this.dir);
    await atomicWrite(this.manifestPath(), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  async getFile(projectId: string, path: string): Promise<IndexedFile | undefined> {
    void projectId;
    await this.ensureLoaded();
    return this.byPath.get(path);
  }

  async getFileById(projectId: string, fileId: string): Promise<IndexedFile | undefined> {
    void projectId;
    await this.ensureLoaded();
    return this.byId.get(fileId);
  }

  async upsertFile(projectId: string, file: IndexedFile): Promise<void> {
    void projectId;
    await this.ensureLoaded();
    this.byId.set(file.id, file);
    this.byPath.set(file.path, file);
    await this.log.append(file);
    this.logDirty = true;
    await this.lexical.upsert(file.id, this.searchableText(file), boostFor(file));
  }

  async upsertFiles(projectId: string, files: readonly IndexedFile[]): Promise<void> {
    void projectId;
    await this.ensureLoaded();
    if (files.length === 0) return;
    await this.log.appendMany(files as IndexedFile[]);
    this.logDirty = true;
    for (const file of files) {
      this.byId.set(file.id, file);
      this.byPath.set(file.path, file);
      await this.lexical.upsert(file.id, this.searchableText(file), boostFor(file));
    }
  }

  async removeFile(projectId: string, path: string): Promise<boolean> {
    void projectId;
    await this.ensureLoaded();
    const file = this.byPath.get(path);
    if (!file) return false;
    this.byPath.delete(path);
    this.byId.delete(file.id);
    await this.lexical.remove(file.id);
    await this.rewriteLog();
    return true;
  }

  async listFiles(projectId: string): Promise<IndexedFile[]> {
    void projectId;
    await this.ensureLoaded();
    return [...this.byPath.values()];
  }

  async listModules(projectId: string): Promise<IndexedModule[]> {
    void projectId;
    await this.ensureLoaded();
    return [...this.modules];
  }

  async upsertModules(projectId: string, modules: readonly IndexedModule[]): Promise<void> {
    void projectId;
    await this.ensureLoaded();
    const byPath = new Map(this.modules.map((m) => [m.path, m]));
    for (const module of modules) byPath.set(module.path, module);
    this.modules = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    await atomicWrite(this.modulesPath(), `${JSON.stringify({ version: 1, modules: this.modules } satisfies ModuleFile, null, 2)}\n`);
    this.syncManifestMaps();
  }

  async markStale(projectId: string, paths: readonly string[]): Promise<number> {
    void projectId;
    await this.ensureLoaded();
    let marked = 0;
    const updated: IndexedFile[] = [];
    for (const path of paths) {
      const file = this.byPath.get(path);
      if (!file || file.stale) continue;
      const next: IndexedFile = { ...file, stale: true, verification_state: 'stale' as VerificationState };
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

  async searchFiles(projectId: string, text: string, limit = 20): Promise<{ file: IndexedFile; score: number; matched: string[] }[]> {
    void projectId;
    await this.ensureLoaded();
    const hits = await this.lexical.search(text, { limit: Math.max(limit * 3, limit) });
    const out: { file: IndexedFile; score: number; matched: string[] }[] = [];
    for (const hit of hits) {
      const file = this.byId.get(hit.id);
      if (!file) continue;
      const symbolMatches = hit.matched.filter((term) => file.symbols.some((symbol) => symbol.toLowerCase().includes(term)));
      out.push({
        file,
        score: hit.score,
        matched: [...new Set([...symbolMatches, ...hit.matched.slice(0, 3)])].slice(0, 6),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async findSymbol(projectId: string, name: string, limit = 20): Promise<{ file: IndexedFile; symbol: string; score: number }[]> {
    void projectId;
    await this.ensureLoaded();
    const needle = name.toLowerCase();
    const out: { file: IndexedFile; symbol: string; score: number }[] = [];
    for (const file of this.byPath.values()) {
      for (const symbol of file.symbols) {
        const lower = symbol.toLowerCase();
        if (lower === needle) out.push({ file, symbol, score: 1 });
        else if (lower.includes(needle)) out.push({ file, symbol, score: 0.6 });
        else if (lower.replace(/_/g, '').includes(needle.replace(/_/g, ''))) out.push({ file, symbol, score: 0.4 });
        if (out.length >= limit * 2) break;
      }
      if (out.length >= limit * 2) break;
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async dropProject(projectId: string): Promise<void> {
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

  async flush(): Promise<void> {
    if (!this.loaded) return;
    if (this.logDirty) {
      await this.rewriteLog();
      this.logDirty = false;
    }
    await this.log.flush();
    await this.lexical.flush();
    if (this.manifest) await this.save(this.manifest);
  }

  /* -------------------------------- internals ------------------------------ */

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load(this.manifest?.project_id ?? 'unknown', this.manifest?.root ?? '.');
  }

  private searchableText(file: IndexedFile): string {
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
  private async rewriteLog(): Promise<void> {
    const files = [...this.byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    await this.log.rewrite(files);
  }

  /** Remove index entries for paths that no longer exist. */
  async pruneMissing(projectId: string, existing: ReadonlySet<string>): Promise<number> {
    void projectId;
    await this.ensureLoaded();
    const toRemove: string[] = [];
    for (const path of this.byPath.keys()) if (!existing.has(path)) toRemove.push(path);
    for (const path of toRemove) await this.removeFile(projectId, path);
    return toRemove.length;
  }

  get fileCount(): number {
    return this.byPath.size;
  }

  get moduleCount(): number {
    return this.modules.length;
  }
}

function boostFor(file: IndexedFile): number {
  // Path-shaped and code-shaped content should outrank prose in the same file.
  return /\.[a-z]{1,5}$/.test(file.path) ? 1.3 : 1;
}
