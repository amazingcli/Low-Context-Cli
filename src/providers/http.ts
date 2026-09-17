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

/**
 * Does this provider response mean "this model cannot call tools"?
 *
 * Gateways reject the whole request instead of ignoring the `tools` field, and
 * they all phrase it differently: OpenRouter answers `404 No endpoints found
 * that support tool use`, others say the model "does not support function
 * calling". Free and small models are the common case, so this is worth
 * recognising rather than surfacing as an opaque HTTP error.
 */
export function isToolCallingUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no endpoints? found that support tool/i.test(message) ||
    /(does not|doesn't|not) support (tool|function) (use|calling)/i.test(message) ||
    /(tool|function) calling is not supported/i.test(message) ||
    /tools? (are|is) not supported/i.test(message) ||
    /support tool use/i.test(message)
  );
}

/** Did the provider reject the request because it does not fit the window? */
export function isContextOverflow(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /maximum context length/i.test(message) ||
    /context[_ ]length[_ ]exceeded/i.test(message) ||
    /(reduce|shorten) the length/i.test(message) ||
    /too many tokens/i.test(message) ||
    /exceeds? the (maximum )?(model'?s )?context/i.test(message)
  );
}

/** Pull the model's real window out of an overflow error, when it states one. */
export function parseContextLimit(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const patterns = [
    /maximum context length is (\d+)/i,
    /context length (?:of|is) (\d+)/i,
    /max(?:imum)? (?:context|tokens?)[^0-9]{0,24}(\d{3,})/i,
    /limit of (\d+) tokens/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return undefined;
}

export function mapHttpError(status: number, detail: string): LowContextError {
  const message = detail ? truncateForError(detail) : `HTTP ${status}`;
  if (isToolCallingUnsupported(detail)) {
    return new LowContextError('PROVIDER_UNSUPPORTED', `The model does not support tool calling (HTTP ${status}: ${message})`, {
      fix: 'Answering without tools. Pick a model that supports tool calling (`/models`) to edit files and run commands.',
    });
  }
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