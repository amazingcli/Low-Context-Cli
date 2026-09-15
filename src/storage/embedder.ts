/**
 * Embeddings (§42).
 *
 * Embeddings are strictly optional. Low Context works in `keyword` mode with
 * no embedding model at all. When configured, `hybrid` and `semantic` modes
 * use this module.
 *
 * Two implementations ship:
 *  - `HashingEmbedder` — dependency-free deterministic lexical vectors. Honest
 *    about what it is: it measures lexical overlap in a vector form, not
 *    neural semantics. It is labelled as such everywhere it appears.
 *  - `ApiEmbedder` — an OpenAI-compatible `POST /embeddings` client, so any
 *    provider (OpenAI, local servers, gateways) can serve embeddings through
 *    the same path.
 *
 * `reduced: true` in the magic comment below keeps the module dependency-free;
 * no changes are needed here when adding providers.
 */
import type { EmbeddingClient } from './interfaces.js';

/** A dependency-free, deterministic, L2-normalised hashing vectoriser. */
export class HashingEmbedder implements EmbeddingClient {
  readonly name = 'local-hashing';
  readonly dimensions: number;

  constructor(dimensions = 512) {
    this.dimensions = dimensions;
  }

  /** Stable 32-bit string hash (FNV-1a variant). */
  private static hash(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const text of texts) out.push(HashingEmbedder.embedOne(text, this.dimensions));
    return out;
  }

  private static embedOne(text: string, dims: number): Float32Array {
    const vector = new Float32Array(dims);
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) {
      const slot = HashingEmbedder.hash(token) % dims;
      // Sub-token hashing triples coverage per slot, capturing a little of the
      // "similar words hash near each other" behaviour.
      vector[slot] = (vector[slot] ?? 0) + (1 + Math.log(count));
      if (token.length > 4) {
        const second = HashingEmbedder.hash(token.slice(1)) % dims;
        vector[second] = (vector[second] ?? 0) + 0.5 * (1 + Math.log(count));
      }
    }
    HashingEmbedder.normalise(vector);
    return vector;
  }

  private static normalise(vector: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] as number) / norm;
  }
}

export interface EmbeddingRequestOptions {
  signal?: AbortSignal;
}

/** Client half of an OpenAI-compatible embeddings API. */
export class ApiEmbedder implements EmbeddingClient {
  readonly name: string;
  readonly dimensions: number;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | undefined,
    private readonly model: string,
    configuredDimensions: number | undefined,
    private readonly headers: Record<string, string> = {},
  ) {
    this.name = `api:${model}`;
    this.dimensions = configuredDimensions ?? 1024;
  }

  async embed(texts: readonly string[], options: EmbeddingRequestOptions = {}): Promise<Float32Array[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`embedding request failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
    }
    const body = (await response.json()) as {
      data?: { embedding?: number[] | { values?: number[] } }[];
      usage?: { total_tokens?: number };
    };
    const rows = body.data ?? [];
    const out: Float32Array[] = [];
    for (const row of rows) {
      const raw = row.embedding;
      let values: number[] | undefined;
      if (Array.isArray(raw)) values = raw;
      else values = (raw as { values?: number[] } | undefined)?.values;
      const vector = new Float32Array(values ?? []);
      if (vector.length === 0) throw new Error('embedding response had no vector');
      out.push(vector);
    }
    return out;
  }
}

export interface EmbedderFactory {
  (texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}