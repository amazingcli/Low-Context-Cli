/**
 * CLI entry point (§29, §30).
 *
 * Responsibilities are narrow on purpose: parse, load configuration, build the
 * shared context, dispatch. All the interesting behaviour lives behind
 * `COMMANDS` and the agent, which keeps this file readable and lets `doctor`,
 * tests and the CLI share exactly one code path.
 *
 * Two behaviours worth noting:
 *  - a bare `low-context "do something"` is a one-shot request, not a syntax
 *    error, because that is how people actually type;
 *  - a missing configuration offers setup instead of failing (§75).
 */
import { findProjectRoot } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { AgentEventLog, Logger } from '../core/logger.js';
import { describeError, isLowContextError } from '../core/errors.js';
import { openWorkspace } from '../agent/workspace.js';
import { COMMANDS, HELP, VERSION } from './commands.js';
import { runInteractive, runAgentTurn } from './chat.js';
import { runInitWizard, offerSetup } from './wizard.js';
import { createUi } from './ui.js';
import { flagBool, flagString, parseArgs } from './args.js';
export async function main(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const parsed = parseArgs(argv);
    const cwd = options.cwd ?? process.cwd();
    // Config is loaded before the UI so `--no-color` can be honoured.
    let projectRoot;
    try {
        projectRoot = await findProjectRoot(cwd);
    }
    catch {
        projectRoot = cwd;
    }
    let loaded;
    try {
        loaded = await loadConfig({
            ...(projectRoot === undefined ? {} : { projectRoot }),
            skipProject: parsed.command === 'help' || parsed.command === 'version',
        });
    }
    catch (error) {
        process.stderr.write(`low-context: could not load configuration: ${describeError(error)}\n`);
        return 2;
    }
    const config = applyFlagOverrides(loaded.config, parsed);
    const ui = createUi({
        color: config.ui.color,
        responseMode: config.ui.response_mode,
        spinner: config.ui.spinner,
    });
    if (flagBool(parsed.flags, 'help') || parsed.command === 'help') {
        ui.result(HELP);
        return 0;
    }
    if (flagBool(parsed.flags, 'version') || parsed.command === 'version') {
        ui.result(`low-context ${VERSION}`);
        return 0;
    }
    const logger = new Logger({
        level: config.ui.response_mode === 'debug' ? 'debug' : 'info',
        logPrompts: config.privacy.log_prompts,
    });
    const events = new AgentEventLog();
    let cachedWorkspace;
    const ctx = {
        args: parsed,
        ui,
        config,
        configSources: loaded.sources,
        logger,
        events,
        cwd: projectRoot ?? cwd,
        async openWorkspace(openOptions = {}) {
            if (cachedWorkspace) {
                if (openOptions.refresh === true)
                    await cachedWorkspace.ensureIndex({ force: false });
                return cachedWorkspace;
            }
            ui.startSpinner('opening project...');
            try {
                cachedWorkspace = await openWorkspace({
                    root: projectRoot ?? cwd,
                    config,
                    refreshIndex: openOptions.refresh === true || config.index.refresh_on_start,
                });
            }
            finally {
                ui.stopSpinner();
            }
            return cachedWorkspace;
        },
    };
    logger.info('cli.start', {
        command: parsed.command || '(interactive)',
        subcommand: parsed.subcommand,
        cwd: ctx.cwd,
        model: `${config.active_provider ?? '-'}/${config.active_model ?? '-'}`,
    });
    try {
        const code = await dispatch(ctx, parsed, { offerSetup: () => offerSetup(ui, ctx) });
        await logger.flush();
        if (cachedWorkspace)
            await cachedWorkspace.flush();
        return code;
    }
    catch (error) {
        logger.error('cli.error', { message: describeError(error), code: isLowContextError(error) ? error.code : undefined });
        await logger.flush();
        if (isLowContextError(error)) {
            ui.error(error.message);
            if (error.fix)
                ui.out(ui.dim(`  fix: ${error.fix}`));
        }
        else {
            ui.error(describeError(error));
            if (config.ui.response_mode === 'debug' && error instanceof Error && error.stack)
                ui.out(ui.dim(error.stack));
        }
        return 1;
    }
}
async function dispatch(ctx, parsed, hooks) {
    const command = parsed.command;
    // No command at all: interactive session.
    if (command === '') {
        return runInteractive(ctx);
    }
    if (command === 'init') {
        return runInitWizard(ctx, { nonInteractive: flagBool(parsed.flags, 'non-interactive') || flagBool(parsed.flags, 'yes') });
    }
    if (command === 'chat') {
        return runInteractive(ctx);
    }
    if (command === 'run' || command === 'ask') {
        const request = parsed.positionals.join(' ') || parsed.rest;
        if (request.trim() === '') {
            ctx.ui.error('run requires a request, e.g. `lc run "fix the login bug"`');
            return 2;
        }
        if (!(await ensureModel(ctx, hooks)))
            return 2;
        return runAgentTurn(ctx, request, { explain: ctx.config.ui.response_mode === 'debug' });
    }
    if (command === 'plan') {
        const request = parsed.positionals.join(' ') || parsed.rest;
        if (request.trim() === '') {
            ctx.ui.error('plan requires a request');
            return 2;
        }
        if (!(await ensureModel(ctx, hooks)))
            return 2;
        return runAgentTurn(ctx, request, { planOnly: true, explain: true });
    }
    const handler = COMMANDS[command];
    if (handler) {
        const result = await handler(ctx, parsed.subcommand ?? '');
        // `analyze --narrative` and `analyze` share a handler that may itself run a
        // turn, so no further dispatch is needed here.
        return result;
    }
    // Unknown command with free text: treat the whole line as a request. This is
    // what makes `lc fix the build` work without a `run` keyword.
    const request = [command, ...parsed.positionals, parsed.rest].join(' ').trim();
    if (request !== '' && !command.startsWith('-')) {
        if (!(await ensureModel(ctx, hooks)))
            return 2;
        return runAgentTurn(ctx, request);
    }
    ctx.ui.error(`Unknown command: ${command}`);
    ctx.ui.out(`Run \`lc help\` for the command list.`);
    return 2;
}
async function ensureModel(ctx, hooks) {
    const active = ctx.config.active_provider;
    const provider = ctx.config.providers.find((p) => p.id === active && p.enabled);
    if (provider && provider.models.length > 0)
        return true;
    return hooks.offerSetup();
}
/** CLI flags that override config for a single run. */
function applyFlagOverrides(config, parsed) {
    const next = { ...config };
    const strategy = flagString(parsed.flags, 'strategy');
    if (strategy === 'minimal' || strategy === 'balanced' || strategy === 'deep' || strategy === 'maximum') {
        next.context = { ...next.context, strategy };
    }
    const mode = flagString(parsed.flags, 'mode');
    if (mode === 'safe' || mode === 'ask' || mode === 'trusted') {
        next.permissions = { ...next.permissions, mode };
    }
    const responseMode = flagString(parsed.flags, 'response-mode');
    if (responseMode === 'normal' || responseMode === 'verbose' || responseMode === 'quiet' || responseMode === 'debug') {
        next.ui = { ...next.ui, response_mode: responseMode };
    }
    if (flagBool(parsed.flags, 'quiet'))
        next.ui = { ...next.ui, response_mode: 'quiet' };
    if (flagBool(parsed.flags, 'verbose'))
        next.ui = { ...next.ui, response_mode: 'verbose' };
    if (flagBool(parsed.flags, 'debug'))
        next.ui = { ...next.ui, response_mode: 'debug' };
    if (flagBool(parsed.flags, 'no-color') || flagBool(parsed.flags, 'color') === false) {
        next.ui = { ...next.ui, color: 'never' };
    }
    const provider = flagString(parsed.flags, 'provider');
    if (provider !== undefined)
        next.active_provider = provider;
    const model = flagString(parsed.flags, 'model');
    if (model !== undefined)
        next.active_model = model;
    if (flagBool(parsed.flags, 'no-memory'))
        next.memory = { ...next.memory, enabled: false, auto_capture: false };
    if (flagBool(parsed.flags, 'no-index'))
        next.index = { ...next.index, enabled: false, refresh_on_start: false };
    return next;
}
//# sourceMappingURL=index.js.map