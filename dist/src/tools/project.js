/**
 * Project tools (§19, §18, §16).
 *
 * These tools are how the agent navigates a project without loading it. They
 * read the *index* for cheap lookups, and one of them — `verify_source` — exists
 * purely to break the habit of trusting the index. `index != source` (§16), so
 * any tool that reports metadata says which verification state it came from.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeSource } from '../index/analysis.js';
import { renderFileMapEntry, buildDirectoryTree, renderTree } from '../index/project-map.js';
import { isInside } from '../core/paths.js';
import { formatBytes } from '../core/util.js';
import * as git from '../git/git.js';
import { asNumber, asOptionalString, asString, booleanProp, numberProp, objectSchema, stringProp } from './types.js';
/* ---------------------------------- git_* ---------------------------------- */
const gitStatusTool = {
    name: 'git_status',
    description: 'Show the current git branch and working-tree changes. Use it to see what is already modified before making edits.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({}, []),
    async run(_args, ctx) {
        if (!(await git.isGitRepo(ctx.projectRoot))) {
            return { summary: 'Not a git repository.', ok: true };
        }
        const branch = await git.currentBranch(ctx.projectRoot);
        const changes = await git.changedFiles(ctx.projectRoot);
        const head = await git.headCommit(ctx.projectRoot);
        const lines = [
            `branch: ${branch ?? '(detached)'}`,
            `head: ${head ? head.slice(0, 12) : '(none)'}`,
            `modified: ${changes.modified.length ? changes.modified.join(', ') : '(none)'}`,
            `added: ${changes.added.length ? changes.added.join(', ') : '(none)'}`,
            `deleted: ${changes.deleted.length ? changes.deleted.join(', ') : '(none)'}`,
            `renamed: ${changes.renamed.length ? changes.renamed.join(', ') : '(none)'}`,
            `untracked: ${changes.untracked.length ? changes.untracked.join(', ') : '(none)'}`,
        ];
        return { summary: lines.join('\n'), verification_state: 'verified', affected_files: [...changes.modified, ...changes.added] };
    },
};
const gitDiffTool = {
    name: 'git_diff',
    description: 'Show a unified diff of unstaged or staged changes, optionally limited to specific paths.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Limit the diff to this project-relative path.'),
        staged: booleanProp('Show staged changes instead of the working tree.'),
    }, []),
    async run(args, ctx) {
        const path = asOptionalString(args, 'path');
        const text = await git.diff(ctx.projectRoot, {
            staged: args.staged === true,
            paths: path ? [path] : undefined,
            context: 3,
        });
        if (text.trim() === '')
            return { summary: 'No changes.', ok: true };
        return { summary: text.slice(0, 12_000), output: text, verification_state: 'verified' };
    },
};
const gitLogTool = {
    name: 'git_log',
    description: 'Show recent commit history, optionally filtered by path or a message substring. Historical decisions can often be traced to a commit.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Limit history to this project-relative path.'),
        limit: numberProp('Number of commits to return. Default 15.', { minimum: 1, maximum: 100 }),
        grep: stringProp('Case-insensitive substring to match against commit subjects.'),
    }, []),
    async run(args, ctx) {
        const path = asOptionalString(args, 'path');
        const limit = asNumber(args, 'limit', { fallback: 15 });
        const grep = asOptionalString(args, 'grep');
        const commits = await git.log(ctx.projectRoot, { limit, paths: path ? [path] : undefined, grep });
        if (commits.length === 0)
            return { summary: 'No matching commits.', ok: true };
        const summary = commits.map((c) => `${c.short} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join('\n');
        return { summary, verification_state: 'verified', data: { commits: commits } };
    },
};
/* -------------------------------- project_map ------------------------------ */
const projectMapTool = {
    name: 'project_map',
    description: 'Show the compact project map: modules, directories and files with counts. Use it to navigate a project instead of listing every directory. Supply a module or path to narrow the view.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        module: stringProp('Narrow the map to a top-level module name.'),
        path: stringProp('Narrow the map to a project-relative directory.'),
        depth: numberProp('Directory depth to render. Default 3.', { minimum: 1, maximum: 8 }),
        max_files: numberProp('Cap on files rendered. Default 120.', { minimum: 1, maximum: 1000 }),
    }, []),
    async run(args, ctx) {
        if (!ctx.indexStore || !ctx.projectId)
            return { ok: false, summary: 'No project index is available.', error: 'no index' };
        const files = await ctx.indexStore.listFiles(ctx.projectId);
        const modules = await ctx.indexStore.listModules(ctx.projectId);
        const wantedModule = asOptionalString(args, 'module');
        const wantedPath = asOptionalString(args, 'path');
        const depth = asNumber(args, 'depth', { fallback: 3 });
        const maxFiles = asNumber(args, 'max_files', { fallback: 120 });
        let scoped = files;
        if (wantedPath)
            scoped = scoped.filter((f) => f.path === wantedPath || f.path.startsWith(`${wantedPath.replace(/\/$/, '')}/`));
        if (wantedModule)
            scoped = scoped.filter((f) => f.path.startsWith(`${wantedModule}/`));
        if (scoped.length === 0)
            return { summary: 'No indexed files match that scope.', ok: true };
        const tree = buildDirectoryTree(scoped.map((f) => f.path));
        const rendered = renderTree(tree, { maxDepth: depth, maxFiles });
        const header = [
            `Project map (${scoped.length} files, ${scoped.reduce((n, f) => n + f.symbols.length, 0)} symbols, ${modules.length} modules)`,
            'Note: this is a navigation index, not source. Read a file before changing it.',
        ].join('\n');
        return { summary: `${header}\n${rendered}`, verification_state: 'indexed', data: { files: scoped.length } };
    },
};
/* -------------------------------- find_symbol ------------------------------ */
const findSymbolTool = {
    name: 'find_symbol',
    description: 'Locate a function, class, method or type by name. Returns the file and line where it is defined, plus its verification state — the index may be stale, so verify before editing.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        name: stringProp('Symbol name to locate.'),
        exact: booleanProp('Require the symbol name to match exactly. Defaults to true.'),
    }, ['name']),
    async run(args, ctx) {
        if (!ctx.indexStore || !ctx.projectId)
            return { ok: false, summary: 'No project index is available.', error: 'no index' };
        const name = asString(args, 'name');
        const exact = args.exact !== false;
        const matches = await ctx.indexStore.findSymbol(ctx.projectId, name, 25);
        const filtered = exact ? matches.filter((m) => m.symbol === name) : matches;
        if (filtered.length === 0) {
            return { summary: `No symbol matches "${name}" in the index. Try search_text for a literal search.`, ok: true, verification_state: 'unknown' };
        }
        const lines = filtered.map((m) => `${m.file.path}  ${m.symbol}  [${m.file.verification_state}${m.file.stale ? ', stale' : ''}]`);
        return {
            summary: `Found ${filtered.length} definition(s) for "${name}":\n${lines.join('\n')}\nUse verify_source to read the actual code before editing.`,
            verification_state: 'indexed',
            affected_files: filtered.map((m) => m.file.path),
            data: { matches: filtered.length },
        };
    },
};
/* -------------------------------- find_dependencies ------------------------ */
const findDependenciesTool = {
    name: 'find_dependencies',
    description: 'Show what a file imports and what imports it, from the project dependency graph. Use it to find the blast radius of a change.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Project-relative file path.'),
        direction: stringProp('"out" for what this file depends on, "in" for what depends on it. Default "both".', { enum: ['out', 'in', 'both'] }),
    }, ['path']),
    async run(args, ctx) {
        if (!ctx.indexStore || !ctx.projectId)
            return { ok: false, summary: 'No project index is available.', error: 'no index' };
        const path = asString(args, 'path');
        const direction = asOptionalString(args, 'direction') ?? 'both';
        const file = await ctx.indexStore.getFile(ctx.projectId, path);
        if (!file)
            return { ok: false, summary: `Not in the index: ${path}`, error: 'not indexed' };
        const lines = [`${file.path} [${file.verification_state}${file.stale ? ', stale' : ''}]`];
        if (direction === 'out' || direction === 'both') {
            lines.push(`depends on (${file.depends_on_files?.length ?? 0}):`);
            lines.push(...(file.depends_on_files ?? []).map((d) => `  -> ${d}`));
            lines.push(`external (${file.dependencies.length}): ${file.dependencies.slice(0, 20).join(', ') || '(none)'}`);
        }
        if (direction === 'in' || direction === 'both') {
            lines.push(`depended on by (${file.depended_on_by?.length ?? 0}):`);
            lines.push(...(file.depended_on_by ?? []).map((d) => `  <- ${d}`));
        }
        return { summary: lines.join('\n'), verification_state: 'indexed', affected_files: [path] };
    },
};
/* --------------------------------- verify_source --------------------------- */
const verifySourceTool = {
    name: 'verify_source',
    description: 'Read the real source of a symbol or file region from disk and compare it with what the index claims. Use this before any important edit: summaries and indexes can be stale.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Project-relative file path.'),
        symbol: stringProp('Optional symbol name to read the region of.'),
        context_lines: numberProp('Lines of context around the symbol definition. Default 5.', { minimum: 0, maximum: 40 }),
    }, ['path']),
    async run(args, ctx) {
        const path = asString(args, 'path');
        const symbol = asOptionalString(args, 'symbol');
        const contextLines = asNumber(args, 'context_lines', { fallback: 5 });
        const abs = join(ctx.projectRoot, path);
        if (!isInside(ctx.projectRoot, abs))
            return { ok: false, summary: `path escapes the project: ${path}`, error: 'outside project' };
        let text;
        try {
            text = await readFile(abs, 'utf8');
        }
        catch {
            return { ok: false, summary: `cannot read ${path}`, error: 'unreadable' };
        }
        const indexed = ctx.indexStore && ctx.projectId ? await ctx.indexStore.getFile(ctx.projectId, path) : undefined;
        const analysis = analyzeSource(path, text);
        const actualSymbols = analysis.symbols.map((s) => s.name);
        const notes = [];
        if (indexed) {
            const missing = actualSymbols.filter((s) => !indexed.symbols.includes(s));
            const gone = indexed.symbols.filter((s) => !actualSymbols.includes(s));
            if (missing.length === 0 && gone.length === 0 && indexed.hash === '') {
                notes.push('Index has no recorded hash for this file; treating the on-disk source as authoritative.');
            }
            else if (missing.length === 0 && gone.length === 0) {
                notes.push('Index matches the source symbol-for-symbol (verified).');
            }
            else {
                notes.push(`Index drift detected — source wins. missing from index: ${missing.join(', ') || '(none)'}; removed since index: ${gone.join(', ') || '(none)'}`);
            }
        }
        else {
            notes.push('File is not in the index; reading from disk only.');
        }
        const lines = text.split('\n');
        let body;
        let lineStart = 1;
        if (symbol) {
            const found = analysis.symbols.find((s) => s.name === symbol);
            if (!found) {
                return {
                    ok: false,
                    summary: `Symbol "${symbol}" is not present in ${path}. The index may be stale — the source does not define it.`,
                    error: 'symbol not found in source',
                    verification_state: 'stale',
                };
            }
            lineStart = Math.max(1, found.line_start - contextLines);
            const lineEnd = Math.min(lines.length, found.line_end + contextLines);
            body = lines
                .slice(lineStart - 1, lineEnd)
                .map((line, i) => `${String(lineStart + i).padStart(5, ' ')}│ ${line}`)
                .join('\n');
            notes.push(`symbol ${found.name} (${found.kind}) at lines ${found.line_start}-${found.line_end}${found.signature ? `, signature: ${found.signature}` : ''}`);
        }
        else {
            const preview = text.length > ctx.config.context.max_retrieved_file_bytes ? `${text.slice(0, ctx.config.context.max_retrieved_file_bytes)}\n…[truncated]` : text;
            body = preview;
            notes.push(`${lines.length} lines, ${formatBytes(Buffer.byteLength(text, 'utf8'))}`);
        }
        return {
            summary: `${path}${symbol ? ` :: ${symbol}` : ''}\n${notes.map((n) => `- ${n}`).join('\n')}\n\n${body}`,
            output: text,
            affected_files: [path],
            verification_state: 'verified',
            data: { symbols: actualSymbols, index_summary: indexed?.summary, hash: analysis.symbols.length },
        };
    },
};
/* --------------------------------- describe_file --------------------------- */
const describeFileTool = {
    name: 'describe_file',
    description: 'Show the index entry for a file: purpose, symbols, imports, routes and dependency edges, with its verification state.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({ path: stringProp('Project-relative file path.') }, ['path']),
    async run(args, ctx) {
        if (!ctx.indexStore || !ctx.projectId)
            return { ok: false, summary: 'No project index is available.', error: 'no index' };
        const file = await ctx.indexStore.getFile(ctx.projectId, asString(args, 'path'));
        if (!file)
            return { ok: false, summary: 'File is not in the index.', error: 'not indexed' };
        return { summary: renderFileMapEntry(file), verification_state: 'indexed', affected_files: [file.path] };
    },
};
/* --------------------------------- index_status ---------------------------- */
const indexStatusTool = {
    name: 'index_status',
    description: 'Report the state of the project index: file and symbol counts, languages, and whether it is up to date.',
    category: 'project',
    mutating: false,
    parameters: objectSchema({}, []),
    async run(_args, ctx) {
        if (!ctx.indexStore || !ctx.projectId)
            return { ok: false, summary: 'No project index is available.', error: 'no index' };
        const files = await ctx.indexStore.listFiles(ctx.projectId);
        const modules = await ctx.indexStore.listModules(ctx.projectId);
        const languages = new Map();
        let symbols = 0;
        let bytes = 0;
        let stale = 0;
        for (const file of files) {
            languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
            symbols += file.symbols.length;
            bytes += file.size;
            if (file.stale || file.verification_state === 'stale')
                stale += 1;
        }
        const top = [...languages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => `${name} ${n}`).join(', ');
        return {
            summary: [
                `Indexed files: ${files.length}`,
                `Symbols: ${symbols}`,
                `Modules: ${modules.length}`,
                `Size: ${formatBytes(bytes)}`,
                `Stale entries: ${stale}`,
                `Languages: ${top}`,
            ].join('\n'),
            verification_state: 'indexed',
            data: { files: files.length, symbols, modules: modules.length, stale },
        };
    },
};
export function projectTools() {
    return [
        gitStatusTool,
        gitDiffTool,
        gitLogTool,
        projectMapTool,
        findSymbolTool,
        findDependenciesTool,
        verifySourceTool,
        describeFileTool,
        indexStatusTool,
    ];
}
/** Exported for the CLI's `map` command, which renders the same structure. */
export function renderScope(tree, depth, maxFiles) {
    return renderTree(tree, { maxDepth: depth, maxFiles });
}
//# sourceMappingURL=project.js.map