/**
 * Persistent memory (§4C, §9–§11, §35, §36, §48).
 *
 * Layout:
 *
 *   memory/records.jsonl                     append-only canonical records
 *   memory/catalog.json                      id -> ordinal (rebuilt lazily)
 *   memory/records.lex.json                  global BM25 index
 *
 * Invariants:
 *  - Records are written once and never mutated in place; corrections create a
 *    new record and mark the old one `superseded` (§11).
 *  - Every record keeps `source_refs` (§8) and a `confidence`/`status` pair
 *    (§36).
 *  - The store is deliberately "dumb": ranking weights come from the caller, so
 *    the retrieval engine owns the policy (§12).
 */
import { join } from 'node:path';
import { JsonlLog } from './jsonl.js';
import { PersistentLexicalIndex } from './lexical-index.js';
import { ensureDir, nowIso, atomicWrite, readJsonIfExists, clamp, debounce } from '../core/util.js';
import { newId } from '../core/ids.js';
import type {
  Confidence,
  Importance,
  MemoryRecord,
  MemoryScope,
  MemorySearchQuery,
  MemoryType,
} from '../core/types.js';
import { IMPORTANCE_ORDER } from '../core/types.js';
import { scoreCandidate } from '../search/rank.js';
import type { MemoryStore, MemoryWriteInput } from './interfaces.js';

export interface MemoryStoreOptions {
  baseDir: string;
  /** Global minimum importance; lower-importance records are kept but filtered. */
  minImportance?: Importance;
  defaultConfidence?: Confidence;
}

interface Catalog {
  version: 1;
  /** id -> ordinal */
  entries: Record<string, number>;
  last_ordinal: number;
  /**
   * `scope + project + lowercased summary` -> id, for the current records only.
   * This is what makes duplicate detection O(1) instead of a full-text scan.
   */
  dupes: Record<string, string>;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { unknown: 0, low: 1, medium: 2, high: 3, verified: 4 };

/**
 * How long the catalog may go unwritten during a burst. The catalog is a cache:
 * `loadCatalog` rebuilds it from the log whenever it disagrees, so a stale file
 * costs one rebuild, never correctness.
 */
const CATALOG_FLUSH_DELAY_MS = 2_000;

/**
 * Identity of a memory for de-duplication. The scope and project are part of
 * the key so an identical sentence in two projects is never treated as one
 * record (§66 — memory must not leak across projects).
 */
function duplicateKey(summary: string, scope: MemoryScope, projectId: string | undefined): string {
  return `${scope}\u0000${projectId ?? ''}\u0000${summary.toLowerCase()}`;
}

export function importanceForType(type: MemoryType): Importance {
  switch (type) {
    case 'USER_INSTRUCTION':
    case 'DECISION':
    case 'ARCHITECTURE':
      return 'important';
    case 'BUG':
    case 'FIX':
      return 'important';
    case 'PROJECT_KNOWLEDGE':
    case 'TASK':
    case 'FACT':
    case 'PREFERENCE':
    case 'FILE_KNOWLEDGE':
    case 'COMMAND_RESULT':
      return 'normal';
    default:
      return 'normal';
  }
}

export class FileMemoryStore implements MemoryStore {
  private readonly dir: string;
  private readonly log: JsonlLog<MemoryRecord>;
  private readonly index: PersistentLexicalIndex;
  private catalog: Catalog | undefined;
  private readonly minImportance: Importance;
  private readonly defaultConfidence: Confidence;
  /**
   * Writes are serialised. Ordinals are derived from `log.size`, so two
   * concurrent writes would claim the same ordinal and collide in the catalog.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  /**
   * The catalog is a cache, not the source of truth: `loadCatalog` rebuilds it
   * from the log whenever its entry count disagrees with the log length. So it
   * is persisted periodically rather than on every write — rewriting the whole
   * map per record made bulk writes quadratic.
   */
  private catalogDirty = false;
  private catalogFlushInFlight: Promise<void> | undefined;
  private readonly scheduleCatalogFlush: (() => void) & { flush: () => void };

  constructor(options: MemoryStoreOptions) {
    this.dir = join(options.baseDir, 'memory');
    this.minImportance = options.minImportance ?? 'normal';
    this.defaultConfidence = options.defaultConfidence ?? 'high';
    this.log = new JsonlLog<MemoryRecord>(join(this.dir, 'records.jsonl'), { flushEvery: 32 });
    this.index = new PersistentLexicalIndex(join(this.dir, 'records.lex.json'));
    // `persistCatalog`, not `flush`: flush() awaits this timer, so calling back
    // into it would recurse.
    this.scheduleCatalogFlush = debounce(() => {
      void this.persistCatalog();
    }, CATALOG_FLUSH_DELAY_MS);
  }

  /* ------------------------------- internals ------------------------------ */

  private async ensure(): Promise<void> {
    await ensureDir(this.dir);
  }

  private async loadCatalog(): Promise<Catalog> {
    if (this.catalog) return this.catalog;
    await this.ensure();
    await this.log.open();
    const seen = await readJsonIfExists<Catalog>(this.catalogPath());
    if (
      seen &&
      seen.version === 1 &&
      seen.dupes !== undefined &&
      Object.keys(seen.entries).length === this.log.size
    ) {
      this.catalog = seen;
      return seen;
    }
    const entries: Record<string, number> = {};
    const dupes: Record<string, string> = {};
    let ordinal = 0;
    for await (const record of this.log.iterate()) {
      entries[record.id] = ordinal;
      ordinal += 1;
      if (record.status !== 'current') continue;
      const key = duplicateKey(record.summary, record.scope, record.project_id);
      if (dupes[key] === undefined) dupes[key] = record.id;
    }
    if (ordinal !== this.log.size) await this.rewriteLogTo(entries);
    const rebuilt: Catalog = { version: 1, entries, last_ordinal: ordinal, dupes };
    await atomicWrite(this.catalogPath(), `${JSON.stringify(rebuilt)}\n`);
    this.catalog = rebuilt;
    return rebuilt;
  }

  private async rewriteLogTo(entries: Record<string, number>): Promise<void> {
    const records: MemoryRecord[] = new Array(Object.keys(entries).length);
    for await (const record of this.log.iterate()) {
      const ordinal = entries[record.id];
      if (ordinal !== undefined) records[ordinal] = record;
    }
    const cleaned = records.filter((r): r is MemoryRecord => r !== undefined);
    await this.log.rewrite(cleaned);
    const fixed: Record<string, number> = {};
    cleaned.forEach((r, i) => {
      fixed[r.id] = i;
    });
    Object.assign(entries, fixed);
  }

  private async fetch(id: string): Promise<MemoryRecord | undefined> {
    const ordinal = (await this.loadCatalog()).entries[id];
    if (ordinal === undefined) return undefined;
    return this.log.at(ordinal);
  }

  private catalogPath(): string {
    return join(this.dir, 'catalog.json');
  }

  private async indexRecord(record: MemoryRecord): Promise<void> {
    const boost = /[A-Za-z0-9_/]+\.[a-z]{1,4}\b|\b[A-Za-z]+_[A-Za-z0-9_]+\b/.test(record.summary) ? 1.6 : 1;
    const text = `${record.summary} ${record.detail ?? ''} ${record.tags.join(' ')} ${record.module_path ?? ''} type:${record.type} scope:${record.scope}`;
    await this.index.upsert(record.id, text, boost);
  }

  /* -------------------------------- writing ------------------------------- */

  async write(input: MemoryWriteInput): Promise<MemoryRecord> {
    const result = this.writeChain.then(
      () => this.doWrite(input),
      () => this.doWrite(input),
    );
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doWrite(input: MemoryWriteInput): Promise<MemoryRecord> {
    await this.ensure();
    const now = nowIso();
    const normalized = input.summary.replace(/\s+/g, ' ').trim();

    const duplicate = await this.findDuplicate(normalized, input.scope, input.project_id);
    if (duplicate) {
      const updated: MemoryRecord = {
        ...duplicate,
        tags: [...new Set([...duplicate.tags, ...(input.tags ?? [])])],
        source_refs: [...(input.source_refs ?? []).slice(0, 5), ...duplicate.source_refs].slice(0, 20),
        confidence: mergeConfidence(duplicate.confidence, input.confidence ?? this.defaultConfidence),
        verification_state: input.verification_state ?? duplicate.verification_state,
        updated_at: now,
        last_accessed_at: now,
      };
      await this.put(updated);
      return updated;
    }

    const record: MemoryRecord = {
      id: input.id ?? newId('mem'),
      type: input.type,
      scope: input.scope,
      summary: normalized,
      tags: input.tags ?? [],
      source_refs: input.source_refs ?? [],
      confidence: input.confidence ?? this.defaultConfidence,
      status: 'current',
      importance: input.importance ?? importanceForType(input.type),
      verification_state: input.verification_state ?? 'indexed',
      access_count: 0,
      created_at: now,
      updated_at: now,
    };
    if (input.detail !== undefined) record.detail = input.detail;
    if (input.project_id !== undefined) record.project_id = input.project_id;
    if (input.session_id !== undefined) record.session_id = input.session_id;
    if (input.task_id !== undefined) record.task_id = input.task_id;
    if (input.module_path !== undefined) record.module_path = input.module_path;

    if (input.supersedes) {
      record.supersedes = [input.supersedes];
      const old = await this.fetch(input.supersedes);
      if (old && old.status === 'current') {
        await this.put({ ...old, status: 'superseded', superseded_by: record.id, updated_at: now });
      }
    }

    // The ordinal is the position this record will occupy in the log, which is
    // the current length — not `catalog.last_ordinal`, which may have gone stale
    // if the log was rewritten by a supersede/update in between.
    const ordinal = this.log.size;
    await this.log.append(record);
    const catalog = await this.loadCatalog();
    catalog.entries[record.id] = ordinal;
    catalog.last_ordinal = Math.max(catalog.last_ordinal, ordinal + 1);
    this.syncDuplicateKey(catalog, record);
    this.noteCatalogChanged();
    await this.indexRecord(record);
    return record;
  }

  /** Keep the de-duplication map in step with a record's current status. */
  private syncDuplicateKey(catalog: Catalog, record: MemoryRecord): void {
    const key = duplicateKey(record.summary, record.scope, record.project_id);
    if (record.status === 'current') catalog.dupes[key] = record.id;
    else if (catalog.dupes[key] === record.id) delete catalog.dupes[key];
  }

  private noteCatalogChanged(): void {
    this.catalogDirty = true;
    this.scheduleCatalogFlush();
  }

  private async persistCatalog(): Promise<void> {
    if (!this.catalogDirty || !this.catalog) return;
    this.catalogDirty = false;
    const write = atomicWrite(this.catalogPath(), `${JSON.stringify(this.catalog)}\n`);
    this.catalogFlushInFlight = write;
    await write;
  }

  /** Rewrite one record in place; used only for status/metadata transitions. */
  private async put(record: MemoryRecord): Promise<void> {
    const records: MemoryRecord[] = [];
    for await (const existing of this.log.iterate()) records.push(existing.id === record.id ? record : existing);
    await this.log.rewrite(records);
    const catalog = await this.loadCatalog();
    const fixed: Record<string, number> = {};
    records.forEach((r, i) => {
      fixed[r.id] = i;
    });
    catalog.entries = fixed;
    catalog.last_ordinal = records.length;
    this.syncDuplicateKey(catalog, record);
    this.catalogDirty = false;
    await this.persistCatalog();
    await this.indexRecord(record);
  }

  /**
   * Exact-duplicate detection (§10). Must be O(1): it runs on every write, and
   * a full-text scan here made bulk writes quadratic (a BM25 search scores every
   * document containing a query term). The catalog carries the lookup map.
   */
  private async findDuplicate(
    summary: string,
    scope: MemoryScope,
    projectId: string | undefined,
  ): Promise<MemoryRecord | undefined> {
    const id = (await this.loadCatalog()).dupes[duplicateKey(summary, scope, projectId)];
    if (id === undefined) return undefined;
    const record = await this.fetch(id);
    if (!record || record.status !== 'current') return undefined;
    if (record.scope !== scope || record.project_id !== projectId) return undefined;
    return record.summary.replace(/\s+/g, ' ').trim() === summary ? record : undefined;
  }

  /* -------------------------------- reading ------------------------------- */

  async get(id: string): Promise<MemoryRecord | undefined> {
    const record = await this.fetch(id);
    if (!record) return undefined;
    return { ...record, access_count: record.access_count + 1 };
  }

  async getMany(ids: readonly string[]): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const id of ids) {
      const record = await this.fetch(id);
      if (record) out.push(record);
    }
    return out;
  }

  async search(
    query: MemorySearchQuery,
  ): Promise<{ record: MemoryRecord; score: number; reason: string }[]> {
    const limit = query.limit ?? 12;
    if (!query.text || query.text.trim() === '') {
      // No query text: return recent records matching scope filters.
      const records = await this.list({
        project_id: query.project_id,
        scope: query.scopes?.[0],
        type: query.types?.[0],
        limit: limit * 4,
        include_superseded: query.include_superseded,
      });
      return records
        .filter((record) => this.meetsMinimumImportance(record, query))
        .slice(0, limit)
        .map((record) => ({ record, score: recencyScore(record.updated_at), reason: 'recent' }));
    }

    const hits = await this.index.search(query.text, { limit: limit * 8 });
    const out: { record: MemoryRecord; score: number; reason: string }[] = [];
    for (const hit of hits) {
      const record = await this.fetch(hit.id);
      if (!record) continue;
      if (!this.passesFilters(record, query)) continue;
      if (!this.meetsMinimumImportance(record, query)) continue;
      const scored = scoreCandidate(
        {
          id: record.id,
          lexical: hit.score,
          updated_at: record.updated_at,
          created_at: record.created_at,
          importance: record.importance,
          confidence: record.confidence,
          exact: exactMatchBonus(record, query.text),
          task: taskMatchBonus(record, query),
          staleness: record.verification_state === 'stale' ? 1 : 0,
        },
        query.weights,
      );
      out.push({
        record: { ...record, access_count: record.access_count + 1 },
        score: scored.score,
        reason: scored.reasons.join(', '),
      });
      if (out.length >= limit) break;
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async list(input: {
    project_id?: string;
    scope?: MemoryScope;
    type?: MemoryType;
    limit?: number;
    include_superseded?: boolean;
  } = {}): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for await (const record of this.log.iterate()) {
      if (input.scope && record.scope !== input.scope) continue;
      if (input.type && record.type !== input.type) continue;
      if (input.project_id && record.project_id !== input.project_id) continue;
      if (!input.include_superseded && record.status !== 'current') continue;
      out.push(record);
    }
    out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return input.limit ? out.slice(0, input.limit) : out;
  }

  async update(id: string, patch: Partial<MemoryRecord>): Promise<MemoryRecord | undefined> {
    const record = await this.fetch(id);
    if (!record) return undefined;
    const updated = { ...record, ...patch, id: record.id, updated_at: nowIso() };
    await this.put(updated);
    return updated;
  }

  async supersede(oldId: string, newIdValue: string): Promise<void> {
    const old = await this.fetch(oldId);
    if (!old || old.status !== 'current') return;
    await this.put({ ...old, status: 'superseded', superseded_by: newIdValue, updated_at: nowIso() });
  }

  async delete(id: string): Promise<boolean> {
    const target = await this.fetch(id);
    if (!target) return false;
    const records: MemoryRecord[] = [];
    for await (const record of this.log.iterate()) if (record.id !== id) records.push(record);
    records.forEach((r) => {
      // A deleted record can no longer supersede anything.
      r.superseded_by = r.superseded_by === id ? undefined : r.superseded_by;
    });
    await this.log.rewrite(records);
    const catalog = await this.loadCatalog();
    const fixed: Record<string, number> = {};
    records.forEach((r, i) => {
      fixed[r.id] = i;
    });
    catalog.entries = fixed;
    catalog.last_ordinal = records.length;
    const staleKey = duplicateKey(target.summary, target.scope, target.project_id);
    if (catalog.dupes[staleKey] === id) delete catalog.dupes[staleKey];
    this.catalogDirty = false;
    await this.persistCatalog();
    await this.index.remove(id);
    return true;
  }

  async forget(query: MemorySearchQuery & { text: string }): Promise<number> {
    const hits = await this.search({ ...query, limit: 1_000 });
    let removed = 0;
    for (const hit of hits) {
      if (await this.delete(hit.record.id)) removed += 1;
    }
    return removed;
  }

  async count(input: { project_id?: string; scope?: MemoryScope } = {}): Promise<number> {
    let count = 0;
    for await (const record of this.log.iterate()) {
      if (input.project_id && record.project_id !== input.project_id) continue;
      if (input.scope && record.scope !== input.scope) continue;
      count += 1;
    }
    return count;
  }

  async rebuild(): Promise<{ records: number; duration_ms: number }> {
    const started = Date.now();
    await this.index.reset();
    let records = 0;
    for await (const record of this.log.iterate()) {
      records += 1;
      await this.indexRecord(record);
    }
    await this.index.flush();
    // Rebuild the catalog from the (clean) log.
    this.catalog = undefined;
    await this.loadCatalog();
    return { records, duration_ms: Date.now() - started };
  }

  async export(input: { project_id?: string } = {}): Promise<MemoryRecord[]> {
    const all: MemoryRecord[] = [];
    for await (const record of this.log.iterate()) {
      if (input.project_id && record.project_id !== input.project_id) continue;
      all.push(record);
    }
    return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** Apply retention: drop records older than `days` unless marked important+. */
  async applyRetention(days: number, protectedImportance: Importance = 'important'): Promise<number> {
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * 86_400_000;
    const { removed } = await this.log.retain((record) => {
      if (IMPORTANCE_ORDER[record.importance] >= IMPORTANCE_ORDER[protectedImportance]) return true;
      return Date.parse(record.updated_at) >= cutoff;
    });
    if (removed > 0) {
      this.catalog = undefined;
      await this.loadCatalog();
      const keep = new Set<string>();
      for await (const record of this.log.iterate()) keep.add(record.id);
      await this.index.prune((id) => keep.has(id));
    }
    return removed;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    this.scheduleCatalogFlush.flush();
    await this.persistCatalog();
    await this.catalogFlushInFlight;
    await this.log.flush();
    await this.index.flush();
  }

  /* -------------------------------- filters ------------------------------- */

  private passesFilters(record: MemoryRecord, query: MemorySearchQuery): boolean {
    if (query.types && !query.types.includes(record.type)) return false;
    if (query.scopes && !query.scopes.includes(record.scope)) return false;
    if (query.project_id && record.project_id !== query.project_id) return false;
    if (query.session_id && record.session_id !== query.session_id) return false;
    if (query.task_id && record.task_id !== query.task_id) return false;
    if (query.module_path && record.module_path !== query.module_path) return false;
    if (query.tags && query.tags.length > 0) {
      if (!query.tags.every((tag) => record.tags.includes(tag))) return false;
    }
    if (!query.include_superseded && record.status !== 'current') return false;
    if (query.min_importance && IMPORTANCE_ORDER[record.importance] < IMPORTANCE_ORDER[query.min_importance]) {
      return false;
    }
    return true;
  }

  /**
   * The store's configured floor. Retrieval may pass its own stricter
   * `min_importance`; otherwise records the project considers noise (by default
   * `temporary` ones) never surface from a search.
   */
  private meetsMinimumImportance(record: MemoryRecord, query: MemorySearchQuery): boolean {
    const floor = query.min_importance ?? this.minImportance;
    return IMPORTANCE_ORDER[record.importance] >= IMPORTANCE_ORDER[floor];
  }

  /** Diagnostics for `doctor` and `memory status`. */
  async stats(): Promise<{ records: number; indexed: number; size_bytes: number }> {
    const records = await this.count();
    return { records, indexed: this.index.docCount, size_bytes: 0 };
  }
}

/* ------------------------------- module helpers ---------------------------- */

function mergeConfidence(current: Confidence, incoming: Confidence): Confidence {
  return CONFIDENCE_RANK[incoming] > CONFIDENCE_RANK[current] ? incoming : current;
}

function recencyScore(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const ageDays = Math.max(0, Date.now() - t) / 86_400_000;
  return clamp(0.5 ** (ageDays / 30), 0, 1);
}

function exactMatchBonus(record: MemoryRecord, query: string): number {
  const terms = query.split(/[\s_./]+/).filter((t) => t.length >= 2);
  if (terms.length === 0) return 0;
  let exact = 0;
  for (const term of terms) {
    const lower = term.toLowerCase();
    if (record.summary.toLowerCase().includes(lower)) exact += 1;
    if (record.tags.some((tag) => tag.toLowerCase() === lower)) exact += 1;
  }
  return clamp(exact / (terms.length * 2), 0, 1);
}

function taskMatchBonus(record: MemoryRecord, query: MemorySearchQuery): number {
  let hits = 0;
  if (query.session_id && record.session_id === query.session_id) hits += 1;
  if (query.task_id && record.task_id === query.task_id) hits += 1;
  if (query.module_path && record.module_path === query.module_path) hits += 1;
  return clamp(hits / 3, 0, 1);
}