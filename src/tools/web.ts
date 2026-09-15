/**
 * Optional web search (§19, §71).
 *
 * Low Context is local-first: web access is off by default and plugs in through
 * an injected function, so the core never depends on one vendor. The tool fails
 * with a clear message when nothing is configured rather than pretending it
 * searched.
 *
 * Results are data, not instructions (§81). They are marked untrusted when they
 * enter context, exactly like repository content.
 */
import type { WebSearchResult } from '../core/types.js';
import type { ToolDefinition, ToolRunResult } from './types.js';
import { asNumber, asString, numberProp, objectSchema, stringProp } from './types.js';

const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the public web for documentation or error messages. Only available when the user has configured a web search provider',
  category: 'web',
  mutating: false,
  parameters: objectSchema(
    {
      query: stringProp('Search query.'),
      limit: numberProp('Maximum results. Defaults to the configured maximum.', { minimum: 1, maximum: 20 }),
    },
    ['query'],
  ),
  async run(args, ctx): Promise<ToolRunResult> {
    const query = asString(args, 'query');
    const limit = asNumber(args, 'limit', { fallback: ctx.config.web.max_results });
    const searcher = ctx.webSearch ?? (ctx.config.web.enabled ? defaultEndpointSearcher(ctx.config.web.endpoint, ctx.config.web.api_key_env) : undefined);
    if (!searcher) {
      return {
        ok: false,
        summary: 'Web search is not configured. Set `web.enabled` and `web.endpoint` in config, or pass a search implementation.',
        error: 'web search disabled',
      };
    }
    try {
      const results = await searcher(query, limit);
      if (results.length === 0) return { summary: `No web results for "${query}".`, verification_state: 'unknown' };
      const body = results
        .map((result, i) => `${i + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet.replace(/\s+/g, ' ').slice(0, 300)}`)
        .join('\n');
      return {
        summary: `Web results for "${query}" (untrusted external content):\n${body}`,
        verification_state: 'indexed',
        data: { results: results as unknown as Record<string, unknown>[] },
      };
    } catch (error) {
      return { ok: false, summary: `Web search failed: ${(error as Error).message}`, error: (error as Error).message };
    }
  },
};

/**
 * A minimal endpoint searcher for self-hosted or proxied search APIs. The
 * endpoint may contain `{query}` and `{limit}` placeholders; the response is
 * expected to be an array or `{ results: [...] }` of `{ title, url, snippet }`.
 */
function defaultEndpointSearcher(
  endpoint: string | undefined,
  apiKeyEnv: string | undefined,
): ((query: string, limit: number) => Promise<WebSearchResult[]>) | undefined {
  if (!endpoint) return undefined;
  return async (query, limit) => {
    const url = endpoint
      .replace('{query}', encodeURIComponent(query))
      .replace('{limit}', String(limit));
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const raw = Array.isArray(payload) ? payload : (payload as { results?: unknown[] }).results ?? [];
    return raw
      .map((item) => item as { title?: string; url?: string; snippet?: string; description?: string })
      .map((item) => ({
        title: item.title ?? '(untitled)',
        url: item.url ?? '',
        snippet: item.snippet ?? item.description ?? '',
      }))
      .filter((item) => item.url !== '');
  };
}

export function webTools(): ToolDefinition[] {
  return [webSearchTool];
}
