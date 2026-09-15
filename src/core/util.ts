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

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function sha1(input: string | Uint8Array): string {
  return createHash('sha1').update(input).digest('hex');
}

/** Short content hash used for index staleness checks. */
export function contentHash(input: string): string {
  return sha256(input).slice(0, 32);
}

/* ----------------------------------- time --------------------------------- */

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
export function ageMs(iso: string | undefined, at = Date.now()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, at - t);
}

export const DAY_MS = 86_400_000;

/* ---------------------------------- numbers -------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ----------------------------------- json ---------------------------------- */

/** JSON.stringify with deterministic key order — used for record hashing. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortValue(inner);
    }
    return out;
  }
  return value;
}

export function safeJsonParse<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* --------------------------------- filesystem ------------------------------ */

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Write a file atomically: write to a sibling temp file, fsync-ish via rename.
 * Prevents a crash mid-write from leaving a half-written index or memory file.
 */
export async function atomicWrite(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = join(
    dirname(path),
    `.${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await writeFile(tmp, data, mode === undefined ? undefined : { mode });
  await rename(tmp, path);
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  const text = await readTextIfExists(path);
  if (text === undefined || text.trim() === '') return undefined;
  const parsed = safeJsonParse<T>(text);
  return parsed.ok ? parsed.value : undefined;
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function tempPath(name: string): string {
  return join(tmpdir(), `low-context-${process.pid.toString(36)}-${name}`);
}

/* ------------------------------------ text --------------------------------- */

export function truncate(text: string, maxChars: number, marker = '…[truncated]'): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length) + marker;
}

/** Truncate keeping the head, which is usually the informative part of a file. */
export function headLines(text: string, lines: number): string {
  const parts = text.split('\n');
  if (parts.length <= lines) return text;
  return `${parts.slice(0, lines).join('\n')}\n…[${parts.length - lines} more lines]`;
}

export function tailLines(text: string, lines: number): string {
  const parts = text.split('\n');
  if (parts.length <= lines) return text;
  return `…[${parts.length - lines} earlier lines]\n${parts.slice(-lines).join('\n')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return count === 1 ? singular : pluralWord;
}

/** Word-level Jaccard similarity, used for redundancy suppression (§55). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/* ----------------------------------- misc ---------------------------------- */

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

export function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/** Debounce that also exposes `flush()` for shutdown paths. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: NodeJS.Timeout | undefined;
  let lastArgs: A | undefined;
  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (lastArgs) fn(...lastArgs);
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
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();
  hits = 0;
  misses = 0;
  constructor(private readonly max = 512) {}

  get(key: K): V | undefined {
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

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
