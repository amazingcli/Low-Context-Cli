/**
 * Git awareness (§38).
 *
 * Low Context shells out to the system `git` rather than linking a library: it
 * is present wherever a repository is, it needs no native build to install, and
 * every call here is read-only. The module never mutates repository state — a
 * `git commit` is only ever issued through the terminal tool, where the
 * permission engine can see it.
 *
 * A historical decision can map to a commit (§8): `logForPath` and `blame`
 * exist so retrieval can point a memory back at the change that produced it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
async function git(cwd, args, maxBuffer = 4 * 1024 * 1024) {
    try {
        const { stdout, stderr } = await run('git', args, { cwd, maxBuffer, windowsHide: true });
        return { ok: true, stdout, stderr, code: 0 };
    }
    catch (error) {
        const err = error;
        return {
            ok: false,
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? err.message ?? '',
            code: err.code ?? 1,
        };
    }
}
export async function isGitRepo(cwd) {
    const result = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return result.ok && result.stdout.trim() === 'true';
}
export async function gitRoot(cwd) {
    const result = await git(cwd, ['rev-parse', '--show-toplevel']);
    return result.ok ? result.stdout.trim() || undefined : undefined;
}
export async function headCommit(cwd) {
    const result = await git(cwd, ['rev-parse', 'HEAD']);
    return result.ok ? result.stdout.trim() || undefined : undefined;
}
export async function currentBranch(cwd) {
    const result = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.ok ? result.stdout.trim() || undefined : undefined;
}
export async function remoteUrl(cwd) {
    const result = await git(cwd, ['config', '--get', 'remote.origin.url']);
    return result.ok ? result.stdout.trim() || undefined : undefined;
}
/** Parse `git status --porcelain=v1` into change categories. */
export async function changedFiles(cwd) {
    const result = await git(cwd, ['status', '--porcelain=v1']);
    const out = { added: [], modified: [], deleted: [], renamed: [], untracked: [] };
    if (!result.ok)
        return out;
    for (const line of result.stdout.split('\n')) {
        if (line.trim() === '')
            continue;
        const code = line.slice(0, 2);
        const path = line.slice(3).trim();
        const target = path.includes(' -> ') ? path.split(' -> ')[1] : path;
        if (code === '??')
            out.untracked.push(target);
        else if (code.includes('R'))
            out.renamed.push(target);
        else if (code.includes('D'))
            out.deleted.push(target);
        else if (code.includes('A'))
            out.added.push(target);
        else
            out.modified.push(target);
    }
    return out;
}
export async function diff(cwd, options = {}) {
    const args = ['diff', '--no-color'];
    if (options.staged)
        args.push('--staged');
    if (options.context !== undefined)
        args.push(`-U${options.context}`);
    if (options.paths && options.paths.length > 0)
        args.push('--', ...options.paths);
    const result = await git(cwd, args);
    return result.ok ? result.stdout : '';
}
export async function log(cwd, options = {}) {
    const args = ['log', `-n${options.limit ?? 20}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'];
    if (options.grep)
        args.push(`--grep=${options.grep}`, '-i');
    if (options.paths && options.paths.length > 0)
        args.push('--', ...options.paths);
    const result = await git(cwd, args);
    if (!result.ok)
        return [];
    return result.stdout
        .split('\x1e')
        .map((record) => record.trim())
        .filter((record) => record !== '')
        .map((record) => {
        const [hash, short, author, date, subject] = record.split('\x1f');
        return {
            hash: hash ?? '',
            short: short ?? '',
            author: author ?? '',
            date: date ?? '',
            subject: subject ?? '',
        };
    });
}
/** Who last touched each line of a file. Bounded because blame is expensive. */
export async function blame(cwd, path, maxLines = 200) {
    const result = await git(cwd, ['blame', '--line-porcelain', '--', path]);
    if (!result.ok)
        return [];
    const out = [];
    let commit = '';
    let author = '';
    let line = 1;
    for (const raw of result.stdout.split('\n')) {
        if (/^[0-9a-f]{40}\s/.test(raw)) {
            commit = raw.slice(0, 8);
            continue;
        }
        if (raw.startsWith('author ')) {
            author = raw.slice(7);
            continue;
        }
        if (raw.startsWith('\t')) {
            out.push({ line, commit, author, text: raw.slice(1) });
            line += 1;
            if (out.length >= maxLines)
                break;
        }
    }
    return out;
}
/** Files changed in the working tree and index, as a single relevance signal. */
export async function changedPathsForRetrieval(cwd) {
    const changes = await changedFiles(cwd);
    return {
        added: [...changes.added, ...changes.untracked],
        modified: changes.modified,
        deleted: changes.deleted,
    };
}
export async function show(cwd, ref, maxBytes = 32_768) {
    const result = await git(cwd, ['show', '--stat', '--no-color', ref]);
    if (!result.ok)
        return '';
    return result.stdout.slice(0, maxBytes);
}
export async function shortStatusSummary(cwd) {
    const branch = await currentBranch(cwd);
    const changes = await changedFiles(cwd);
    const counts = [
        ['modified', changes.modified.length],
        ['added', changes.added.length],
        ['deleted', changes.deleted.length],
        ['renamed', changes.renamed.length],
        ['untracked', changes.untracked.length],
    ];
    const active = counts.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
    return `branch ${branch ?? '(detached)'}${active.length > 0 ? ` — ${active.join(', ')}` : ' — clean'}`;
}
//# sourceMappingURL=git.js.map