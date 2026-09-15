/**
 * Gitignore-style matching, implemented locally so the core has no runtime
 * dependencies. Supports the subset that matters for project scanning:
 *
 *   - blank lines and `#` comments
 *   - `!` negation
 *   - trailing `/` -> directory-only rule
 *   - `/` anchored patterns (relative to the ignore file's root)
 *   - non-anchored patterns match at any depth
 *   - `*`, `?`, `**` globs, including `**/ ` prefixes and `; /**` suffixes
*
* A file is ignored if the last matching rule is an ignore rule; a matching
* negation re-includes it. `*` and `?` never cross `/`.
*/
export function compileIgnorePattern(pattern) {
    const raw = pattern.trim();
    let body = raw;
    let negated = false;
    let dirOnly = false;
    if (body.startsWith('!')) {
        negated = true;
        body = body.slice(1);
    }
    if (body.startsWith('\\!'))
        body = body.slice(1);
    if (body.endsWith('/')) {
        dirOnly = true;
        body = body.slice(0, -1);
    }
    if (body === '')
        body = '**';
    const anchored = body.startsWith('/');
    if (anchored)
        body = body.slice(1);
    const re = body
        .split('/')
        .map((segment) => globSegmentToRegex(segment))
        .join('/');
    let full = `^${re}$`;
    if (!anchored) {
        full = `^(?:.*/)?${re}$`; // match at any depth but keep segment boundaries
    }
    if (anchored && body === '**')
        full = '^(?:.*)$';
    return { raw, negated, dirOnly, anchored, regex: new RegExp(full) };
}
function globSegmentToRegex(segment) {
    let out = '';
    let i = 0;
    while (i < segment.length) {
        const ch = segment[i];
        if (ch === '*') {
            if (segment[i + 1] === '*') {
                // `**` inside a segment — only valid alone or as leading/trailing glob.
                out += '.*';
                i += 2;
                continue;
            }
            out += '[^/]*';
            i += 1;
            continue;
        }
        if (ch === '?') {
            out += '[^/]';
            i += 1;
            continue;
        }
        if (ch === '[') {
            const close = segment.indexOf(']', i + 1);
            if (close === -1) {
                out += '\\[';
                i += 1;
                continue;
            }
            const inner = segment.slice(i + 1, close);
            // Handle leading `!` negation inside classes: git uses `!`, regex uses `^`.
            const negatedClass = inner.startsWith('!');
            const body = negatedClass ? inner.slice(1) : inner;
            out += `[${negatedClass ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`;
            i = close + 1;
            continue;
        }
        out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
        i += 1;
    }
    return out;
}
export class IgnoreMatcher {
    rules;
    constructor(patterns = []) {
        this.rules = patterns
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('#'))
            .map((line) => compileIgnorePattern(line));
    }
    /** True when `relativePath` (POSIX, no leading slash) is ignored. */
    ignores(relativePath, isDirectory) {
        const path = relativePath.replace(/^\/+/, '');
        let ignored = false;
        for (const rule of this.rules) {
            if (rule.dirOnly && !isDirectory)
                continue;
            if (rule.anchored && path.startsWith('.') && !path.startsWith(rule.raw.split('/')[0]))
                continue;
            if (rule.regex.test(path))
                ignored = !rule.negated;
        }
        return ignored;
    }
    /** List the effective rules for diagnostics. */
    describe() {
        return this.rules.map((r) => (r.negated ? `!${r.raw}` : r.raw));
    }
}
/** Compose scanner ignore mats: built-in deny list + .gitignore + config. */
export function buildIgnoreMatcher(options) {
    const patterns = [...(options.alwaysIgnore ?? []), ...(options.gitignorePatterns ?? []), ...(options.extraPatterns ?? [])];
    return new IgnoreMatcher(patterns);
}
//# sourceMappingURL=ignore.js.map