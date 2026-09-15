import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import { guessContextLimit } from './types.js';
import { resolveSecret } from '../security/secrets.js';
export async function createProvider(config, options = {}) {
    const apiKey = options.apiKeyOverride ??
        (await resolveSecret(config.api_key_ref, config.api_key_env ? [config.api_key_env] : [])) ??
        undefined;
    const headers = expandHeaders(config.headers ?? {});
    switch (config.kind) {
        case 'openai':
        case 'custom':
        case 'local':
            return new OpenAIProvider(config.label || config.id, {
                baseUrl: config.base_url ?? 'https://api.openai.com/v1',
                apiKey: config.kind === 'local' ? apiKey ?? 'none' : apiKey,
                headers,
                timeoutMs: options.timeoutMs ?? config.timeout_ms,
            });
        case 'anthropic':
            return new AnthropicProvider(config.label || config.id, {
                baseUrl: config.base_url ?? 'https://api.anthropic.com/v1',
                apiKey,
                headers,
                timeoutMs: options.timeoutMs ?? config.timeout_ms,
            });
        case 'gemini':
            return new GeminiProvider(config.label || config.id, {
                baseUrl: config.base_url ?? 'https://generativelanguage.googleapis.com/v1beta',
                apiKey,
                headers,
                timeoutMs: options.timeoutMs ?? config.timeout_ms,
            });
        case 'mock':
            return new MockProvider(config.id);
        default:
            return new OpenAIProvider(config.id, {
                baseUrl: config.base_url ?? 'https://api.openai.com/v1',
                apiKey,
                headers,
                timeoutMs: config.timeout_ms,
            });
    }
}
export async function createEmbeddingClient(config) {
    const settings = config.embedding;
    if (!settings.enabled)
        return undefined;
    if (settings.mode === 'provider' && settings.provider) {
        const providerConfig = config.providers.find((p) => p.id === settings.provider);
        if (providerConfig) {
            const apiKey = await resolveSecret(providerConfig.api_key_ref, providerConfig.api_key_env ? [providerConfig.api_key_env] : []);
            const endpoint = `${providerConfig.base_url ?? 'https://api.openai.com/v1'}/embeddings`;
            const { ApiEmbedder } = await import('../storage/embedder.js');
            return {
                dimensions: settings.dimensions ?? 1024,
                embed: async (texts, signal) => new ApiEmbedder(endpoint, apiKey, settings.model ?? 'text-embedding-3-small', settings.dimensions, expandHeaders(providerConfig.headers ?? {}))
                    .embed(texts, { signal }),
            };
        }
    }
    // Local hashing vectorizer — honest about being lexical, not neural.
    const { HashingEmbedder } = await import('../storage/embedder.js');
    const embedder = new HashingEmbedder(settings.dimensions ?? 512);
    return {
        dimensions: embedder.dimensions,
        embed: (texts, _signal) => embedder.embed(texts),
    };
}
export function listAllModels(config) {
    const out = [];
    for (const provider of config.providers) {
        if (!provider.enabled)
            continue;
        for (const model of provider.models) {
            out.push(modelDescriptor(provider, model));
        }
    }
    return out;
}
export function modelDescriptor(provider, model) {
    // Provider defaults, then anything the model entry overrides.
    const capabilities = {
        streaming: provider.capabilities?.streaming ?? true,
        tool_calling: provider.capabilities?.tool_calling ?? true,
        embeddings: provider.capabilities?.embeddings ?? false,
        vision: provider.capabilities?.vision ?? true,
        json_mode: provider.capabilities?.json_mode ?? true,
        reasoning: provider.capabilities?.reasoning ?? (provider.kind === 'anthropic' || provider.kind === 'gemini'),
        exact_usage: provider.capabilities?.exact_usage ?? true,
        ...model.capabilities,
    };
    return {
        id: model.id,
        provider: provider.id,
        label: model.label ?? model.id,
        context_limit: model.context_limit ?? guessContextLimit(model.id),
        max_output: model.max_output ?? 8_192,
        capabilities,
        cost: model.input_per_mtok !== undefined || model.output_per_mtok !== undefined
            ? {
                input_per_mtok: model.input_per_mtok,
                output_per_mtok: model.output_per_mtok,
                currency: 'USD',
            }
            : undefined,
    };
}
/** Expand `${ENV_VAR}` references inside header values. */
export function expandHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        out[key] = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
    }
    return out;
}
/** Build a primary+optional-fallback pair from config (§76). */
export async function buildFallbackPlan(config, apiKeyOverride) {
    const active = config.providers.find((p) => p.id === config.active_provider);
    const fallback = config.fallback_provider
        ? config.providers.find((p) => p.id === config.fallback_provider)
        : undefined;
    if (!active)
        throw new Error('no active provider configured');
    const primary = await createProvider(active, { apiKeyOverride });
    let fallbackProvider;
    if (fallback && setupDistinct(active, fallback)) {
        fallbackProvider = await createProvider(fallback, { apiKeyOverride });
    }
    return {
        primary,
        primaryModel: config.active_model ?? active.models[0]?.id ?? '',
        fallback: fallbackProvider,
        fallbackModel: fallback ? config.fallback_model ?? fallback.models[0]?.id ?? '' : undefined,
    };
}
function setupDistinct(a, b) {
    return a.id !== b.id || a.base_url !== b.base_url;
}
//# sourceMappingURL=registry.js.map