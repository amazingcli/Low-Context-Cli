/**
 * Provider abstraction (§23).
 *
 * One interface that every backend implements; providers plug in behind it
 * without touching the agent. Capabilities are exposed explicitly so the
 * retry/fallback logic can route around provider quirks, and so context
 * budgeting knows what a model can actually hold.
 */
import type {
  GenerationRequest,
  ModelDescriptor,
  StreamEvent,
} from '../core/types.js';

/** Embedding support is optional; the agent must work without it (§42). */
export interface EmbeddingSupport {
  dimensions: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface ChatProvider {
  readonly name: string;
  readonly kind: string;
  /** Generate a completion. Always iterable: a non-streaming provider wraps one event. */
  generate(request: GenerationRequest): AsyncIterable<StreamEvent>;
  /** Static model catalogue; may be derived from config rather than an API call. */
  listModels(): Promise<ModelDescriptor[]>;
  /** Optional embeddings. Absent means keyword/hybrid retrieval only. */
  embedding?: EmbeddingSupport;
}

export type ProviderFactory = (config: {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  defaultContextLimit?: number;
  defaultMaxOutput?: number;
  timeoutMs?: number;
}) => ChatProvider;

/** Parse a `data: {...}` SSE stream into JSON objects, tolerating other frames. */
export async function* parseSse(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Ignore malformed frames; the connection may be mid-protocol.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Fallback heuristic used when a provider does not report exact usage. */
export const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4': 8192,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'claude': 200_000,
  'gemini': 1_048_576,
  'llama': 8192,
  'qwen': 32_768,
  'mistral': 32_768,
};

export function guessContextLimit(modelId: string, fallback = 128_000): number {
  const lower = modelId.toLowerCase();
  for (const [prefix, limit] of Object.entries(DEFAULT_CONTEXT_LIMITS)) {
    if (lower.startsWith(prefix)) return limit;
  }
  return fallback;
}

/** Normalise a provider's own stop-reason string into our vocabulary. */
export function stopReasonOf(raw: string | undefined): string {
  const r = (raw ?? '').toLowerCase();
  if (r.includes('tool') || r.includes('function')) return 'tool_calls';
  if (r.includes('end') || r.includes('stop')) return 'end_turn';
  if (r.includes('length') || r.includes('max')) return 'length';
  if (r.includes('content') && r.includes('filter')) return 'content_filter';
  return raw ?? 'stop';
}