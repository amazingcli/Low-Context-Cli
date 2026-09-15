/**
 * Local vector store (§42, §43).
 *
 * Layout per shard:
 *
 *   vectors/<shard>.ids.json     ["doc_1", "doc_2", ...]
 *   vectors/<shard>.f32          row-major Float32Array (rows x dimensions)
 *
 * Search is an exact cosine scan over the in-memory shard. For the memory and
 * file-index scale Low Context targets (10^4–10^6 rows) this is comfortably
 * fast in Node and avoids any native/network dependency. If a real vector
 * database is ever needed, `VectorStore` is the interface to swap in (§43).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, atomicWrite } from '../core/util.js';
import type { VectorMatch, VectorRecord, VectorStore } from './interfaces.js';

interface ShardMeta {
  version: 1;
  rows: number;
  dimensions: number;
}

export class LocalVectorStore implements VectorStore {
  private readonly dir: string;
  private ids: string[] = [];
  private vectors = new Float32Array(0);
  private dimensions = 0;
  private setupPromise: Promise<void> | undefined;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'vectors');
  }

  private async setup(): Promise<void> {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = (async () => {
      await ensureDir(this.dir);
      const meta = await this.readMeta();
      if (meta && meta.rows > 0) {
        const raw = await readFile(this.pathFor('f32')).catch(() => undefined);
        if (raw && raw.byteLength === meta.rows * meta.dimensions * 4) {
          this.vectors = new Float32Array(raw.buffer, raw.byteOffset, meta.rows * meta.dimensions);
          this.ids = JSON.parse(await readFile(this.pathFor('ids.json'), 'utf8')) as string[];
          this.dimensions = meta.dimensions;
        }
      }
    })();
    await this.setupPromise;
  }

  private pathFor(ext: string): string {
    return join(this.dir, `vectors.${ext}`);
  }

  private async readMeta(): Promise<ShardMeta | undefined> {
    const text = await readFile(this.pathFor('meta.json'), 'utf8').catch(() => undefined);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as ShardMeta;
    } catch {
      return undefined;
    }
  }

  async upsert(records: readonly VectorRecord[]): Promise<void> {
    await this.setup();
    if (this.dimensions === 0 && records.length > 0) {
      this.dimensions = records[0]?.vector.length ?? 0;
      if (this.dimensions === 0) return;
    }
    for (const record of records) {
      if (record.vector.length !== this.dimensions) continue;
      const slot = this.ids.indexOf(record.id);
      if (slot >= 0) {
        this.vectors.set(record.vector, slot * this.dimensions);
      } else {
        this.ids.push(record.id);
        const newSize = this.ids.length * this.dimensions;
        const grown = new Float32Array(newSize);
        grown.set(this.vectors.subarray(0, this.vectors.length));
        grown.set(record.vector, (this.ids.length - 1) * this.dimensions);
        this.vectors = grown;
      }
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    const meta: ShardMeta = { version: 1, rows: this.ids.length, dimensions: this.dimensions };
    return Promise.all([
      atomicWrite(this.pathFor('meta.json'), `${JSON.stringify(meta)}\n`),
      atomicWrite(this.pathFor('ids.json'), `${JSON.stringify(this.ids)}\n`),
      writeFile(this.pathFor('f32'), this.vectors),
    ]).then(() => undefined);
  }

  async remove(ids: readonly string[]): Promise<void> {
    await this.setup();
    const remove = new Set(ids);
    const keptIds: string[] = [];
    for (let i = 0; i < this.ids.length; i += 1) {
      if (!remove.has(this.ids[i] as string)) keptIds.push(this.ids[i] as string);
    }
    if (keptIds.length === this.ids.length) return;
    const kept = new Float32Array(keptIds.length * this.dimensions);
    for (let i = 0; i < keptIds.length; i += 1) {
      const oldSlot = this.ids.indexOf(keptIds[i] as string);
      kept.set(this.vectors.subarray(oldSlot * this.dimensions, oldSlot * this.dimensions + this.dimensions), i * this.dimensions);
    }
    this.ids = keptIds;
    this.vectors = kept;
    await this.persist();
  }

  async search(vector: Float32Array, limit: number): Promise<VectorMatch[]> {
    await this.setup();
    if (this.ids.length === 0 || vector.length !== this.dimensions) return [];
    const queryNorm = norm(vector);
    const scores: { id: string; score: number }[] = new Array(this.ids.length);
    for (let row = 0; row < this.ids.length; row += 1) {
      const offset = row * this.dimensions;
      let dot = 0;
      for (let d = 0; d < this.dimensions; d += 1) {
        dot += vector[d]! * (this.vectors[offset + d] as number);
      }
      const rowNorm = normAt(this.vectors, offset, this.dimensions);
      scores[row] = { id: this.ids[row] as string, score: rowNorm === 0 ? 0 : dot / (queryNorm * rowNorm) };
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, limit).map(({ id, score }) => ({ id, score }));
  }

  async has(id: string): Promise<boolean> {
    await this.setup();
    return this.ids.includes(id);
  }

  async count(): Promise<number> {
    await this.setup();
    return this.ids.length;
  }

  async clear(): Promise<void> {
    this.ids = [];
    this.vectors = new Float32Array(0);
    this.dimensions = 0;
    await this.persist();
  }

  async flush(): Promise<void> {
    await this.setup();
    await this.persist();
  }

  dimensionsOf(): number {
    return this.dimensions;
  }
}

function norm(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
  return Math.sqrt(sum) || 1;
}

function normAt(vector: Float32Array, offset: number, dims: number): number {
  let sum = 0;
  for (let d = 0; d < dims; d += 1) sum += (vector[offset + d] as number) ** 2;
  return Math.sqrt(sum) || 1;
}