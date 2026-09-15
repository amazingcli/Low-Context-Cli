import { asNumber, asString, numberProp, objectSchema, stringProp } from './types.js';
const webSearchTool = {
    name: 'web_search',
    description: 'Search the public web for documentation or error messages. Only available when the user has configured a web search provider',
    category: 'web',
    mutating: false,
    parameters: objectSchema({
        query: stringProp('Search query.'),
        limit: numberProp('Maximum results. Defaults to the configured maximum.', { minimum: 1, maximum: 20 }),
    }, ['query']),
    async run(args, ctx) {
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
            if (results.length === 0)
                return { summary: `No web results for "${query}".`, verification_state: 'unknown' };
            const body = results
                .map((result, i) => `${i + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet.replace(/\s+/g, ' ').slice(0, 300)}`)
                .join('\n');
            return {
                summary: `Web results for "${query}" (untrusted external content):\n${body}`,
                verification_state: 'indexed',
                data: { results: results },
            };
        }
        catch (error) {
            return { ok: false, summary: `Web search failed: ${error.message}`, error: error.message };
        }
    },
};
/**
 * A minimal endpoint searcher for self-hosted or proxied search APIs. The
 * endpoint may contain `{query}` and `{limit}` placeholders; the response is
 * expected to be an array or `{ results: [...] }` of `{ title, url, snippet }`.
 */
function defaultEndpointSearcher(endpoint, apiKeyEnv) {
    if (!endpoint)
        return undefined;
    return async (query, limit) => {
        const url = endpoint
            .replace('{query}', encodeURIComponent(query))
            .replace('{limit}', String(limit));
        const headers = { accept: 'application/json' };
        const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
        if (key)
            headers.authorization = `Bearer ${key}`;
        const response = await fetch(url, { headers });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json());
        const raw = Array.isArray(payload) ? payload : payload.results ?? [];
        return raw
            .map((item) => item)
            .map((item) => ({
            title: item.title ?? '(untitled)',
            url: item.url ?? '',
            snippet: item.snippet ?? item.description ?? '',
        }))
            .filter((item) => item.url !== '');
    };
}
export function webTools() {
    return [webSearchTool];
}
//# sourceMappingURL=web.js.map