/**
 * First-run setup (§75).
 *
 * A missing configuration must never crash the CLI — it must offer to fix it.
 * The wizard writes a real global config, stores credentials with 0600
 * permissions when the user prefers a file over an environment variable, and
 * says plainly which retrieval mode the choice implies (§42: embeddings are
 * optional, so a user who skips them still gets working retrieval).
 */
import { ensureGlobalConfig, saveGlobalConfig } from '../core/config.js';
import { globalConfigPath } from '../core/config.js';
import { setCredential } from '../security/secrets.js';
import { defaultConfig } from '../core/config.js';
const PRESETS = [
    {
        kind: 'anthropic',
        label: 'Anthropic (Claude)',
        baseUrl: 'https://api.anthropic.com/v1',
        env: 'ANTHROPIC_API_KEY',
        needsKey: true,
        models: [
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', context_limit: 200_000 },
            { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', context_limit: 200_000 },
        ],
    },
    {
        kind: 'openai',
        label: 'OpenAI (GPT)',
        baseUrl: 'https://api.openai.com/v1',
        env: 'OPENAI_API_KEY',
        needsKey: true,
        models: [
            { id: 'gpt-4o', label: 'GPT-4o', context_limit: 128_000 },
            { id: 'gpt-4o-mini', label: 'GPT-4o mini', context_limit: 128_000 },
        ],
    },
    {
        kind: 'gemini',
        label: 'Google Gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        env: 'GEMINI_API_KEY',
        needsKey: true,
        models: [
            { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', context_limit: 1_048_576 },
            { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', context_limit: 1_048_576 },
        ],
    },
    {
        kind: 'local',
        label: 'Local model server (Ollama, LM Studio, vLLM)',
        baseUrl: 'http://127.0.0.1:11434/v1',
        env: 'OLLAMA_API_KEY',
        needsKey: false,
        models: [{ id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B (local)', context_limit: 32_768 }],
    },
    {
        kind: 'mock',
        label: 'Offline mock provider (no network, for trying the CLI)',
        env: '',
        needsKey: false,
        models: [{ id: 'mock-1', label: 'Mock 1 (offline test model)', context_limit: 32_768 }],
    },
];
export async function runInitWizard(ctx, options = {}) {
    const { ui } = ctx;
    ui.out('');
    ui.out(ui.bold('Low Context setup'));
    ui.out(ui.dim('This writes a global config to ' + globalConfigPath()));
    ui.out('');
    if (options.nonInteractive || !process.stdin.isTTY) {
        // Leave the defaults in place so the CLI still works offline.
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
    ui.out('Which provider would you like to use?');
    PRESETS.forEach((preset, index) => {
        ui.out(`  ${index + 1}) ${preset.label}`);
    });
    const choice = Number(await ui.ask('Enter a number', '1'));
    const preset = PRESETS[Number.isFinite(choice) ? Math.max(0, Math.min(PRESETS.length - 1, choice - 1)) : 0];
    const envKey = preset.env === '' ? undefined : process.env[preset.env];
    let apiKey = envKey;
    if (preset.needsKey && envKey === undefined) {
        ui.out('');
        ui.out(`No ${preset.env} found in your environment.`);
        ui.out('  a) Set the environment variable later (recommended for shells/CI)');
        ui.out('  b) Store the key in ~/.low-context/config/credentials.json (mode 0600)');
        const answer = (await ui.ask('Choose a/b', 'a')).toLowerCase();
        if (answer.startsWith('b')) {
            apiKey = await ui.askSecret(`Paste the ${preset.label} API key (input hidden)`);
        }
    }
    const baseUrl = preset.kind === 'local' ? await ui.ask('Base URL for the local server', preset.baseUrl ?? '') : preset.baseUrl;
    ui.out('');
    ui.out('Default model:');
    preset.models.forEach((model, index) => ui.out(`  ${index + 1}) ${model.label}  (${model.id})`));
    const modelChoice = Number(await ui.ask('Enter a number', '1'));
    const model = preset.models[Number.isFinite(modelChoice) ? Math.max(0, Math.min(preset.models.length - 1, modelChoice - 1)) : 0];
    ui.out('');
    ui.out('How should commands be approved?');
    ui.out('  1) ask      — confirm anything that changes files or runs a command (recommended)');
    ui.out('  2) safe     — read-only; refuse mutations');
    ui.out('  3) trusted  — allow everything except known-catastrophic commands');
    const modeChoice = (await ui.ask('Enter a number', '1')).trim();
    const mode = modeChoice === '2' ? 'safe' : modeChoice === '3' ? 'trusted' : 'ask';
    const indexNow = (await ui.ask('Build the project index now? (y/N)', 'n')).toLowerCase().startsWith('y');
    const provider = {
        id: preset.kind === 'local' ? 'local' : preset.kind,
        kind: preset.kind,
        label: preset.label,
        enabled: true,
        ...(baseUrl === undefined || baseUrl === '' ? {} : { base_url: baseUrl }),
        ...(preset.env === '' ? {} : { api_key_env: preset.env }),
        ...(preset.needsKey ? { api_key_ref: `providers.${preset.kind}.api_key` } : {}),
        models: preset.models.map((m) => ({ id: m.id, label: m.label, ...(m.context_limit === undefined ? {} : { context_limit: m.context_limit }) })),
    };
    const base = defaultConfig();
    const config = {
        ...base,
        providers: [...base.providers.filter((p) => p.id !== provider.id), provider],
        active_provider: provider.id,
        active_model: model.id,
        permissions: { ...base.permissions, mode: mode },
    };
    await saveGlobalConfig(config);
    if (preset.needsKey && apiKey && apiKey !== envKey) {
        await setCredential(`providers.${preset.kind}.api_key`, apiKey);
        ui.success('Credential stored in credentials.json (mode 0600).');
    }
    ui.out('');
    ui.success(`Configured ${provider.id}/${model.id} with permission mode "${mode}".`);
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
    ui.out(ui.dim('Next: run `lc doctor` to verify everything, then just start talking.'));
    return 0;
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