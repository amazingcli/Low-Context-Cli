/**
 * Shared HTTP plumbing for provider clients.
 *
 * Errors carry LowContextError codes so the agent loop can distinguish a
 * transient timeout (retry) from an auth failure (surface, suggest fix).
 */
import { LowContextError, wrapError } from '../core/errors.js';

export interface HttpOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class ProviderHttp {
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async postJson(path: string, body: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw this.mapFetchError(error, signal?.aborted);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw mapHttpError(response.status, detail);
    }
    return response.json().catch(() => ({}));
  }

  /** Plain authenticated GET, used for advisory endpoints such as `/models`. */
  async getJson(path: string, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.headers,
          ...extraHeaders,
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw this.mapFetchError(error, signal?.aborted);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw mapHttpError(response.status, detail);
    }
    return response.json().catch(() => ({}));
  }

  async streamPost(path: string, body: unknown, extraHeaders?: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.options.baseUrl.replace(/\/$/, '')}${path}`;
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...this.options.headers,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw this.mapFetchError(error, signal?.aborted);
    }
  }

  private mapFetchError(error: unknown, aborted?: boolean): LowContextError {
    if (aborted) {
      return new LowContextError('CANCELLED', 'Request was cancelled');
    }
    return wrapError(
      'PROVIDER_HTTP',
      'Failed to reach the provider API',
      error,
    );
  }
}

export function mapHttpError(status: number, detail: string): LowContextError {
  const message = detail ? truncateForError(detail) : `HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new LowContextError('PROVIDER_AUTH', `The provider rejected the API key (HTTP ${status}: ${message})`, {
      fix: 'Check your API key with `low-context provider list` / set the API key environment variable.',
    });
  }
  if (status === 404) {
    return new LowContextError('PROVIDER_HTTP', `Endpoint not found (HTTP 404: ${message})`, {
      fix: 'Check the provider base URL in `low-context config` / `provider add`.',
    });
  }
  if (status === 429) {
    return new LowContextError('PROVIDER_HTTP', `Rate limited (HTTP 429: ${message})`, {
      fix: 'Wait a moment, or configure a different model with `low-context model use`.',
    });
  }
  if (status >= 500) {
    return new LowContextError('PROVIDER_HTTP', `Provider server error (HTTP ${status}: ${message})`, {
      fix: 'The provider may be down; retry shortly or switch providers.',
    });
  }
  return new LowContextError('PROVIDER_HTTP', `Request failed (HTTP ${status}: ${message})`);
}

function truncateForError(text: string): string {
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}