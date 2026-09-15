/**
 * Observability (§46).
 *
 * Two distinct streams:
 *   - `Logger` writes structured JSONL to $LOW_CONTEXT_HOME/logs for later
 *     inspection (`low-context logs`). It records requests, retrieval, tool
 *     calls, latency, token usage, errors, index and memory operations.
 *   - `AgentEventLog` keeps an in-memory ring of events for the current run so
 *     the agent can extract memory records from what actually happened (§35).
 *
 * Secrets are redacted on the way in, not on the way out — a value that never
 * reaches the file cannot leak from it (§80).
 */
import { appendFile, readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { globalPaths } from './paths.js';
import { ensureDir, nowIso, formatBytes } from './util.js';
import { newId } from './ids.js';
import { redact } from '../security/redact.js';
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
export class Logger {
    dir;
    level;
    logPrompts;
    mirror;
    file;
    queue = Promise.resolve();
    written = 0;
    constructor(options = {}) {
        this.dir = options.dir ?? globalPaths().logs;
        this.level = options.level ?? 'info';
        this.logPrompts = options.logPrompts ?? false;
        this.mirror = options.mirrorToStderr ?? false;
        const day = new Date().toISOString().slice(0, 10);
        this.file = join(this.dir, options.fileName ?? `low-context-${day}.jsonl`);
    }
    get path() {
        return this.file;
    }
    debug(event, data) {
        this.write('debug', event, data);
    }
    info(event, data) {
        this.write('info', event, data);
    }
    warn(event, data) {
        this.write('warn', event, data);
    }
    error(event, data) {
        this.write('error', event, data);
    }
    /** Record a prompt/message body, honouring `privacy.log_prompts`. */
    prompt(event, content, data) {
        if (!this.logPrompts) {
            this.write('debug', event, { ...data, content_length: content.length, content_omitted: true });
            return;
        }
        this.write('debug', event, { ...data, content });
    }
    write(level, event, data) {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level])
            return;
        const entry = { at: nowIso(), level, event };
        if (data)
            entry.data = redact(data);
        const line = `${JSON.stringify(entry)}\n`;
        if (this.mirror)
            process.stderr.write(`${level} ${event}\n`);
        this.written += 1;
        this.queue = this.queue
            .then(async () => {
            await ensureDir(this.dir);
            await appendFile(this.file, line, 'utf8');
        })
            .catch(() => {
            // Logging must never take down the agent.
        });
    }
    /** Wait for all queued writes to land. */
    async flush() {
        await this.queue;
    }
    get entriesWritten() {
        return this.written;
    }
}
/** A logger that discards everything — used by tests and `--quiet`. */
export class NullLogger extends Logger {
    constructor() {
        super({ dir: '/dev/null', level: 'error' });
    }
    debug() { }
    info() { }
    warn() { }
    error() { }
    prompt() { }
    async flush() { }
}
/* ------------------------------ event recording ---------------------------- */
/**
 * Bounded in-memory event log for the active session. The memory writer reads
 * this to turn *verified* actions into durable memory records (§35): a guess
 * the model made is not an event, but a successful edit plus a passing test is.
 */
export class AgentEventLog {
    capacity;
    events = [];
    constructor(capacity = 2_000) {
        this.capacity = capacity;
    }
    record(kind, summary, data) {
        const event = {
            id: newId('evt'),
            at: nowIso(),
            kind,
            summary,
            ...(data === undefined ? {} : { data: redact(data) }),
        };
        this.events.push(event);
        if (this.events.length > this.capacity)
            this.events.splice(0, this.events.length - this.capacity);
        return event;
    }
    all() {
        return this.events;
    }
    byKind(kind) {
        return this.events.filter((e) => e.kind === kind);
    }
    since(iso) {
        const t = Date.parse(iso);
        if (Number.isNaN(t))
            return [...this.events];
        return this.events.filter((e) => Date.parse(e.at) >= t);
    }
    clear() {
        this.events.length = 0;
    }
    get size() {
        return this.events.length;
    }
}
export async function listLogFiles(dir = globalPaths().logs) {
    try {
        const entries = await readdir(dir);
        const out = [];
        for (const name of entries) {
            if (!name.endsWith('.jsonl'))
                continue;
            const path = join(dir, name);
            const info = await stat(path);
            out.push({ path, bytes: info.size, modified_at: info.mtime.toISOString() });
        }
        return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
    }
    catch {
        return [];
    }
}
/** Read the tail of a log file, newest lines last. */
export async function readLogTail(path, lines = 50) {
    const text = await readFile(path, 'utf8');
    const parsed = [];
    for (const raw of text.split('\n')) {
        if (raw.trim() === '')
            continue;
        try {
            parsed.push(JSON.parse(raw));
        }
        catch {
            // Skip corrupt lines rather than aborting the whole read.
        }
    }
    return parsed.slice(-lines);
}
export async function pruneLogs(retentionDays, dir = globalPaths().logs) {
    if (retentionDays <= 0)
        return 0;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    let removed = 0;
    for (const file of await listLogFiles(dir)) {
        if (Date.parse(file.modified_at) < cutoff) {
            await rm(file.path, { force: true });
            removed += 1;
        }
    }
    return removed;
}
export function describeLogFile(info) {
    return `${info.path} (${formatBytes(info.bytes)})`;
}
//# sourceMappingURL=logger.js.map