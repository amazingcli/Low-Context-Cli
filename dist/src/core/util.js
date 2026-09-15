/**
 * Small shared utilities.
 *
 * Deliberately dependency-free: Low Context must build and run on a bare Node
 * 18 runtime, offline, with no native modules. Anything that would normally
 * pull in a package (globbing, diffing, gitignore matching, ANSI colours) is
 * implemented in this repository against a narrow, tested interface.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
/* --------------------------------- hashing -------------------------------- */
export function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
export function sha1(input) {
    return createHash('sha1').update(input).digest('hex');
}
/** Short content hash used for index staleness checks. */
export function contentHash(input) {
    return sha256(input).slice(0, 32);
}
/* ----------------------------------- time --------------------------------- */
export function nowIso() {
    return new Date().toISOString();
}
export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** Milliseconds since an ISO timestamp, or Infinity when unparseable. */
export function ageMs(iso, at = Date.now()) {
    if (!iso)
        return Number.POSITIVE_INFINITY;
    const t = Date.parse(iso);
    if (Number.isNaN(t))
        return Number.POSITIVE_INFINITY;
    return Math.max(0, at - t);
}
export const DAY_MS = 86_400_000;
/* ---------------------------------- numbers -------------------------------- */
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function round(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
/* ----------------------------------- json ---------------------------------- */
/** JSON.stringify with deterministic key order — used for record hashing. */
export function stableStringify(value) {
    return JSON.stringify(sortValue(value));
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const inner = value[key];
            if (inner !== undefined)
                out[key] = sortValue(inner);
        }
        return out;
    }
    return value;
}
export function safeJsonParse(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/* --------------------------------- filesystem ------------------------------ */
export async function ensureDir(path) {
    await mkdir(path, { recursive: true });
}
/**
 * Write a file atomically: write to a sibling temp file, fsync-ish via rename.
 * Prevents a crash mid-write from leaving a half-written index or memory file.
 */
export async function atomicWrite(path, data, mode) {
    await ensureDir(dirname(path));
    const tmp = join(dirname(path), `.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    await writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await rename(tmp, path);
}
export async function readTextIfExists(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export async function readJsonIfExists(path) {
    const text = await readTextIfExists(path);
    if (text === undefined || text.trim() === '')
        return undefined;
    const parsed = safeJsonParse(text);
    return parsed.ok ? parsed.value : undefined;
}
export async function removeIfExists(path) {
    await rm(path, { recursive: true, force: true });
}
export function tempPath(name) {
    return join(tmpdir(), `low-context-${process.pid.toString(36)}-${name}`);
}
/* ------------------------------------ text --------------------------------- */
export function truncate(text, maxChars, marker = '…[truncated]') {
    if (text.length <= maxChars)
        return text;
    if (maxChars <= marker.length)
        return text.slice(0, maxChars);
    return text.slice(0, maxChars - marker.length) + marker;
}
/** Truncate keeping the head, which is usually the informative part of a file. */
export function headLines(text, lines) {
    const parts = text.split('\n');
    if (parts.length <= lines)
        return text;
    return `${parts.slice(0, lines).join('\n')}\n…[${parts.length - lines} more lines]`;
}
export function tailLines(text, lines) {
    const parts = text.split('\n');
    if (parts.length <= lines)
        return text;
    return `…[${parts.length - lines} earlier lines]\n${parts.slice(-lines).join('\n')}`;
}
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
export function formatCount(value) {
    return value.toLocaleString('en-US');
}
export function plural(count, singular, pluralWord = `${singular}s`) {
    return count === 1 ? singular : pluralWord;
}
/** Word-level Jaccard similarity, used for redundancy suppression (§55). */
export function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 1;
    let intersection = 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const item of small)
        if (large.has(item))
            intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
/* ----------------------------------- misc ---------------------------------- */
export function unique(items) {
    return [...new Set(items)];
}
export function groupBy(items, key) {
    const out = {};
    for (const item of items) {
        const k = key(item);
        (out[k] ??= []).push(item);
    }
    return out;
}
export function firstDefined(...values) {
    for (const value of values)
        if (value !== undefined)
            return value;
    return undefined;
}
/** Debounce that also exposes `flush()` for shutdown paths. */
export function debounce(fn, waitMs) {
    let timer;
    let lastArgs;
    const wrapped = (...args) => {
        lastArgs = args;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            if (lastArgs)
                fn(...lastArgs);
        }, waitMs);
        timer.unref?.();
    };
    wrapped.flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (lastArgs) {
            fn(...lastArgs);
            lastArgs = undefined;
        }
    };
    return wrapped;
}
/** Simple bounded FIFO cache that reports hit/miss statistics. */
export class LruCache {
    max;
    map = new Map();
    hits = 0;
    misses = 0;
    constructor(max = 512) {
        this.max = max;
    }
    get(key) {
        const value = this.map.get(key);
        if (value === undefined) {
            this.misses += 1;
            return undefined;
        }
        this.hits += 1;
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next();
            if (oldest.done)
                break;
            this.map.delete(oldest.value);
        }
    }
    clear() {
        this.map.clear();
    }
    get size() {
        return this.map.size;
    }
}
//# sourceMappingURL=util.js.map