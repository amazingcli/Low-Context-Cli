/**
 * Append-only JSONL log with a persisted offset index.
 *
 * Conversations and memory must scale to very large histories (§7) without
 * either (a) rewriting the file on every append, or (b) rescanning the whole
 * file to find a record. So each log keeps a sidecar `*.offsets.json` holding
 * the byte offset of every line. Appends push one integer; reads seek.
 *
 * The offset file is rebuilt lazily and is considered authoritative only when
 * its recorded byte length matches the data file exactly. Anything else
 * (truncation, partial write from a crashed process) triggers a rebuild — a
 * corrupt index must never produce silently wrong data (§45).
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat, truncate, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ensureDir, atomicWrite } from '../core/util.js';

export interface JsonlRecordBase {
  id: string;
}

interface OffsetsFile {
  version: 1;
  /** Byte offset of the start of each line, ascending. */
  offsets: number[];
  /** Total bytes covered by `offsets`. */
  bytes: number;
}

export interface JsonlOptions {
  /** Skip records that fail to parse instead of throwing. Default true. */
  tolerant?: boolean;
  /** Flush the offset sidecar after every N appends. */
  flushEvery?: number;
}

export class JsonlLog<T extends JsonlRecordBase> {
  readonly path: string;
  private readonly offsetPath: string;
  private readonly tolerant: boolean;
  private readonly flushEvery: number;
  private offsets: number[] = [];
  private byteLength = 0;
  private sinceFlush = 0;
  private opened = false;
  /** Append handle. Kept separate from the read handle: a file opened for
   *  append cannot be read from, and mixing them produced EBADF on every
   *  read-after-append. */
  private writeHandle: Awaited<ReturnType<typeof open>> | undefined;
  private readHandle: Awaited<ReturnType<typeof open>> | undefined;
  /** In-flight `open()`; concurrent callers share one rebuild instead of racing. */
  private opening: Promise<void> | undefined;
  /** In-flight handle opens. Without these, N concurrent appends open N fds. */
  private openingWrite: Promise<Awaited<ReturnType<typeof open>>> | undefined;
  private openingRead: Promise<Awaited<ReturnType<typeof open>>> | undefined;
  /**
   * Appends are serialised. Two reasons, both correctness:
   *  - the offset array must be pushed in the same order the bytes land on
   *    disk, otherwise `at(i)` reads the wrong record;
   *  - without serialisation every concurrent append opened its own file
   *    handle, which exhaustion-throttled large memory writes.
   */
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(path: string, options: JsonlOptions = {}) {
    this.path = path;
    this.offsetPath = `${path}.offsets.json`;
    this.tolerant = options.tolerant ?? true;
    this.flushEvery = options.flushEvery ?? 64;
  }

  /** Open the log, verifying or rebuilding the offset index. */
  async open(): Promise<void> {
    if (this.opened) return;
    if (!this.opening) {
      this.opening = this.doOpen().finally(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  private async doOpen(): Promise<void> {
    await ensureDir(this.path.replace(/\/[^/]+$/, ''));
    let size = 0;
    try {
      size = (await stat(this.path)).size;
    } catch {
      size = 0;
    }
    this.byteLength = size;

    const cached = await this.readOffsets();
    if (cached && cached.bytes === size && this.offsetsWellFormed(cached.offsets)) {
      this.offsets = cached.offsets;
    } else if (size > 0) {
      await this.rebuildOffsets();
    } else {
      this.offsets = [];
      await this.persistOffsets();
    }
    this.opened = true;
  }

  /** Run a mutation after every previously queued one has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.appendChain.then(task, task);
    this.appendChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureWriteHandle(): Promise<Awaited<ReturnType<typeof open>>> {
    if (this.writeHandle) return this.writeHandle;
    if (!this.openingWrite) {
      this.openingWrite = open(this.path, 'a')
        .then((handle) => {
          this.writeHandle = handle;
          return handle;
        })
        .finally(() => {
          this.openingWrite = undefined;
        });
    }
    return this.openingWrite;
  }

  private async ensureReadHandle(): Promise<Awaited<ReturnType<typeof open>>> {
    if (this.readHandle) return this.readHandle;
    if (!this.openingRead) {
      this.openingRead = open(this.path, 'r')
        .then((handle) => {
          this.readHandle = handle;
          return handle;
        })
        .finally(() => {
          this.openingRead = undefined;
        });
    }
    return this.openingRead;
  }

  private offsetsWellFormed(offsets: number[]): boolean {
    for (let i = 1; i < offsets.length; i += 1) {
      if ((offsets[i] as number) <= (offsets[i - 1] as number)) return false;
    }
    return offsets.length === 0 || (offsets[0] as number) === 0;
  }

  private async readOffsets(): Promise<OffsetsFile | undefined> {
    try {
      const text = await readFile(this.offsetPath, 'utf8');
      const parsed = JSON.parse(text) as OffsetsFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.offsets)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async persistOffsets(): Promise<void> {
    const payload: OffsetsFile = { version: 1, offsets: this.offsets, bytes: this.byteLength };
    await atomicWrite(this.offsetPath, JSON.stringify(payload));
    this.sinceFlush = 0;
  }

  private async rebuildOffsets(): Promise<void> {
    this.offsets = [];
    let position = 0;
    for await (const line of this.lines()) {
      this.offsets.push(position);
      position += Buffer.byteLength(line, 'utf8') + 1; // + newline
    }
    this.byteLength = position;
    await this.persistOffsets();
  }

  private lines(): AsyncIterable<string> {
    const stream = createReadStream(this.path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    return rl;
  }

  get size(): number {
    return this.offsets.length;
  }

  /** Append a record and index its offset. */
  async append(record: T): Promise<void> {
    await this.open();
    const line = `${JSON.stringify(record)}\n`;
    await this.enqueue(async () => {
      const bytes = Buffer.byteLength(line, 'utf8');
      const handle = await this.ensureWriteHandle();
      await handle.write(line, undefined, 'utf8');
      this.offsets.push(this.byteLength);
      this.byteLength += bytes;
      this.sinceFlush += 1;
      if (this.sinceFlush >= this.flushEvery) await this.persistOffsets();
    });
  }

  async appendMany(records: readonly T[]): Promise<void> {
    await this.open();
    if (records.length === 0) return;
    await this.enqueue(async () => {
      let buffer = '';
      let bytes = 0;
      for (const record of records) {
        const line = `${JSON.stringify(record)}\n`;
        this.offsets.push(this.byteLength + bytes);
        bytes += Buffer.byteLength(line, 'utf8');
        buffer += line;
      }
      const handle = await this.ensureWriteHandle();
      await handle.write(buffer, undefined, 'utf8');
      this.byteLength += bytes;
      this.sinceFlush += records.length;
      if (this.sinceFlush >= this.flushEvery) await this.persistOffsets();
    });
  }

  /** Read a single record by ordinal position. */
  async at(index: number): Promise<T | undefined> {
    await this.open();
    if (index < 0) index += this.offsets.length;
    const start = this.offsets[index];
    if (start === undefined) return undefined;
    const end = this.offsets[index + 1] ?? this.byteLength;
    const length = Math.max(0, end - start);
    if (length === 0) return undefined;
    const handle = await this.ensureReadHandle();
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8').replace(/\n$/, '');
    return this.parse(text);
  }

  /** Read a contiguous window of records by ordinal. */
  async range(start: number, count: number): Promise<T[]> {
    await this.open();
    const from = Math.max(0, start);
    const out: T[] = [];
    for (let i = from; i < Math.min(from + count, this.offsets.length); i += 1) {
      const record = await this.at(i);
      if (record) out.push(record);
    }
    return out;
  }

  /** Most recent `count` records, oldest first. */
  async tail(count: number): Promise<T[]> {
    await this.open();
    const start = Math.max(0, this.offsets.length - count);
    return this.range(start, count);
  }

  /** Stream every record without loading the whole log into memory. */
  async *iterate(): AsyncGenerator<T> {
    await this.open();
    // An empty log has no file on disk yet; reading it would be an ENOENT.
    if (this.offsets.length === 0) return;
    for await (const line of this.lines()) {
      if (line.trim() === '') continue;
      const record = this.parse(line.replace(/\r$/, ''));
      if (record) yield record;
    }
  }

  /** Collect all records. Prefer `iterate()` for large logs. */
  async all(): Promise<T[]> {
    const out: T[] = [];
    for await (const record of this.iterate()) out.push(record);
    return out;
  }

  async last(): Promise<T | undefined> {
    return this.at(-1);
  }

  /** Rewrite the log keeping only records for which `keep` returns true. */
  async retain(keep: (record: T) => boolean): Promise<{ kept: number; removed: number }> {
    const kept: T[] = [];
    let removed = 0;
    for await (const record of this.iterate()) {
      if (keep(record)) kept.push(record);
      else removed += 1;
    }
    await this.rewrite(kept);
    return { kept: kept.length, removed };
  }

  /** Replace the entire log contents. */
  async rewrite(records: readonly T[]): Promise<void> {
    await this.open();
    await this.enqueue(async () => {
      await this.closeHandle();
      const body = records.map((r) => `${JSON.stringify(r)}\n`).join('');
      await writeFile(this.path, body, 'utf8');
      this.offsets = [];
      let position = 0;
      for (const record of records) {
        this.offsets.push(position);
        position += Buffer.byteLength(`${JSON.stringify(record)}\n`, 'utf8');
      }
      this.byteLength = position;
      await this.persistOffsets();
    });
  }

  async truncateTo(bytes: number): Promise<void> {
    await this.open();
    await this.enqueue(async () => {
      await this.closeHandle();
      await truncate(this.path, bytes);
      this.byteLength = bytes;
      await this.rebuildOffsets();
    });
  }

  async flush(): Promise<void> {
    await this.persistOffsets();
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      await this.persistOffsets();
      await this.closeHandle();
    });
  }

  private async closeHandle(): Promise<void> {
    if (this.readHandle) {
      await this.readHandle.close();
      this.readHandle = undefined;
    }
    if (this.writeHandle) {
      await this.writeHandle.close();
      this.writeHandle = undefined;
    }
  }

  private parse(text: string): T | undefined {
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      if (this.tolerant) return undefined;
      throw error;
    }
  }
}
