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
import type { AgentEvent } from './types.js';
import { newId } from './ids.js';
import { redact } from '../security/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEntry {
  at: string;
  level: LogLevel;
  event: string;
  data?: Record<string, unknown>;
}

export interface LoggerOptions {
  /** Directory for log files. Defaults to $LOW_CONTEXT_HOME/logs. */
  dir?: string;
  level?: LogLevel;
  /** Include full prompts and message bodies. Off by default (§47). */
  logPrompts?: boolean;
  /** Mirror entries to stderr for interactive debugging. */
  mirrorToStderr?: boolean;
  fileName?: string;
}

export class Logger {
  private readonly dir: string;
  private readonly level: LogLevel;
  private readonly logPrompts: boolean;
  private readonly mirror: boolean;
  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();
  private written = 0;

  constructor(options: LoggerOptions = {}) {
    this.dir = options.dir ?? globalPaths().logs;
    this.level = options.level ?? 'info';
    this.logPrompts = options.logPrompts ?? false;
    this.mirror = options.mirrorToStderr ?? false;
    const day = new Date().toISOString().slice(0, 10);
    this.file = join(this.dir, options.fileName ?? `low-context-${day}.jsonl`);
  }

  get path(): string {
    return this.file;
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write('debug', event, data);
  }
  info(event: string, data?: Record<string, unknown>): void {
    this.write('info', event, data);
  }
  warn(event: string, data?: Record<string, unknown>): void {
    this.write('warn', event, data);
  }
  error(event: string, data?: Record<string, unknown>): void {
    this.write('error', event, data);
  }

  /** Record a prompt/message body, honouring `privacy.log_prompts`. */
  prompt(event: string, content: string, data?: Record<string, unknown>): void {
    if (!this.logPrompts) {
      this.write('debug', event, { ...data, content_length: content.length, content_omitted: true });
      return;
    }
    this.write('debug', event, { ...data, content });
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const entry: LogEntry = { at: nowIso(), level, event };
    if (data) entry.data = redact(data) as Record<string, unknown>;
    const line = `${JSON.stringify(entry)}\n`;
    if (this.mirror) process.stderr.write(`${level} ${event}\n`);
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
  async flush(): Promise<void> {
    await this.queue;
  }

  get entriesWritten(): number {
    return this.written;
  }
}

/** A logger that discards everything — used by tests and `--quiet`. */
export class NullLogger extends Logger {
  constructor() {
    super({ dir: '/dev/null', level: 'error' });
  }
  override debug(): void {}
  override info(): void {}
  override warn(): void {}
  override error(): void {}
  override prompt(): void {}
  override async flush(): Promise<void> {}
}

/* ------------------------------ event recording ---------------------------- */

/**
 * Bounded in-memory event log for the active session. The memory writer reads
 * this to turn *verified* actions into durable memory records (§35): a guess
 * the model made is not an event, but a successful edit plus a passing test is.
 */
export class AgentEventLog {
  private readonly events: AgentEvent[] = [];

  constructor(private readonly capacity = 2_000) {}

  record(
    kind: AgentEvent['kind'],
    summary: string,
    data?: Record<string, unknown>,
  ): AgentEvent {
    const event: AgentEvent = {
      id: newId('evt'),
      at: nowIso(),
      kind,
      summary,
      ...(data === undefined ? {} : { data: redact(data) as Record<string, unknown> }),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return event;
  }

  all(): readonly AgentEvent[] {
    return this.events;
  }

  byKind(kind: AgentEvent['kind']): AgentEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }

  since(iso: string): AgentEvent[] {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return [...this.events];
    return this.events.filter((e) => Date.parse(e.at) >= t);
  }

  clear(): void {
    this.events.length = 0;
  }

  get size(): number {
    return this.events.length;
  }
}

/* --------------------------------- reading --------------------------------- */

export interface LogFileInfo {
  path: string;
  bytes: number;
  modified_at: string;
}

export async function listLogFiles(dir = globalPaths().logs): Promise<LogFileInfo[]> {
  try {
    const entries = await readdir(dir);
    const out: LogFileInfo[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const info = await stat(path);
      out.push({ path, bytes: info.size, modified_at: info.mtime.toISOString() });
    }
    return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  } catch {
    return [];
  }
}

/** Read the tail of a log file, newest lines last. */
export async function readLogTail(path: string, lines = 50): Promise<LogEntry[]> {
  const text = await readFile(path, 'utf8');
  const parsed: LogEntry[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      parsed.push(JSON.parse(raw) as LogEntry);
    } catch {
      // Skip corrupt lines rather than aborting the whole read.
    }
  }
  return parsed.slice(-lines);
}

export async function pruneLogs(retentionDays: number, dir = globalPaths().logs): Promise<number> {
  if (retentionDays <= 0) return 0;
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

export function describeLogFile(info: LogFileInfo): string {
  return `${info.path} (${formatBytes(info.bytes)})`;
}
