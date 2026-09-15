/**
 * Project scanner and incremental indexer (§5, §37).
 *
 * `scanProject` walks the tree once, classifies every file, and returns both
 * the full inventory and the *delta*: which files changed since the previous
 * scan (by size+mtime first, then content hash), which are new, and which
 * disappeared. The delta is what makes re-indexing incremental — a one-line
 * edit must not reprocess a 50k-file repository.
 *
 * Symlinks are never followed by default. Files outside `maxFileBytes` are
 * counted in `skipped` rather than read. The scanner itself never writes
 * anything; persistence lives in `IndexStore`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { IgnoreMatcher } from './ignore.js';
import { analyzeSource, detectLanguage, isBinaryishExtension } from './analysis.js';
import { contentHash, nowIso } from '../core/util.js';
import { NEVER_INDEX, toPosix } from '../core/paths.js';
import { newId } from '../core/ids.js';
/** Collect every candidate file path under root, honouring ignore rules. */
export async function discoverFiles(root, options = {}) {
    const matcher = new IgnoreMatcher([
        ...NEVER_INDEX,
        '.git',
        'node_modules',
        'dist',
        'build',
        'target',
        '.venv',
        '__pycache__',
        'coverage',
        '.low-context',
    ]);
    const out = [];
    const includeDirs = true;
    async function walk(dir, rel, depth) {
        if (options.maxDepth !== undefined && depth > options.maxDepth)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (matcher.ignores(childRel, entry.isDirectory()))
                continue;
            const full = join(dir, entry.name);
            let isDir = entry.isDirectory();
            if (entry.isSymbolicLink() && includeDirs) {
                if (!options.followSymlinks)
                    continue;
                try {
                    const st = await stat(full);
                    isDir = st.isDirectory();
                }
                catch {
                    continue;
                }
            }
            if (isDir) {
                await walk(full, childRel, depth + 1);
                continue;
            }
            let st;
            try {
                st = await stat(full);
            }
            catch {
                continue;
            }
            if (!st.isFile())
                continue;
            if (isBinaryishExtension(childRel))
                continue;
            out.push({
                path: full,
                posix: childRel,
                size: st.size,
                mtime_ms: st.mtimeMs,
                isDir: false,
            });
        }
    }
    await walk(root, '', 0);
    return out;
}
/** Determine which paths changed against the previous manifest (mtime-first). */
export function diffFiles(discovered, previous) {
    const seen = new Set();
    const changed = [];
    const newPaths = [];
    const unchanged = [];
    for (const file of discovered) {
        seen.add(file.posix);
        const old = previous.get(file.posix);
        if (!old) {
            newPaths.push(file.posix);
        }
        else if (old.size !== file.size || Math.abs(old.mtime_ms - file.mtime_ms) > 100) {
            changed.push(file.posix);
        }
        else {
            unchanged.push(file.posix);
        }
    }
    const deleted = [];
    for (const path of previous.keys())
        if (!seen.has(path))
            deleted.push(path);
    return { changed, newPaths, deleted, unchanged };
}
export async function scanProject(options) {
    const started = Date.now();
    const maxBytes = options.maxFileBytes ?? 512 * 1024;
    const discovered = await discoverFiles(options.root, {
        followSymlinks: options.followSymlinks ?? false,
    });
    const previous = options.previous ?? new Map();
    const { changed, newPaths, deleted, unchanged } = diffFiles(discovered, previous);
    const files = [];
    const changedPaths = [];
    let skipped = 0;
    let totalBytes = 0;
    const languages = {};
    for (const file of discovered) {
        const needsRead = newPaths.includes(file.posix) || changed.includes(file.posix);
        const isNew = newPaths.includes(file.posix);
        if (file.size > maxBytes) {
            skipped += 1;
            if (isNew) {
                // Large files still get a metadata-only entry (unread) so navigation
                // knows they exist without loading 10 MB of code (§57).
                files.push({
                    info: {
                        id: newId('file'),
                        project_id: options.projectId ?? '',
                        path: file.posix,
                        language: detectLanguage(file.posix) ?? 'unknown',
                        size: file.size,
                        lines: 0,
                        hash: '',
                        modified_at: new Date(file.mtime_ms).toISOString(),
                        indexed_at: nowIso(),
                        symbols: [],
                        imports: [],
                        exports: [],
                        dependencies: [],
                        depends_on_files: [],
                        verification_state: 'indexed',
                    },
                    changed: true,
                    symbols: undefined,
                });
            }
            continue;
        }
        totalBytes += file.size;
        const language = detectLanguage(file.posix) ?? 'unknown';
        languages[language] = (languages[language] ?? 0) + 1;
        const hash = needsRead ? contentHash(await safeRead(file.path)) : previous.get(file.posix)?.hash ?? '';
        const verification = needsRead ? 'verified' : 'indexed';
        const size = file.size;
        const mtime = new Date(file.mtime_ms).toISOString();
        files.push({
            info: {
                id: newId('file'),
                project_id: options.projectId ?? '',
                path: file.posix,
                language,
                size,
                lines: 0,
                hash,
                modified_at: mtime,
                indexed_at: nowIso(),
                symbols: [],
                imports: [],
                exports: [],
                dependencies: [],
                depends_on_files: [],
                verification_state: verification,
            },
            changed: needsRead || isNew,
            symbols: undefined,
        });
        if (needsRead)
            changedPaths.push(file.posix);
    }
    return {
        root: options.root,
        files,
        changedPaths,
        newPaths,
        deletedPaths: deleted,
        unchangedPaths: unchanged,
        skipped,
        duration_ms: Date.now() - started,
        totalBytes,
        languages,
    };
}
async function safeRead(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return '';
    }
}
/* ----------------------- per-file enrichment (post-scan) ------------------- */
/**
 * Read a file's actual contents and enrich its index entry: symbols, imports,
 * routes, tests and a stable hash. This is where `verification_state` flips to
 * `verified` — the metadata now reflects the real source (§16, §37).
 */
export async function analyzeFile(path, info) {
    const text = await safeRead(path);
    const analysis = analyzeSource(info.path, text);
    const lines = text.split('\n').length;
    return {
        ...info,
        language: analysis.language ?? info.language,
        lines,
        hash: contentHash(text),
        summary: analysis.summary,
        symbols: analysis.symbols.map((s) => s.name),
        imports: analysis.imports.map((i) => i.specifier),
        exports: analysis.symbols.filter((s) => s.exported).map((s) => s.name),
        dependencies: analysis.imports.filter((i) => !i.relative).map((i) => i.specifier),
        routes: analysis.routes.map((r) => `${r.method} ${r.path}`),
        tests: analysis.tests,
        verification_state: 'verified',
        // `modified_at` must stay the file's own mtime: the incremental scan
        // diffs against it, and writing "now" here would make every file look
        // changed on the next run, defeating incremental indexing (§5).
        indexed_at: nowIso(),
    };
}
/** Resolve relative import specifiers to project-relative file paths. */
export function resolveRelativeImports(ownerPath, imports, knownFiles) {
    const out = [];
    const sourceExtensions = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'dart', 'vue', 'svelte'];
    for (const imp of imports) {
        if (!imp.relative)
            continue;
        const dir = ownerPath.includes('/') ? ownerPath.slice(0, ownerPath.lastIndexOf('/')) : '';
        const raw = imp.specifier.startsWith('./') && dir !== '' ? `${dir}/${imp.specifier.slice(2)}` : imp.specifier;
        const base = normalizePath(raw);
        // ESM TypeScript writes `./oauth.js` for `./oauth.ts`, so the literal
        // specifier often names a file that does not exist. Strip a known source
        // extension and re-resolve before giving up.
        const stem = base.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|go|rs|java|kt|dart|vue|svelte|h|hpp)$/, '');
        const candidates = [
            base,
            stem,
            ...sourceExtensions.map((ext) => `${stem}.${ext}`),
            ...sourceExtensions.map((ext) => `${stem}/index.${ext}`),
            `${stem}/mod.rs`,
            `${stem}/__init__.py`,
        ];
        for (const candidate of candidates) {
            const normalized = normalizePath(candidate);
            if (normalized === '' || normalized === '.')
                continue;
            if (knownFiles.has(normalized)) {
                out.push(normalized);
                break;
            }
        }
    }
    return out;
}
function normalizePath(path) {
    const parts = [];
    for (const part of path.split('/')) {
        if (part === '.' || part === '')
            continue;
        if (part === '..')
            parts.pop();
        else
            parts.push(part);
    }
    return parts.join('/');
}
/** Build the "depended_on_by" reverse edges from a file->deps adjacency map. */
export function buildReverseDependencies(deps) {
    const out = new Map();
    for (const [file, depends] of deps) {
        for (const target of depends) {
            const list = out.get(target);
            if (list)
                list.push(file);
            else
                out.set(target, [file]);
        }
    }
    return out;
}
export function toRelPosix(root, path) {
    return toPosix(relative(root, path));
}
//# sourceMappingURL=scanner.js.map