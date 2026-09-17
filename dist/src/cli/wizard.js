/**
 * First-run setup (§75, §24, §26).
 *
 * A missing configuration must never crash the CLI — it must offer to fix it.
 * The wizard writes a real global config, stores credentials with 0600
 * permissions when the user prefers a file over an environment variable, and
 * reports which retrieval mode the choice implies (§42: embeddings are
 * optional, so a user who skips them still gets working retrieval).
 *
 * It is deliberately *not* limited to the big three: any OpenAI-compatible
 * gateway, router, or local server can be configured here (base URL + key +
 * model), and every provider — including the hosted ones — accepts a model ID
 * the user pastes by hand, fetched live from the provider, or picked from the
 * built-in list. Configuration is the source of truth; a live `GET /models`
 * only ever *adds* choices.
 */
import { defaultConfig, ensureGlobalConfig, globalConfigPath, saveGlobalConfig, } from '../core/config.js';
import { setCredential } from '../security/secrets.js';
import { createProvider } from '../providers/registry.js';
import { describeError } from '../core/errors.js';
const PRESETS = [
    {
        key: 'anthropic',
        providerId: 'anthropic',
        kind: 'anthropic',
        label: 'Anthropic — Claude',
        detail: 'api.anthropic.com',
        baseUrl: 'https://api.anthropic.com/v1',
        env: 'ANTHROPIC_API_KEY',
        keyRequired: true,
        askBaseUrl: false,
        canListModels: true,
        models: [
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (balanced, default)', context_limit: 200_000 },
            { id: 'claude-opus-4-1', label: 'Claude Opus 4.1 (deepest reasoning)', context_limit: 200_000 },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast, cheap)', context_limit: 200_000 },
            { id: 'claude-3-7-sonnet-latest', label: 'Claude 3.7 Sonnet', context_limit: 200_000 },
            { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (legacy)', context_limit: 200_000 },
        ],
    },
    {
        key: 'openai',
        providerId: 'openai',
        kind: 'openai',
        label: 'OpenAI — GPT / o-series',
        detail: 'api.openai.com',
        baseUrl: 'https://api.openai.com/v1',
        env: 'OPENAI_API_KEY',
        keyRequired: true,
        askBaseUrl: false,
        canListModels: true,
        models: [
            { id: 'gpt-4o', label: 'GPT-4o (multimodal, default)', context_limit: 128_000 },
            { id: 'gpt-4o-mini', label: 'GPT-4o mini (cheap)', context_limit: 128_000 },
            { id: 'gpt-4.1', label: 'GPT-4.1', context_limit: 1_047_576 },
            { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', context_limit: 1_047_576 },
            { id: 'o3', label: 'o3 (reasoning)', context_limit: 200_000 },
            { id: 'o4-mini', label: 'o4-mini (fast reasoning)', context_limit: 200_000 },
        ],
    },
    {
        key: 'gemini',
        providerId: 'gemini',
        kind: 'gemini',
        label: 'Google — Gemini',
        detail: 'generativelanguage.googleapis.com',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        env: 'GEMINI_API_KEY',
        keyRequired: true,
        askBaseUrl: false,
        canListModels: true,
        models: [
            { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', context_limit: 1_048_576 },
            { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (default)', context_limit: 1_048_576 },
            { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', context_limit: 1_048_576 },
            { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', context_limit: 1_048_576 },
        ],
    },
    {
        key: 'gateway',
        providerId: 'gateway',
        kind: 'custom',
        label: 'OpenAI-compatible gateway / router',
        detail: 'OpenRouter, TokenRouter, DeepSeek, Groq, Together, xAI, Mistral, Fireworks, LiteLLM…',
        baseUrl: '',
        env: 'GATEWAY_API_KEY',
        keyRequired: true,
        askBaseUrl: true,
        canListModels: true,
        models: [
            { id: 'deepseek-chat', label: 'DeepSeek Chat', context_limit: 64_000 },
            { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', context_limit: 64_000 },
            { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder', context_limit: 262_144 },
            { id: 'openai/gpt-4o-mini', label: 'OpenRouter: GPT-4o mini', context_limit: 128_000 },
            { id: 'anthropic/claude-sonnet-4.5', label: 'OpenRouter: Claude Sonnet 4.5', context_limit: 200_000 },
            { id: 'google/gemini-2.5-flash', label: 'OpenRouter: Gemini 2.5 Flash', context_limit: 1_048_576 },
            { id: 'grok-4', label: 'xAI Grok 4', context_limit: 256_000 },
            { id: 'llama-3.3-70b-versatile', label: 'Groq: Llama 3.3 70B', context_limit: 128_000 },
            { id: 'mistral-large-latest', label: 'Mistral Large', context_limit: 128_000 },
        ],
    },
    {
        key: 'local',
        providerId: 'local',
        kind: 'local',
        label: 'Local model server',
        detail: 'Ollama, LM Studio, vLLM, llama.cpp — no cloud, no key needed',
        baseUrl: 'http://127.0.0.1:11434/v1',
        env: 'LOCAL_API_KEY',
        keyRequired: false,
        askBaseUrl: true,
        canListModels: true,
        models: [
            { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', context_limit: 32_768 },
            { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', context_limit: 32_768 },
            { id: 'llama3.2:3b', label: 'Llama 3.2 3B', context_limit: 131_072 },
            { id: 'deepseek-coder-v2:16b', label: 'DeepSeek Coder V2 16B', context_limit: 131_072 },
            { id: 'mistral:7b', label: 'Mistral 7B', context_limit: 32_768 },
        ],
    },
    {
        key: 'mock',
        providerId: 'mock',
        kind: 'mock',
        label: 'Offline mock provider',
        detail: 'no network, no key — for exploring the CLI',
        env: '',
        keyRequired: false,
        askBaseUrl: false,
        canListModels: false,
        models: [{ id: 'mock-1', label: 'Mock 1 (offline test model)', context_limit: 32_768 }],
    },
];
export async function runInitWizard(ctx, options = {}) {
    const { ui } = ctx;
    ui.out('');
    ui.out(ui.bold('Low Context setup'));
    ui.out(ui.dim(`Writes a global config to ${globalConfigPath()}`));
    ui.out('');
    if (options.nonInteractive || !process.stdin.isTTY) {
        const created = await ensureGlobalConfig();
        const config = defaultConfig();
        const mock = config.providers.find((p) => p.id === 'mock');
        if (mock) {
            config.active_provider = mock.id;
            config.active_model = mock.models[0]?.id;
            await saveGlobalConfig(config);
        }
        ui[created ? 'success' : 'info'](created ? 'Wrote a default config.' : 'A config already existed.');
        ui.out('Selected the offline mock provider so the CLI is immediately usable.');
        ui.out('Run `lc init` interactively, or `lc providers add` + `lc models use`, to attach a real model.');
        return 0;
    }
    const preset = await pickProvider(ui);
    ui.out('');
    const baseUrl = await pickBaseUrl(ui, preset);
    const apiKey = await collectKey(ui, preset);
    const model = await pickModel(ui, preset, { baseUrl, apiKey });
    ui.out('');
    ui.out('How should commands be approved?');
    ui.out('  1) ask      — confirm anything that changes files or runs a command (recommended)');
    ui.out('  2) safe     — read-only; refuse mutations');
    ui.out('  3) trusted  — allow everything except known-catastrophic commands');
    ui.out(ui.dim('  (you can switch at any time in a session with /nopermission and /permissions)'));
    const modeChoice = (await ui.ask('Enter a number', '1')).trim();
    const mode = modeChoice === '2' ? 'safe' : modeChoice === '3' ? 'trusted' : 'ask';
    const provider = {
        id: preset.providerId,
        kind: preset.kind,
        label: preset.label,
        enabled: true,
        ...(baseUrl === undefined || baseUrl === '' ? {} : { base_url: baseUrl }),
        ...(preset.env === '' ? {} : { api_key_env: preset.env }),
        ...(preset.keyRequired || apiKey ? { api_key_ref: `providers.${preset.providerId}.api_key` } : {}),
        models: mergeModels(preset, model),
    };
    const base = await loadBaseConfig();
    const config = {
        ...base,
        providers: [...base.providers.filter((p) => p.id !== provider.id), provider],
        active_provider: provider.id,
        active_model: model.id,
        permissions: { ...base.permissions, mode: mode },
    };
    await saveGlobalConfig(config);
    const envValue = preset.env === '' ? undefined : process.env[preset.env];
    if (apiKey && apiKey !== envValue) {
        await setCredential(`providers.${preset.providerId}.api_key`, apiKey);
        ui.success('Credential stored in credentials.json (mode 0600) — not in config.json.');
    }
    ui.out('');
    ui.success(`Configured ${provider.id}/${model.id} with permission mode "${mode}".`);
    const testNow = (await ui.ask('Test the connection to this provider now? (Y/n)', 'y')).toLowerCase();
    if (testNow !== 'n' && testNow !== 'no')
        await testConnection(ui, provider, apiKey);
    const indexNow = (await ui.ask('Build the project index now? (y/N)', 'n')).toLowerCase().startsWith('y');
    if (indexNow) {
        const workspace = await ctx.openWorkspace({ refresh: false });
        ui.info('Indexing the project...');
        const result = await workspace.ensureIndex({ force: false, onProgress: ({ done, total }) => ui.updateSpinner(`indexing ${done}/${total}`) });
        ui.stopSpinner();
        if (result)
            ui.success(`Indexed ${result.added + result.changed + result.unchanged} file(s) in ${result.duration_ms} ms.`);
        else
            ui.warn('Indexing is disabled in config.');
    }
    ui.out('');
    ui.out(ui.dim('Next: `lc doctor` to verify everything, then `lc` to start talking.'));
    ui.out(ui.dim('Change model later with /models inside a session, or `lc models use <id>`.'));
    return 0;
}
/* --------------------------------- steps ---------------------------------- */
async function pickProvider(ui) {
    ui.out(ui.bold('Which provider would you like to use?'));
    PRESETS.forEach((preset, index) => {
        ui.out(`  ${index + 1}) ${preset.label}`);
        ui.out(ui.dim(`      ${preset.detail}`));
    });
    const choice = Number(await ui.ask('Enter a number', '1'));
    const index = Number.isFinite(choice) ? Math.max(0, Math.min(PRESETS.length - 1, choice - 1)) : 0;
    return PRESETS[index];
}
async function pickBaseUrl(ui, preset) {
    if (!preset.askBaseUrl)
        return preset.baseUrl;
    ui.out('');
    ui.out(ui.dim('Enter the base URL of the API. It usually ends in /v1.'));
    const answer = (await ui.ask('Base URL', preset.baseUrl ?? 'http://127.0.0.1:11434/v1')).trim();
    const value = answer === '' ? preset.baseUrl : answer;
    if (value === undefined || value === '')
        return undefined;
    return value.replace(/\/+$/, '');
}
async function collectKey(ui, preset) {
    if (preset.env === '')
        return undefined;
    const envKey = process.env[preset.env];
    ui.out('');
    if (envKey !== undefined && envKey !== '') {
        ui.info(`Found ${preset.env} in your environment.`);
        const useIt = (await ui.ask(`Use it? (Y) or paste a different key (p)`, 'y')).toLowerCase();
        if (!useIt.startsWith('p'))
            return undefined; // env var wins; nothing to store
    }
    else if (preset.keyRequired) {
        ui.out(`No ${preset.env} found in your environment.`);
    }
    else {
        ui.out(ui.dim(`${preset.env} is not set. Most local servers need no key — press Enter to skip.`));
    }
    ui.out('  a) Set the environment variable later (recommended for shells/CI)');
    ui.out('  b) Store the key now in ~/.low-context/config/credentials.json (mode 0600)');
    const answer = (await ui.ask('Choose a/b', preset.keyRequired ? 'a' : 'a')).toLowerCase();
    if (!answer.startsWith('b'))
        return undefined;
    const key = await ui.askSecret(`Paste the ${preset.label} API key (input hidden)`);
    if (key === '')
        ui.warn('No key entered; continuing without one.');
    return key === '' ? undefined : key;
}
async function pickModel(ui, preset, settings) {
    for (;;) {
        ui.out('');
        ui.out(ui.bold('Which model?'));
        preset.models.forEach((model, index) => ui.out(`  ${index + 1}) ${model.label}  ${ui.dim(`(${model.id})`)}`));
        const manualIndex = preset.models.length + 1;
        const fetchIndex = preset.models.length + 2;
        ui.out(`  ${manualIndex}) ${ui.bold('Paste a model ID')} ${ui.dim('— any model name your provider accepts')}`);
        if (preset.canListModels)
            ui.out(`  ${fetchIndex}) ${ui.bold('Fetch the model list from this provider')} ${ui.dim('— uses /models')}`);
        const answer = (await ui.ask('Enter a number', '1')).trim();
        const value = Number(answer);
        if (preset.canListModels && value === fetchIndex) {
            const fetched = await fetchModels(ui, preset, settings);
            if (fetched.length > 0) {
                const picked = await pickFromList(ui, fetched);
                if (picked)
                    return picked;
            }
            continue;
        }
        if (value === manualIndex) {
            const id = (await ui.ask('Model ID (exactly as the provider expects it)')).trim();
            if (id === '') {
                ui.warn('Empty model ID; keeping the list.');
                continue;
            }
            const limitRaw = (await ui.ask('Context window in tokens (Enter to auto-detect)', '')).trim();
            const limit = Number(limitRaw);
            ui.success(`Using model ID "${id}".`);
            return Number.isFinite(limit) && limit > 0 ? { id, label: id, context_limit: Math.floor(limit) } : { id, label: id };
        }
        if (Number.isFinite(value) && value >= 1 && value <= preset.models.length) {
            return preset.models[value - 1];
        }
        ui.warn('Pick one of the listed numbers.');
    }
}
async function pickFromList(ui, models) {
    const shown = models.slice(0, 60);
    ui.out('');
    ui.out(ui.bold(`${models.length} model(s) available`));
    shown.forEach((model, index) => ui.out(`  ${index + 1}) ${model.id}${model.label === model.id ? '' : ui.dim(`  ${model.label}`)}`));
    if (models.length > shown.length)
        ui.out(ui.dim(`  …and ${models.length - shown.length} more (paste one with the manual option)`));
    ui.out(`  0) back`);
    const answer = (await ui.ask('Enter a number', '0')).trim();
    const value = Number(answer);
    if (!Number.isFinite(value) || value < 1 || value > shown.length)
        return undefined;
    return shown[value - 1];
}
async function fetchModels(ui, preset, settings) {
    ui.info('Asking the provider for its model list...');
    const envKey = preset.env === '' ? undefined : process.env[preset.env];
    const key = settings.apiKey ?? envKey;
    try {
        const provider = await createProvider({
            id: preset.providerId,
            kind: preset.kind,
            label: preset.label,
            enabled: true,
            ...(settings.baseUrl === undefined ? {} : { base_url: settings.baseUrl }),
            models: [],
        }, key === undefined ? {} : { apiKeyOverride: key });
        const models = await withTimeout(provider.listModels(), 15_000);
        return models.map((model) => ({
            id: model.id,
            label: model.label,
            context_limit: model.context_limit,
            capabilities: { tool_calling: model.capabilities.tool_calling },
        }));
    }
    catch (error) {
        ui.warn(`Could not fetch the model list: ${describeError(error)}`);
        ui.out(ui.dim('  You can still paste a model ID manually — that always works.'));
        return [];
    }
}
async function testConnection(ui, provider, apiKey) {
    ui.info('Testing the provider...');
    const envKey = provider.api_key_env === undefined ? undefined : process.env[provider.api_key_env];
    try {
        const client = await createProvider(provider, {
            apiKeyOverride: apiKey ?? envKey,
        });
        const models = await withTimeout(client.listModels(), 15_000);
        if (models.length > 0)
            ui.success(`Connection OK — ${models.length} model(s) reachable.`);
        else
            ui.warn('The provider responded but listed no models. This is normal for some gateways; if requests fail, check the model ID with /models.');
    }
    catch (error) {
        ui.warn(`Could not verify the connection: ${describeError(error)}`);
        ui.out(ui.dim('  The configuration was saved. Fix the key/URL later with `lc providers add` or /providers.'));
    }
}
function mergeModels(preset, chosen) {
    const seen = new Set();
    const out = [];
    const push = (model) => {
        if (seen.has(model.id))
            return;
        seen.add(model.id);
        out.push({
            id: model.id,
            ...(model.label === undefined ? {} : { label: model.label }),
            ...(model.context_limit === undefined ? {} : { context_limit: model.context_limit }),
            ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
        });
    };
    push(chosen);
    for (const model of preset.models)
        push(model);
    return out;
}
/**
 * Start from whatever the user already has, so re-running setup keeps other
 * providers, their credentials references and their model lists instead of
 * resetting the file to defaults.
 */
async function loadBaseConfig() {
    await ensureGlobalConfig();
    const { loadConfig } = await import('../core/config.js');
    const loaded = await loadConfig({ skipProject: true, skipEnv: true }).catch(() => undefined);
    return loaded?.config ?? defaultConfig();
}
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref?.()),
    ]);
}
/** Called when a command needs a model and none is configured yet (§75). */
export async function offerSetup(ui, ctx) {
    ui.warn('No model is configured yet.');
    ui.out('');
    ui.out('  1) Run setup now');
    ui.out('  2) Use the offline mock provider');
    ui.out('  3) Show configuration');
    ui.out('  4) Exit');
    const answer = (await ui.ask('Choose 1-4', '1')).trim();
    if (answer === '2') {
        const base = defaultConfig();
        const mock = base.providers.find((p) => p.id === 'mock');
        if (mock) {
            base.active_provider = mock.id;
            base.active_model = mock.models[0]?.id;
            await saveGlobalConfig(base);
            ui.success('Using the offline mock provider.');
            return true;
        }
        return false;
    }
    if (answer === '3') {
        ui.result(globalConfigPath());
        return false;
    }
    if (answer === '4')
        return false;
    const code = await runInitWizard(ctx);
    return code === 0;
}
//# sourceMappingURL=wizard.js.map