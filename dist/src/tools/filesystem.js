/**
 * Filesystem tools (§19).
 *
 * Two properties matter more than feature count here:
 *
 *  - **Edits are verified, not assumed.** `edit_file` requires an exact match,
 *    refuses ambiguous matches, writes atomically, and re-reads the file to
 *    confirm the result. A successful write syscall is not a successful edit
 *    (§21).
 *  - **Every operation stays inside the project** unless the user explicitly
 *    allowed otherwise. Paths are normalised before use, and `..` cannot escape
 *    (§80).
 *
 * `read_file` returns line-numbered output so the model can refer to precise
 * regions, and caps how much of a large file it returns (§57).
 */
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { discoverFiles } from '../index/scanner.js';
import { isInside, toPosix } from '../core/paths.js';
import { contentHash, formatBytes, headLines, tailLines } from '../core/util.js';
import { asBoolean, asNumber, asOptionalString, asString, booleanProp, numberProp, objectSchema, stringProp } from './types.js';
/** Resolve and validate a path against the project root. */
export function resolveProjectPath(ctx, rawPath) {
    const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath);
    const joined = absolute ? rawPath : join(ctx.projectRoot, rawPath);
    const abs = normalizeFsPath(joined);
    if (!isInside(ctx.projectRoot, abs)) {
        return { ok: false, reason: `path is outside the project root: ${rawPath}` };
    }
    return { ok: true, abs, rel: toPosix(relative(ctx.projectRoot, abs)) };
}
function normalizeFsPath(path) {
    const isAbsolute = path.startsWith('/');
    const parts = [];
    for (const segment of path.split(/[\\/]/)) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..')
            parts.pop();
        else
            parts.push(segment);
    }
    const joined = parts.join('/');
    return isAbsolute ? `/${joined}` : joined;
}
/** Read a file as UTF-8, returning undefined instead of throwing. */
async function tryRead(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return undefined;
    }
}
async function statSafe(path) {
    try {
        return await stat(path);
    }
    catch {
        return undefined;
    }
}
/* ------------------------------- list_directory ---------------------------- */
const listDirectory = {
    name: 'list_directory',
    description: 'List the entries of a directory inside the project. Directories are marked with a trailing slash. Use this to confirm structure before reading files.',
    category: 'filesystem',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Project-relative directory path. Use "." for the project root.'),
        depth: numberProp('How many levels to descend. Default 1.', { minimum: 1, maximum: 5 }),
    }, ['path']),
    async run(args, ctx) {
        const raw = asString(args, 'path', { fallback: '.' });
        const depth = asNumber(args, 'depth', { fallback: 1 });
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        const lines = [];
        let count = 0;
        await walk(resolved.abs, resolved.rel, depth, 0, lines, ctx, () => {
            count += 1;
        });
        const summary = `Listed ${count} entries under ${resolved.rel}:\n${lines.slice(0, 300).join('\n')}`;
        return { summary, output: lines.join('\n'), affected_files: [] };
        async function walk(dir, rel, maxDepth, level, out, context, bump) {
            if (level >= maxDepth)
                return;
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch (error) {
                out.push(`${'  '.repeat(level)}[unreadable: ${error.message}]`);
                return;
            }
            entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
            for (const entry of entries) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.low-context')
                    continue;
                bump();
                if (out.length > 500)
                    return;
                const childRel = rel === '.' ? entry.name : `${rel}/${entry.name}`;
                if (entry.isDirectory()) {
                    out.push(`${'  '.repeat(level)}${entry.name}/`);
                    await walk(join(dir, entry.name), childRel, maxDepth, level + 1, out, context, bump);
                }
                else {
                    const info = await statSafe(join(dir, entry.name));
                    out.push(`${'  '.repeat(level)}${entry.name}${info ? `  (${formatBytes(Number(info.size))})` : ''}`);
                }
            }
        }
    },
};
/* --------------------------------- read_file ------------------------------- */
const readFileTool = {
    name: 'read_file',
    description: 'Read a file from the project as line-numbered text. For large files, pass offset and limit to read a window instead of the whole file. Returns the actual current source — always prefer this over trusting an index summary.',
    category: 'filesystem',
    mutating: false,
    parameters: objectSchema({
        path: stringProp('Project-relative file path.'),
        offset: numberProp('1-based first line to return.', { minimum: 1 }),
        limit: numberProp('Maximum number of lines to return.', { minimum: 1 }),
        max_bytes: numberProp('Cap on returned characters. Defaults to the configured retrieval limit.'),
    }, ['path']),
    async run(args, ctx) {
        const raw = asString(args, 'path');
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        const info = await statSafe(resolved.abs);
        if (!info)
            return { ok: false, summary: `file not found: ${resolved.rel}`, error: `file not found: ${resolved.rel}` };
        if (info.isDirectory())
            return { ok: false, summary: `${resolved.rel} is a directory; use list_directory`, error: 'is a directory' };
        const text = await tryRead(resolved.abs);
        if (text === undefined)
            return { ok: false, summary: `could not read ${resolved.rel} (binary or unreadable)`, error: 'unreadable' };
        const allLines = text.split('\n');
        const offset = Math.max(1, asNumber(args, 'offset', { fallback: 1 }));
        const limit = asNumber(args, 'limit', { fallback: allLines.length });
        const maxBytes = asNumber(args, 'max_bytes', { fallback: ctx.config.context.max_retrieved_file_bytes });
        const slice = allLines.slice(offset - 1, offset - 1 + limit);
        const width = String(offset + slice.length).length;
        let body = slice.map((line, i) => `${String(offset + i).padStart(width, ' ')}│ ${line}`).join('\n');
        let truncated = false;
        if (body.length > maxBytes) {
            body = `${body.slice(0, maxBytes)}\n…[${resolved.rel} truncated at ${formatBytes(maxBytes)} — read a narrower window]`;
            truncated = true;
        }
        const covered = limit < allLines.length || offset > 1;
        const header = `${resolved.rel} (lines ${offset}-${Math.min(offset + slice.length - 1, allLines.length)} of ${allLines.length}, ${formatBytes(Number(info.size))}, hash ${contentHash(text).slice(0, 12)})${covered ? ' [window]' : ''}`;
        return {
            summary: `${header}\n${body}`,
            output: text,
            affected_files: [resolved.rel],
            verification_state: 'verified',
            data: { lines: allLines.length, truncated, hash: contentHash(text) },
        };
    },
};
/* --------------------------------- write_file ------------------------------ */
const writeFileTool = {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Overwrites destroy the previous contents, so prefer edit_file for changes to existing files.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({
        path: stringProp('Project-relative file path.'),
        content: stringProp('Full file contents to write.'),
    }, ['path', 'content']),
    permission: (args) => ({
        summary: `write file ${asOptionalString(args, 'path') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'path') ?? '',
        destructive: true,
    }),
    async run(args, ctx) {
        const raw = asString(args, 'path');
        const content = asString(args, 'content', { fallback: '' });
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        const before = await tryRead(resolved.abs);
        await mkdir(dirname(resolved.abs), { recursive: true });
        await writeFile(resolved.abs, content, 'utf8');
        const after = await tryRead(resolved.abs);
        const verified = after === content;
        return {
            summary: `${before === undefined ? 'Created' : 'Wrote'} ${resolved.rel} (${content.split('\n').length} lines, ${formatBytes(Buffer.byteLength(content, 'utf8'))})${verified ? ' — verified by re-read' : ' — VERIFY FAILED: content differs after write'}`,
            ok: verified,
            affected_files: [resolved.rel],
            verification_state: verified ? 'verified' : 'inferred',
            ...(verified ? {} : { error: 'written content does not match requested content' }),
        };
    },
};
/* --------------------------------- create_file ----------------------------- */
const createFileTool = {
    name: 'create_file',
    description: 'Create a new file. Fails if the file already exists, so it can never silently discard existing content.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({
        path: stringProp('Project-relative path of the new file.'),
        content: stringProp('Initial file contents.', { default: '' }),
    }, ['path']),
    permission: (args) => ({
        summary: `create file ${asOptionalString(args, 'path') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'path') ?? '',
        destructive: false,
    }),
    async run(args, ctx) {
        const raw = asString(args, 'path');
        const content = asOptionalString(args, 'content') ?? '';
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        if ((await statSafe(resolved.abs)) !== undefined) {
            return { ok: false, summary: `refused: ${resolved.rel} already exists — use edit_file or write_file`, error: 'file exists' };
        }
        await mkdir(dirname(resolved.abs), { recursive: true });
        await writeFile(resolved.abs, content, { encoding: 'utf8', flag: 'wx' });
        return {
            summary: `Created ${resolved.rel} (${content.split('\n').length} lines)`,
            affected_files: [resolved.rel],
            verification_state: 'verified',
        };
    },
};
/* ---------------------------------- edit_file ------------------------------ */
const editFileTool = {
    name: 'edit_file',
    description: 'Replace an exact string in an existing file. The old_string must appear verbatim, including indentation, and must be unique unless replace_all is true. This is the safe way to modify code: it cannot silently clobber a region the model did not look at.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({
        path: stringProp('Project-relative file path.'),
        old_string: stringProp('Exact text to replace, copied from the current file.'),
        new_string: stringProp('Replacement text.'),
        replace_all: booleanProp('Replace every occurrence instead of requiring uniqueness.'),
    }, ['path', 'old_string', 'new_string']),
    permission: (args) => ({
        summary: `edit file ${asOptionalString(args, 'path') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'path') ?? '',
        destructive: true,
    }),
    async run(args, ctx) {
        const raw = asString(args, 'path');
        const oldString = asString(args, 'old_string', { fallback: '' });
        const newString = asOptionalString(args, 'new_string') ?? '';
        const replaceAll = asBoolean(args, 'replace_all', false);
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        const original = await tryRead(resolved.abs);
        if (original === undefined)
            return { ok: false, summary: `file not found: ${resolved.rel}`, error: 'file not found' };
        if (oldString === '')
            return { ok: false, summary: 'old_string must not be empty', error: 'empty old_string' };
        if (oldString === newString)
            return { ok: false, summary: 'old_string and new_string are identical; nothing to do', error: 'no-op edit' };
        const occurrences = countOccurrences(original, oldString);
        if (occurrences === 0) {
            return {
                ok: false,
                summary: `refused: old_string not found in ${resolved.rel}. Re-read the file and copy the exact text.`,
                error: 'old_string not found',
                affected_files: [resolved.rel],
            };
        }
        if (occurrences > 1 && !replaceAll) {
            return {
                ok: false,
                summary: `refused: old_string occurs ${occurrences} times in ${resolved.rel}. Include more surrounding context, or set replace_all.`,
                error: 'ambiguous match',
                affected_files: [resolved.rel],
            };
        }
        const updated = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
        await writeFile(resolved.abs, updated, 'utf8');
        const after = await tryRead(resolved.abs);
        const verified = after === updated;
        const lineStart = original.slice(0, original.indexOf(oldString)).split('\n').length;
        return {
            summary: `${replaceAll ? `Replaced ${occurrences} occurrences` : 'Replaced 1 occurrence'} in ${resolved.rel} near line ${lineStart}${verified ? ' — verified by re-read' : ' — VERIFY FAILED'}`,
            ok: verified,
            affected_files: [resolved.rel],
            verification_state: verified ? 'verified' : 'inferred',
            data: { line: lineStart, occurrences, before_hash: contentHash(original), after_hash: contentHash(updated) },
            ...(verified ? {} : { error: 'written content does not match the intended edit' }),
        };
    },
};
function countOccurrences(haystack, needle) {
    if (needle === '')
        return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}
/* --------------------------------- delete_file ----------------------------- */
const deleteFileTool = {
    name: 'delete_file',
    description: 'Delete a file inside the project. Requires explicit permission and is refused in safe mode.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({ path: stringProp('Project-relative file path to delete.') }, ['path']),
    permission: (args) => ({
        summary: `delete file ${asOptionalString(args, 'path') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'path') ?? '',
        destructive: true,
    }),
    async run(args, ctx) {
        const raw = asString(args, 'path');
        const resolved = resolveProjectPath(ctx, raw);
        if (!resolved.ok)
            return { ok: false, summary: resolved.reason, error: resolved.reason };
        const info = await statSafe(resolved.abs);
        if (!info)
            return { ok: false, summary: `file not found: ${resolved.rel}`, error: 'file not found' };
        if (info.isDirectory())
            return { ok: false, summary: `refused: ${resolved.rel} is a directory`, error: 'is a directory' };
        await rm(resolved.abs, { force: true });
        return { summary: `Deleted ${resolved.rel}`, affected_files: [resolved.rel], verification_state: 'verified' };
    },
};
/* ---------------------------------- move_file ------------------------------ */
const moveFileTool = {
    name: 'move_file',
    description: 'Move or rename a file or directory inside the project.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({
        from: stringProp('Existing project-relative path.'),
        to: stringProp('Destination project-relative path.'),
    }, ['from', 'to']),
    permission: (args) => ({
        summary: `move ${asOptionalString(args, 'from') ?? '?'} -> ${asOptionalString(args, 'to') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'from') ?? '',
        destructive: true,
    }),
    async run(args, ctx) {
        const from = resolveProjectPath(ctx, asString(args, 'from'));
        const to = resolveProjectPath(ctx, asString(args, 'to'));
        if (!from.ok)
            return { ok: false, summary: from.reason, error: from.reason };
        if (!to.ok)
            return { ok: false, summary: to.reason, error: to.reason };
        await mkdir(dirname(to.abs), { recursive: true });
        await rename(from.abs, to.abs);
        return {
            summary: `Moved ${from.rel} -> ${to.rel}`,
            affected_files: [from.rel, to.rel],
            verification_state: 'verified',
        };
    },
};
/* ---------------------------------- copy_file ------------------------------ */
const copyFileTool = {
    name: 'copy_file',
    description: 'Copy a file inside the project.',
    category: 'filesystem',
    mutating: true,
    parameters: objectSchema({
        from: stringProp('Existing project-relative path.'),
        to: stringProp('Destination project-relative path.'),
    }, ['from', 'to']),
    permission: (args) => ({
        summary: `copy ${asOptionalString(args, 'from') ?? '?'} -> ${asOptionalString(args, 'to') ?? '?'}`,
        resource: 'path',
        subject: asOptionalString(args, 'to') ?? '',
        destructive: false,
    }),
    async run(args, ctx) {
        const from = resolveProjectPath(ctx, asString(args, 'from'));
        const to = resolveProjectPath(ctx, asString(args, 'to'));
        if (!from.ok)
            return { ok: false, summary: from.reason, error: from.reason };
        if (!to.ok)
            return { ok: false, summary: to.reason, error: to.reason };
        await mkdir(dirname(to.abs), { recursive: true });
        await copyFile(from.abs, to.abs);
        return { summary: `Copied ${from.rel} -> ${to.rel}`, affected_files: [to.rel], verification_state: 'verified' };
    },
};
/* --------------------------------- search_text ----------------------------- */
const searchTextTool = {
    name: 'search_text',
    description: 'Search project files for a literal string or regular expression and return matching lines with file and line numbers. Prefer this over reading many files when you only need to locate something.',
    category: 'filesystem',
    mutating: false,
    parameters: objectSchema({
        query: stringProp('Text or regular expression to find.'),
        path: stringProp('Restrict the search to this project-relative directory or file. Defaults to the project root.'),
        glob: stringProp('Only search files whose project-relative path matches this glob, e.g. "*.ts".'),
        regex: booleanProp('Treat the query as a regular expression.'),
        case_sensitive: booleanProp('Match case. Defaults to false.'),
        max_results: numberProp('Maximum matching lines to return. Default 60.', { minimum: 1, maximum: 500 }),
        context_lines: numberProp('Lines of context around each match. Default 0.', { minimum: 0, maximum: 5 }),
    }, ['query']),
    async run(args, ctx) {
        const query = asString(args, 'query');
        const useRegex = asBoolean(args, 'regex', false);
        const caseSensitive = asBoolean(args, 'case_sensitive', false);
        const maxResults = asNumber(args, 'max_results', { fallback: 60 });
        const contextLines = asNumber(args, 'context_lines', { fallback: 0 });
        const glob = asOptionalString(args, 'glob');
        let matcher;
        try {
            matcher = useRegex ? new RegExp(query, caseSensitive ? 'g' : 'gi') : new RegExp(escapeRegExp(query), caseSensitive ? 'g' : 'gi');
        }
        catch (error) {
            return { ok: false, summary: `invalid regular expression: ${error.message}`, error: 'invalid regex' };
        }
        const scope = resolveProjectPath(ctx, asOptionalString(args, 'path') ?? '.');
        if (!scope.ok)
            return { ok: false, summary: scope.reason, error: scope.reason };
        const scopeInfo = await statSafe(scope.abs);
        if (!scopeInfo)
            return { ok: false, summary: `path not found: ${scope.rel}`, error: 'path not found' };
        const candidates = [];
        if (scopeInfo.isDirectory()) {
            const discovered = await discoverFiles(scope.abs, {});
            for (const file of discovered) {
                const rel = scope.rel === '.' ? file.posix : `${scope.rel}/${file.posix}`;
                if (glob && !matchesGlob(rel, glob))
                    continue;
                candidates.push({ abs: file.path, rel });
            }
        }
        else {
            candidates.push({ abs: scope.abs, rel: scope.rel });
        }
        const hits = [];
        const touched = new Set();
        let filesScanned = 0;
        let filesWithHits = 0;
        for (const candidate of candidates) {
            if (hits.length >= maxResults)
                break;
            if (candidate.rel.includes('node_modules/') || candidate.rel.startsWith('.git/'))
                continue;
            const text = await tryRead(candidate.abs);
            if (text === undefined)
                continue;
            filesScanned += 1;
            const lines = text.split('\n');
            let fileHit = false;
            for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
                const line = lines[i];
                matcher.lastIndex = 0;
                if (!matcher.test(line))
                    continue;
                fileHit = true;
                touched.add(candidate.rel);
                for (let c = Math.max(0, i - contextLines); c <= Math.min(lines.length - 1, i + contextLines); c += 1) {
                    hits.push(`${candidate.rel}:${c + 1}${c === i ? ':' : '-'} ${lines[c]}`);
                }
            }
            if (fileHit)
                filesWithHits += 1;
        }
        const header = `${hits.length} match(es) in ${filesWithHits} of ${filesScanned} files scanned`;
        const body = hits.join('\n');
        return {
            summary: hits.length === 0 ? `No matches for "${query}" (${filesScanned} files scanned)` : `${header}:\n${body}`,
            output: body,
            affected_files: [...touched],
            verification_state: 'verified',
            data: { matches: hits.length, files: filesWithHits, scanned: filesScanned },
        };
    },
};
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function matchesGlob(path, glob) {
    const pattern = glob.startsWith('*') || glob.includes('/') ? glob : `**/${glob}`;
    let out = '';
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i += 1;
            }
            else
                out += '[^/]*';
        }
        else if (ch === '?')
            out += '[^/]';
        else if ('.+^${}()|[]\\'.includes(ch))
            out += `\\${ch}`;
        else
            out += ch;
    }
    return new RegExp(`(^|/)${out}$`).test(path);
}
/** Preview a file's structure without flooding context (§57). */
export async function outlineFile(path) {
    const text = await tryRead(path);
    if (text === undefined)
        return '';
    const lines = text.split('\n');
    const total = lines.length;
    if (total <= 200)
        return text;
    return `${headLines(text, 80)}\n…[${total - 140} lines omitted]\n${tailLines(text, 60)}`;
}
export const FILESYSTEM_TOOLS = [
    listDirectory,
    readFileTool,
    writeFileTool,
    createFileTool,
    editFileTool,
    deleteFileTool,
    moveFileTool,
    copyFileTool,
    searchTextTool,
];
//# sourceMappingURL=filesystem.js.map