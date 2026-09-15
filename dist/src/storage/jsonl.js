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
export class JsonlLog {
    path;
    offsetPath;
    tolerant;
    flushEvery;
    offsets = [];
    byteLength = 0;
    sinceFlush = 0;
    opened = false;
    /** Append handle. Kept separate from the read handle: a file opened for
     *  append cannot be read from, and mixing them produced EBADF on every
     *  read-after-append. */
    writeHandle;
    readHandle;
    /** In-flight `open()`; concurrent callers share one rebuild instead of racing. */
    opening;
    /** In-flight handle opens. Without these, N concurrent appends open N fds. */
    openingWrite;
    openingRead;
    /**
     * Appends are serialised. Two reasons, both correctness:
     *  - the offset array must be pushed in the same order the bytes land on
     *    disk, otherwise `at(i)` reads the wrong record;
     *  - without serialisation every concurrent append opened its own file
     *    handle, which exhaustion-throttled large memory writes.
     */
    appendChain = Promise.resolve();
    constructor(path, options = {}) {
        this.path = path;
        this.offsetPath = `${path}.offsets.json`;
        this.tolerant = options.tolerant ?? true;
        this.flushEvery = options.flushEvery ?? 64;
    }
    /** Open the log, verifying or rebuilding the offset index. */
    async open() {
        if (this.opened)
            return;
        if (!this.opening) {
            this.opening = this.doOpen().finally(() => {
                this.opening = undefined;
            });
        }
        return this.opening;
    }
    async doOpen() {
        await ensureDir(this.path.replace(/\/[^/]+$/, ''));
        let size = 0;
        try {
            size = (await stat(this.path)).size;
        }
        catch {
            size = 0;
        }
        this.byteLength = size;
        const cached = await this.readOffsets();
        if (cached && cached.bytes === size && this.offsetsWellFormed(cached.offsets)) {
            this.offsets = cached.offsets;
        }
        else if (size > 0) {
            await this.rebuildOffsets();
        }
        else {
            this.offsets = [];
            await this.persistOffsets();
        }
        this.opened = true;
    }
    /** Run a mutation after every previously queued one has settled. */
    enqueue(task) {
        const result = this.appendChain.then(task, task);
        this.appendChain = result.then(() => undefined, () => undefined);
        return result;
    }
    async ensureWriteHandle() {
        if (this.writeHandle)
            return this.writeHandle;
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
    async ensureReadHandle() {
        if (this.readHandle)
            return this.readHandle;
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
    offsetsWellFormed(offsets) {
        for (let i = 1; i < offsets.length; i += 1) {
            if (offsets[i] <= offsets[i - 1])
                return false;
        }
        return offsets.length === 0 || offsets[0] === 0;
    }
    async readOffsets() {
        try {
            const text = await readFile(this.offsetPath, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed.version !== 1 || !Array.isArray(parsed.offsets))
                return undefined;
            return parsed;
        }
        catch {
            return undefined;
        }
    }
    async persistOffsets() {
        const payload = { version: 1, offsets: this.offsets, bytes: this.byteLength };
        await atomicWrite(this.offsetPath, JSON.stringify(payload));
        this.sinceFlush = 0;
    }
    async rebuildOffsets() {
        this.offsets = [];
        let position = 0;
        for await (const line of this.lines()) {
            this.offsets.push(position);
            position += Buffer.byteLength(line, 'utf8') + 1; // + newline
        }
        this.byteLength = position;
        await this.persistOffsets();
    }
    lines() {
        const stream = createReadStream(this.path, { encoding: 'utf8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        return rl;
    }
    get size() {
        return this.offsets.length;
    }
    /** Append a record and index its offset. */
    async append(record) {
        await this.open();
        const line = `${JSON.stringify(record)}\n`;
        await this.enqueue(async () => {
            const bytes = Buffer.byteLength(line, 'utf8');
            const handle = await this.ensureWriteHandle();
            await handle.write(line, undefined, 'utf8');
            this.offsets.push(this.byteLength);
            this.byteLength += bytes;
            this.sinceFlush += 1;
            if (this.sinceFlush >= this.flushEvery)
                await this.persistOffsets();
        });
    }
    async appendMany(records) {
        await this.open();
        if (records.length === 0)
            return;
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
            if (this.sinceFlush >= this.flushEvery)
                await this.persistOffsets();
        });
    }
    /** Read a single record by ordinal position. */
    async at(index) {
        await this.open();
        if (index < 0)
            index += this.offsets.length;
        const start = this.offsets[index];
        if (start === undefined)
            return undefined;
        const end = this.offsets[index + 1] ?? this.byteLength;
        const length = Math.max(0, end - start);
        if (length === 0)
            return undefined;
        const handle = await this.ensureReadHandle();
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        const text = buffer.toString('utf8').replace(/\n$/, '');
        return this.parse(text);
    }
    /** Read a contiguous window of records by ordinal. */
    async range(start, count) {
        await this.open();
        const from = Math.max(0, start);
        const out = [];
        for (let i = from; i < Math.min(from + count, this.offsets.length); i += 1) {
            const record = await this.at(i);
            if (record)
                out.push(record);
        }
        return out;
    }
    /** Most recent `count` records, oldest first. */
    async tail(count) {
        await this.open();
        const start = Math.max(0, this.offsets.length - count);
        return this.range(start, count);
    }
    /** Stream every record without loading the whole log into memory. */
    async *iterate() {
        await this.open();
        // An empty log has no file on disk yet; reading it would be an ENOENT.
        if (this.offsets.length === 0)
            return;
        for await (const line of this.lines()) {
            if (line.trim() === '')
                continue;
            const record = this.parse(line.replace(/\r$/, ''));
            if (record)
                yield record;
        }
    }
    /** Collect all records. Prefer `iterate()` for large logs. */
    async all() {
        const out = [];
        for await (const record of this.iterate())
            out.push(record);
        return out;
    }
    async last() {
        return this.at(-1);
    }
    /** Rewrite the log keeping only records for which `keep` returns true. */
    async retain(keep) {
        const kept = [];
        let removed = 0;
        for await (const record of this.iterate()) {
            if (keep(record))
                kept.push(record);
            else
                removed += 1;
        }
        await this.rewrite(kept);
        return { kept: kept.length, removed };
    }
    /** Replace the entire log contents. */
    async rewrite(records) {
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
    async truncateTo(bytes) {
        await this.open();
        await this.enqueue(async () => {
            await this.closeHandle();
            await truncate(this.path, bytes);
            this.byteLength = bytes;
            await this.rebuildOffsets();
        });
    }
    async flush() {
        await this.persistOffsets();
    }
    async close() {
        await this.enqueue(async () => {
            await this.persistOffsets();
            await this.closeHandle();
        });
    }
    async closeHandle() {
        if (this.readHandle) {
            await this.readHandle.close();
            this.readHandle = undefined;
        }
        if (this.writeHandle) {
            await this.writeHandle.close();
            this.writeHandle = undefined;
        }
    }
    parse(text) {
        try {
            return JSON.parse(text);
        }
        catch (error) {
            if (this.tolerant)
                return undefined;
            throw error;
        }
    }
}
//# sourceMappingURL=jsonl.js.map