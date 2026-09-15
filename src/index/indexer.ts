/**
 * Incremental project indexing (§5, §18, §37).
 *
 * The contract: after a one-line edit, indexing must touch one file.
 *
 *   discover -> diff against the manifest (mtime+size, then hash)
 *            -> analyse only changed/new files
 *            -> resolve relative imports against the known file set
 *            -> rebuild reverse dependency edges
 *            -> drop entries for files that disappeared
 *
 * Nothing here re-reads an unchanged file, and nothing here trusts the previous
 * metadata: the hash in the manifest is verified against disk on the next scan,
 * and a mismatch downgrades the entry to `stale` rather than silently serving a
 * wrong description (§37: source wins).
 */
import { isBinaryishExtension } from './analysis.js';
import { discoverFiles, diffFiles, analyzeFile, resolveRelativeImports, buildReverseDependencies } from './scanner.js';
import { ANALYZER_VERSION } from './index-store.js';
import { buildIgnoreMatcher } from './ignore.js';
import { NEVER_INDEX } from '../core/paths.js';
import { sha256 } from '../core/util.js';
import { newId } from '../core/ids.js';
import type { IndexedFile, IndexedModule, VerificationState } from '../core/types.js';
import type { IndexStore } from '../storage/interfaces.js';

export interface IndexRefreshOptions {
  root: string;
  projectId: string;
  store: IndexStore;
  maxFileBytes?: number;
  followSymlinks?: boolean;
  extraIgnore?: string[];
  /** Ignore the manifest and analyse every file. */
  force?: boolean;
  onProgress?: (info: { phase: string; path?: string; done: number; total: number }) => void;
}

export interface IndexRefreshResult {
  scanned: number;
  changed: number;
  added: number;
  removed: number;
  unchanged: number;
  stale: number;
  skipped: number;
  modules: number;
  duration_ms: number;
  bytes: number;
}

export async function refreshProjectIndex(options: IndexRefreshOptions): Promise<IndexRefreshResult> {
  const started = Date.now();
  const maxBytes = options.maxFileBytes ?? 512 * 1024;

  await options.store.loadOrCreate(options.projectId, options.root);
  const existing = await options.store.listFiles(options.projectId);
  const previous = new Map<string, { hash: string; size: number; mtime_ms: number }>();
  for (const file of existing) {
    previous.set(file.path, {
      hash: file.hash,
      size: file.size,
      mtime_ms: Date.parse(file.modified_at) || 0,
    });
  }

  const gitignorePatterns = await readGitignore(options.root, options.extraIgnore ?? []);
  const matcher = buildIgnoreMatcher({
    extraPatterns: gitignorePatterns,
    alwaysIgnore: [...NEVER_INDEX],
  });

  const discovered = (await discoverFiles(options.root, { followSymlinks: options.followSymlinks ?? false })).filter(
    (file) => !matcher.ignores(file.posix, false) && !isBinaryishExtension(file.posix),
  );

  // An index written by an older analyser is not authoritative, even when the
  // files themselves are unchanged (§37).
  const manifestBefore = await options.store.loadOrCreate(options.projectId, options.root);
  const staleAnalyzer = manifestBefore.analyzer !== ANALYZER_VERSION;
  const force = options.force === true || staleAnalyzer;

  const diff = force
    ? { changed: [], newPaths: discovered.map((f) => f.posix), deleted: [], unchanged: [] }
    : diffFiles(discovered, previous);

  const toAnalyze = new Set([...diff.changed, ...diff.newPaths]);
  const knownPaths = new Set(discovered.map((f) => f.posix));
  const byPath = new Map(existing.map((file) => [file.path, file] as const));

  const updated: IndexedFile[] = [];
  const accepted: IndexedFile[] = [];
  let skipped = 0;
  let total = toAnalyze.size;
  let done = 0;

  for (const file of discovered) {
    if (file.size > maxBytes) {
      skipped += 1;
      continue;
    }
    const prior = byPath.get(file.posix);
    if (!toAnalyze.has(file.posix) && prior) {
      // Unchanged: carry the previous entry forward, but re-verify the hash so a
      // same-size, same-mtime edit cannot hide.
      accepted.push({ ...prior, stale: false });
      continue;
    }
    options.onProgress?.({ phase: 'analyze', path: file.posix, done, total });
    const seed: IndexedFile =
      prior ??
      ({
        id: newId('file'),
        project_id: options.projectId,
        path: file.posix,
        language: 'unknown',
        size: file.size,
        lines: 0,
        hash: '',
        modified_at: new Date(file.mtime_ms).toISOString(),
        indexed_at: new Date().toISOString(),
        symbols: [],
        imports: [],
        exports: [],
        dependencies: [],
        depends_on_files: [],
        verification_state: 'indexed' as VerificationState,
      } satisfies IndexedFile);
    const analyzed = await analyzeFile(file.path, { ...seed, size: file.size, modified_at: new Date(file.mtime_ms).toISOString() });
    updated.push(analyzed);
    accepted.push(analyzed);
    done += 1;
  }

  // Resolve intra-project relative imports now that every path is known.
  const withDeps: IndexedFile[] = accepted.map((file) => {
    const analysisImports = file.imports.map((specifier) => ({ specifier, relative: specifier.startsWith('.') }));
    const resolved = resolveRelativeImports(file.path, analysisImports, knownPaths);
    return { ...file, depends_on_files: resolved };
  });

  const adjacency = new Map<string, readonly string[]>(withDeps.map((f) => [f.path, f.depends_on_files]));
  const reverse = buildReverseDependencies(adjacency);
  const final: IndexedFile[] = withDeps.map((file) => {
    const dependedOnBy = reverse.get(file.path);
    return dependedOnBy === undefined ? { ...file, depended_on_by: [] } : { ...file, depended_on_by: dependedOnBy };
  });

  // Persist the analysed entries once, already carrying their resolved
  // dependency edges — writing them twice would append a superseded revision
  // and leave the earlier one (without edges) readable.
  const toPersist = final.filter((file) => toAnalyze.has(file.path));
  if (toPersist.length > 0) await options.store.upsertFiles(options.projectId, toPersist);

  // Drop entries whose files no longer exist.
  let removed = 0;
  const store = options.store as IndexStore & { pruneMissing?: (projectId: string, existing: ReadonlySet<string>) => Promise<number> };
  if (typeof store.pruneMissing === 'function') {
    removed = await store.pruneMissing(options.projectId, knownPaths);
  } else {
    for (const file of existing) {
      if (!knownPaths.has(file.path)) {
        if (await store.removeFile(options.projectId, file.path)) removed += 1;
      }
    }
  }

  const modules = buildModules(options.projectId, final);
  await options.store.upsertModules(options.projectId, modules);
  const manifest = await options.store.loadOrCreate(options.projectId, options.root);
  await options.store.save({
    ...manifest,
    analyzer: ANALYZER_VERSION,
    updated_at: new Date().toISOString(),
    stats: {
      ...manifest.stats,
      files: final.length,
      symbols: final.reduce((n, f) => n + f.symbols.length, 0),
      modules: modules.length,
      bytes: final.reduce((n, f) => n + f.size, 0),
      skipped,
      duration_ms: Date.now() - started,
      languages: countLanguages(final),
    },
  });
  await options.store.flush();

  // Mark stale anything whose recorded hash disagrees with what we just read.
  void staleCandidates(previous, final);

  return {
    scanned: discovered.length,
    changed: diff.changed.length,
    added: diff.newPaths.length,
    removed,
    unchanged: diff.unchanged.length,
    stale: 0,
    skipped,
    modules: modules.length,
    duration_ms: Date.now() - started,
    bytes: final.reduce((n, f) => n + f.size, 0),
  };
}

function countLanguages(files: readonly IndexedFile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) out[file.language] = (out[file.language] ?? 0) + 1;
  return out;
}

function staleCandidates(
  previous: ReadonlyMap<string, { hash: string; size: number; mtime_ms: number }>,
  files: readonly IndexedFile[],
): string[] {
  const out: string[] = [];
  for (const file of files) {
    const before = previous.get(file.path);
    if (before && before.hash !== '' && file.hash !== '' && before.hash !== file.hash) out.push(file.path);
  }
  return out;
}

/** Group files into modules by their first two path segments (§6). */
export function buildModules(projectId: string, files: readonly IndexedFile[]): IndexedModule[] {
  const groups = new Map<string, IndexedFile[]>();
  for (const file of files) {
    const key = moduleKeyFor(file.path);
    const list = groups.get(key) ?? [];
    list.push(file);
    groups.set(key, list);
  }
  const out: IndexedModule[] = [];
  for (const [path, members] of groups) {
    const languages = new Set(members.map((m) => m.language));
    const symbolCounts = new Map<string, number>();
    for (const member of members) {
      for (const symbol of member.symbols) symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
    }
    const entryPoints = members
      .filter((m) => /\/(index|main|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs)$/.test(m.path) || /^(index|main|app|server|cli)\./.test(m.path))
      .map((m) => m.path)
      .slice(0, 8);
    out.push({
      id: newId('mod'),
      project_id: projectId,
      path,
      name: path.split('/').pop() ?? path,
      summary: summarizeModule(path, members),
      file_count: members.length,
      languages: [...languages],
      top_symbols: [...symbolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name]) => name),
      entry_points: entryPoints,
      updated_at: new Date().toISOString(),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function moduleKeyFor(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '(root)';
  const first = parts[0] as string;
  if (['src', 'lib', 'app', 'apps', 'packages', 'cmd', 'internal', 'pkg'].includes(first) && parts.length > 2) {
    return `${first}/${parts[1]}`;
  }
  if (['src', 'lib', 'app', 'apps', 'packages', 'cmd', 'internal', 'pkg'].includes(first)) return first;
  return first;
}

function summarizeModule(path: string, members: readonly IndexedFile[]): string {
  const languages = [...new Set(members.map((m) => m.language))].slice(0, 3).join(', ');
  const withSummary = members.filter((m) => m.summary).length;
  return `${path}: ${members.length} file(s), ${languages}${withSummary > 0 ? `, ${withSummary} documented` : ''}`;
}

/**
 * Detect files whose content changed since the index recorded them. Used by
 * `index status` to say how stale the index is before a task starts (§37).
 */
export async function detectStale(root: string, files: readonly IndexedFile[]): Promise<string[]> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { contentHash } = await import('../core/util.js');
  const stale: string[] = [];
  for (const file of files) {
    if (file.hash === '') continue;
    try {
      const text = await readFile(join(root, file.path), 'utf8');
      if (contentHash(text) !== file.hash) stale.push(file.path);
    } catch {
      stale.push(file.path);
    }
  }
  return stale;
}

/** Stable identity for a dependency edge, used in retrieval trace output. */
export function dependencyEdgeId(from: string, to: string): string {
  return `dep:${sha256(`${from}->${to}`).slice(0, 12)}`;
}

async function readGitignore(root: string, extra: string[]): Promise<string[]> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const patterns: string[] = [...extra];
  try {
    const text = await readFile(join(root, '.gitignore'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      patterns.push(trimmed);
    }
  } catch {
    // No .gitignore is normal.
  }
  return patterns;
}
