/**
 * Chat surfaces (§28, §29, §27).
 *
 * `runAgentTurn` is the one-shot path: retrieve, act, print the answer.
 * `runInteractive` is the session path, and it does three things a naive REPL
 * would not:
 *
 *   - it keeps a *session record* with compact task state, so `--resume` does
 *     not need to replay the transcript (§27);
 *   - it remembers the conversation id, so history accumulates on disk while
 *     only recent turns and a summary enter context (§15);
 *   - it exposes the system's own state as slash commands (`/context`,
 *     `/memory`, `/index`, `/models`, `/providers`), because the whole product
 *     premise is that the user can see and control what the agent knows.
 *
 * The input line is drawn by `prompt.ts`: typing `/` opens a filtered menu of
 * every command, so the CLI is discoverable without memorising anything.
 */
import { createProvider, createEmbeddingClient, modelDescriptor } from '../providers/registry.js';
import { Agent } from '../agent/loop.js';
import { registryFromConfig } from '../tools/registry.js';
import { renderBudgetLine } from '../context/builder.js';
import { formatTokens } from '../context/estimator.js';
import { recordDecision, addPending, completePending, renderTaskState } from '../storage/task-store.js';
import { describeError } from '../core/errors.js';
import { saveGlobalConfig } from '../core/config.js';
import { formatBytes, truncate } from '../core/util.js';
import { readLine } from './prompt.js';
import { SLASH_COMMANDS } from './slash-menu.js';
import { VERSION, COMMANDS } from './commands.js';
import { offerSetup } from './wizard.js';
/** One-shot turn: the shared implementation behind `run`, `plan` and `analyze`. */
export async function runAgentTurn(ctx, request, options = {}) {
    const workspace = await ctx.openWorkspace({ refresh: false });
    const prepared = await resolveModel(ctx, workspace);
    if (!prepared) {
        const configured = await offerSetup(ctx.ui, ctx);
        if (!configured)
            return 2;
        const retry = await resolveModel(ctx, workspace);
        if (!retry)
            return 2;
        return runAgentTurn(ctx, request, options);
    }
    const { provider, model } = prepared;
    const ui = buildAgentUi(ctx, { explain: options.explain === true });
    const agent = new Agent({
        workspace,
        provider,
        model,
        registry: registryFromConfig(ctx.config, { disableAll: options.planOnly === true }),
        logger: ctx.logger,
        events: ctx.events,
        ui,
        ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
        ...(options.taskState === undefined ? {} : { taskState: options.taskState }),
        maxTurns: options.planOnly === true ? 1 : 12,
        embedder: await safeEmbedder(ctx),
    });
    ctx.ui.startSpinner('retrieving...');
    let streamed = false;
    agent.setUi({
        ...ui,
        text: (chunk) => {
            if (!streamed) {
                ctx.ui.stopSpinner();
                streamed = true;
            }
            ctx.ui.stream(chunk);
        },
    });
    try {
        const result = await agent.run(request);
        ctx.ui.stopSpinner();
        if (streamed)
            ctx.ui.endStream();
        else
            ctx.ui.result(result.text);
        printTurnFooter(ctx, result.usage, result.contextReport ? renderBudgetLine(result.contextReport) : undefined, result.toolCalls, options.explain === true ? result.trace : undefined);
        await workspace.flush();
        return 0;
    }
    catch (error) {
        ctx.ui.stopSpinner();
        ctx.ui.error(describeError(error));
        return 1;
    }
}
function buildAgentUi(ctx, options) {
    const ui = ctx.ui;
    return {
        text: () => undefined,
        reasoning: (chunk) => {
            if (ui.debug)
                ui.note(`reasoning: ${chunk}`);
        },
        status: (message) => {
            if (message === '')
                ui.stopSpinner();
        },
        note: (message) => ui.note(message),
        toolCall: (call, preview) => {
            ui.stopSpinner();
            const args = Object.keys(call.arguments).length === 0 ? '' : ` ${truncate(inlineArgs(call.arguments), 88)}`;
            ui.out(`  ${ui.color('magenta', '⏺')} ${ui.bold(call.name)}${ui.dim(args)}`);
            if (ui.debug && preview)
                ui.out(ui.dim(`      policy: ${preview}`));
        },
        toolResult: (result) => {
            const badge = result.ok ? ui.color('green', '✓') : ui.color('red', '✗');
            const files = result.affected_files && result.affected_files.length > 0 ? ` ${ui.dim(result.affected_files.slice(0, 3).join(', '))}` : '';
            const size = result.truncated ? ` ${ui.dim(`(full output: ${formatBytes(result.bytes)})`)}` : '';
            ui.out(`    ${badge} ${ui.dim(`${result.duration_ms} ms`)}${files}${size}`);
            if (!result.ok && result.error && ui.verbose)
                ui.out(ui.dim(`      ${truncate(result.error, 160)}`));
        },
        retrieval: (trace) => {
            if (!options.explain && !ui.debug)
                return;
            ui.out(ui.bold('  Retrieval'));
            for (const step of trace.steps) {
                ui.out(`    ${step.stage.padEnd(16)} ${String(step.kept).padStart(3)}/${String(step.candidates).padEnd(3)} ${ui.dim(`${step.duration_ms} ms`)} ${ui.dim(truncate(step.detail, 64))}`);
            }
            for (const candidate of trace.candidates.slice(0, 10)) {
                ui.out(`    ${candidate.score.toFixed(2)} ${candidate.verified ? ui.color('green', 'verified') : ui.dim('unverified')} ${truncate(candidate.file_path ?? candidate.id, 58)}`);
                ui.out(ui.dim(`         ${candidate.reason}`));
            }
        },
        contextReport: (report) => {
            if (!options.explain && !ui.debug && !ctx.config.ui.show_context_bar)
                return;
            if (ui.quiet)
                return;
            const bar = renderContextBar(report.used_tokens, report.usable_tokens);
            ui.note(`context ${bar} ${formatTokens(report.used_tokens)}/${formatTokens(report.usable_tokens)} (${report.strategy})`);
        },
        usage: (_usage) => {
            // Aggregate token accounting is printed by the caller after the turn.
            return;
        },
        verification: (report) => {
            const badge = report.passed ? ui.color('green', 'verified') : ui.color('yellow', 'unverified');
            ui.out(`  ${badge} ${ui.dim(report.summary.split('\n')[0] ?? '')}`);
            if (!report.passed && ui.verbose)
                for (const line of report.summary.split('\n').slice(1))
                    ui.out(ui.dim(`    ${line}`));
        },
        error: (message) => ui.error(message),
        confirm: (request) => confirmToolUse(ctx, request),
    };
}
/** `{"path":"a.ts","limit":40}` → `path=a.ts limit=40`, which reads better inline. */
function inlineArgs(args) {
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null)
            continue;
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        parts.push(parts.length === 0 && typeof value === 'string' && /path|file|command|query|pattern|name/.test(key) ? rendered : `${key}=${rendered}`);
    }
    return parts.join(' ');
}
function renderContextBar(used, usable, width = 20) {
    const ratio = usable <= 0 ? 0 : Math.min(1, used / usable);
    const filled = Math.round(ratio * width);
    return `[${'█'.repeat(filled)}${'·'.repeat(Math.max(0, width - filled))}]`;
}
async function confirmToolUse(ctx, request) {
    if (ctx.args.flags.yes === true)
        return true;
    return ctx.ui.confirm(`Allow ${request.resource} ${request.destructive ? '(destructive)' : ''}?`, {
        detail: `  ${request.summary}`,
        defaultYes: false,
    });
}
function printTurnFooter(ctx, usage, budget, toolCalls, trace) {
    if (!ctx.config.ui.show_token_usage || ctx.ui.quiet)
        return;
    const input = usage.reduce((sum, u) => sum + u.input_tokens, 0);
    const output = usage.reduce((sum, u) => sum + u.output_tokens, 0);
    const anyEstimated = usage.some((u) => u.estimated);
    if (input > 0 || output > 0) {
        ctx.ui.note(`tokens: ${formatTokens(input)} in / ${formatTokens(output)} out${anyEstimated ? ' (estimated)' : ''}, ${toolCalls} tool call(s)`);
    }
    if (budget && ctx.ui.debug)
        ctx.ui.note(budget);
    if (trace && ctx.ui.debug) {
        for (const step of trace.steps)
            ctx.ui.note(`trace ${step.stage}: ${step.kept}/${step.candidates} kept in ${step.duration_ms} ms`);
    }
}
export async function runInteractive(ctx) {
    const { ui } = ctx;
    const workspace = await ctx.openWorkspace({ refresh: true });
    let prepared = await resolveModel(ctx, workspace);
    if (!prepared) {
        const configured = await offerSetup(ui, ctx);
        if (!configured)
            return 2;
        prepared = await resolveModel(ctx, workspace);
        if (!prepared) {
            ui.warn('Still no usable provider. Fix it with `lc init`, then run `lc` again.');
            return 2;
        }
    }
    const session = await startSession(ctx, workspace, prepared.model, ctx.resumeSessionId);
    let conversationId = session.conversation_id;
    if (!conversationId) {
        const conversation = await workspace.stores.conversations.create({
            project_id: workspace.project.id,
            session_id: session.id,
            title: `session ${session.id}`,
        });
        conversationId = conversation.id;
        await workspace.stores.sessions.update(session.id, { conversation_id: conversation.id });
    }
    const taskState = session.task_state ?? (await workspace.stores.tasks.active(session.id));
    const registry = registryFromConfig(ctx.config);
    const embedder = await safeEmbedder(ctx);
    const runtime = {
        workspace,
        registry,
        provider: prepared.provider,
        model: prepared.model,
        session,
        conversationId,
        ...(taskState === undefined ? {} : { taskState }),
        bypass: false,
        // Assigned by `rebuild()` below; the agent needs `runtime` to exist first.
        agent: undefined,
        rebuild: () => undefined,
    };
    /** (Re)create the agent so model/conversation changes take effect. */
    const rebuild = () => {
        runtime.agent = new Agent({
            workspace,
            provider: runtime.provider,
            model: runtime.model,
            registry,
            logger: ctx.logger,
            events: ctx.events,
            ui: buildAgentUi(ctx, { explain: ctx.config.ui.response_mode === 'debug' }),
            sessionId: session.id,
            conversationId: runtime.conversationId,
            ...(runtime.taskState === undefined ? {} : { taskState: runtime.taskState }),
            embedder,
        });
    };
    runtime.rebuild = rebuild;
    rebuild();
    const counts = await projectCounts(workspace);
    printBanner(ctx, workspace, runtime.model, session.id, counts);
    if (runtime.taskState) {
        ui.out('');
        ui.out(ui.bold('Restored task state (no transcript replay)'));
        ui.out(renderTaskState(runtime.taskState));
    }
    ui.out('');
    ui.out(ui.dim('Type a request. Type / for the command menu, /help for the full list, /exit to leave.'));
    const history = [];
    const totals = { input: 0, output: 0, turns: 0, tools: 0, estimated: false };
    for (;;) {
        const colors = {
            dim: (text) => ui.dim(text),
            bold: (text) => ui.bold(text),
            cyan: (text) => ui.color('cyan', text),
        };
        const input = await readLine({
            prompt: ui.color('cyan', `${ui.bold(workspace.project.name)} ${ui.dim('›')} `),
            commands: SLASH_COMMANDS,
            colors,
            history,
        });
        if (input.line === undefined) {
            if (input.ended === 'eof')
                break;
            ui.out(ui.dim('(cancelled — type /exit to end the session)'));
            continue;
        }
        const line = input.line;
        if (line === '')
            continue;
        history.push(line);
        if (history.length > 200)
            history.shift();
        if (line.startsWith('/')) {
            const outcome = await handleSlashCommand(ctx, runtime, line, totals);
            if (outcome.endSession)
                break;
            continue;
        }
        if (!runtime.bypass)
            ui.startSpinner('retrieving...');
        let streamed = false;
        const turnUi = buildAgentUi(ctx, { explain: false });
        runtime.agent.setUi({
            ...turnUi,
            text: (chunk) => {
                if (!streamed) {
                    ui.stopSpinner();
                    streamed = true;
                }
                ui.stream(chunk);
            },
            toolCall: (call, preview) => {
                ui.stopSpinner();
                turnUi.toolCall?.(call, preview);
            },
        });
        const started = Date.now();
        try {
            const result = await runtime.agent.run(line);
            ui.stopSpinner();
            if (streamed)
                ui.endStream();
            else
                ui.result(result.text);
            runtime.taskState = await updateTaskState(workspace, session.id, runtime.taskState, line, result.toolCalls > 0);
            for (const usage of result.usage) {
                totals.input += usage.input_tokens;
                totals.output += usage.output_tokens;
                totals.estimated = totals.estimated || usage.estimated;
            }
            totals.turns += result.turns;
            totals.tools += result.toolCalls;
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            const tokens = result.usage.reduce((sum, u) => sum + u.input_tokens + u.output_tokens, 0);
            ui.out(ui.dim(`  — ${elapsed}s · ${result.turns} turn(s) · ${result.toolCalls} tool call(s) · ~${formatTokens(tokens)} tokens · context ${renderContextBar(result.contextReport?.used_tokens ?? 0, result.contextReport?.usable_tokens ?? 1)}`));
            if (result.stoppedEarly)
                ui.note('retrieval stopped early: enough verified evidence was found');
        }
        catch (error) {
            ui.stopSpinner();
            ui.error(describeError(error));
            ui.out(ui.dim('  The session is still alive. Try again, or /model to switch models.'));
        }
        await workspace.flush();
    }
    await workspace.stores.sessions.update(session.id, {
        status: 'idle',
        ...(runtime.taskState === undefined ? {} : { task_state: runtime.taskState }),
    });
    await workspace.flush();
    ui.out('');
    ui.info(`Session ${session.id} saved. Resume with \`lc sessions resume ${session.id}\`.`);
    return 0;
}
async function handleSlashCommand(ctx, runtime, line, totals) {
    const { ui } = ctx;
    const { workspace } = runtime;
    const spaceAt = line.indexOf(' ');
    const command = (spaceAt === -1 ? line.slice(1) : line.slice(1, spaceAt)).trim();
    const argument = (spaceAt === -1 ? '' : line.slice(spaceAt + 1)).trim();
    switch (command) {
        case 'help':
            ui.result(renderSlashHelp());
            return {};
        case 'exit':
        case 'quit':
            return { endSession: true };
        /* ------------------------------- session ------------------------------- */
        case 'status': {
            const files = await workspace.stores.index.listFiles(workspace.project.id);
            const memory = await workspace.stores.memory.count({ project_id: workspace.project.id });
            ui.heading('Status');
            ui.keyValue([
                ['project', `${workspace.project.name}  ${ui.dim(workspace.root)}`],
                ['model', `${runtime.model.provider}/${runtime.model.id} (${formatTokens(runtime.model.context_limit)} window)`],
                ['strategy', ctx.config.context.strategy],
                ['permissions', runtime.bypass ? ui.color('yellow', 'BYPASSED (/nopermission)') : ctx.config.permissions.mode],
                ['session', runtime.session.id],
                ['conversation', runtime.conversationId],
                ['indexed files', String(files.length)],
                ['memory records', String(memory)],
                ['this session', `${totals.turns} turn(s), ${totals.tools} tool call(s), ~${formatTokens(totals.input + totals.output)} tokens`],
            ]);
            return {};
        }
        case 'history': {
            const requested = Number(argument);
            const limit = Number.isFinite(requested) && requested > 0 ? Math.min(200, Math.floor(requested)) : 20;
            const messages = await workspace.stores.conversations.messages(runtime.conversationId, { limit });
            if (messages.length === 0) {
                ui.info('No messages in this conversation yet.');
                return {};
            }
            ui.heading(`Last ${messages.length} message(s)`);
            for (const message of messages)
                ui.out(formatHistoryLine(ctx, message));
            ui.out('');
            ui.out(ui.dim(`Full history is on disk (conversation ${runtime.conversationId}). Use /search to look further back.`));
            return {};
        }
        case 'search': {
            if (argument === '') {
                ui.warn('usage: /search <text>   (searches every stored conversation)');
                return {};
            }
            const hits = await workspace.stores.conversations.searchMessages({
                text: argument,
                project_id: workspace.project.id,
                limit: 10,
            });
            if (hits.length === 0) {
                ui.info('No stored messages match.');
                return {};
            }
            ui.heading(`Conversation search: ${argument}`);
            for (const hit of hits) {
                ui.out(`  ${ui.dim(hit.score.toFixed(2))} ${formatHistoryLine(ctx, hit.message)}`);
            }
            return {};
        }
        case 'sessions': {
            const sessions = await workspace.stores.sessions.list({ project_id: workspace.project.id, limit: 15 });
            ui.heading('Sessions');
            ui.table(['id', 'status', 'model', 'updated'], sessions.map((s) => [s.id, s.id === runtime.session.id ? `${s.status} (current)` : s.status, `${s.provider ?? '?'}/${s.model ?? '?'}`, s.updated_at.slice(0, 19)]));
            return {};
        }
        case 'resume': {
            if (argument === '') {
                ui.warn('usage: /resume <session-id>   (see /sessions)');
                return {};
            }
            const target = await workspace.stores.sessions.resolve(argument);
            if (!target) {
                ui.warn(`No session matches "${argument}".`);
                return {};
            }
            if (target.conversation_id)
                runtime.conversationId = target.conversation_id;
            runtime.taskState = target.task_state ?? (await workspace.stores.tasks.active(target.id));
            await workspace.stores.sessions.update(target.id, { status: 'active' });
            runtime.rebuild();
            ui.success(`Resumed ${target.id}: conversation and task state restored without replaying the transcript.`);
            if (runtime.taskState)
                ui.out(renderTaskState(runtime.taskState));
            return {};
        }
        case 'clear': {
            const conversation = await workspace.stores.conversations.create({
                project_id: workspace.project.id,
                title: 'new conversation',
            });
            runtime.conversationId = conversation.id;
            await workspace.stores.sessions.update(runtime.session.id, { conversation_id: conversation.id });
            runtime.rebuild();
            ui.success(`Started conversation ${conversation.id}. Previous history remains on disk and searchable with /search.`);
            return {};
        }
        /* ------------------------------- project -------------------------------- */
        case 'context': {
            const dry = await runtime.agent.dryRun(argument || 'the next request');
            ui.result(dry.report);
            return {};
        }
        case 'explain': {
            if (argument === '') {
                ui.warn('usage: /explain <request>');
                return {};
            }
            const result = await runtime.agent.run(argument);
            ui.result(result.text);
            if (result.trace) {
                ui.out('');
                ui.out(ui.bold('Why these sources'));
                for (const candidate of result.trace.candidates.slice(0, 12)) {
                    ui.out(`  ${candidate.score.toFixed(2)} ${candidate.verified ? ui.color('green', 'verified') : 'unverified'} ${truncate(candidate.file_path ?? candidate.id, 58)}`);
                    ui.out(ui.dim(`       ${candidate.reason}`));
                }
            }
            return {};
        }
        case 'index': {
            if (argument === 'rebuild') {
                ui.info('Rebuilding the index from scratch...');
                const result = await workspace.ensureIndex({ force: true });
                ui.success(result ? `Index rebuilt: ${result.added + result.changed + result.unchanged} file(s).` : 'Indexing is disabled in config.');
                return {};
            }
            ui.info('Refreshing the index...');
            const result = await workspace.ensureIndex({ force: false });
            ui.success(result ? `Index updated: ${result.added} added, ${result.changed} changed, ${result.removed} removed.` : 'Index refresh is disabled in config.');
            return {};
        }
        case 'map': {
            const { buildProjectMap, renderProjectMap, renderModuleMap } = await import('../index/project-map.js');
            const files = await workspace.stores.index.listFiles(workspace.project.id);
            const modules = await workspace.stores.index.listModules(workspace.project.id);
            const map = buildProjectMap(workspace.root, files, modules);
            ui.result(argument === '' ? renderProjectMap(map, {}) : renderModuleMap(map, argument, { maxDepth: 4, maxFiles: 300 }));
            return {};
        }
        case 'files': {
            const files = argument === '' ? await workspace.stores.index.listFiles(workspace.project.id) : (await workspace.stores.index.searchFiles(workspace.project.id, argument, 25)).map((hit) => hit.file);
            ui.heading(argument === '' ? `${files.length} indexed file(s)` : `Files matching "${argument}"`);
            ui.table(['path', 'lang', 'symbols'], files.slice(0, 40).map((file) => [file.path, file.language, String(file.symbols?.length ?? 0)]));
            return {};
        }
        case 'diff': {
            const git = await import('../git/git.js');
            const text = await git.diff(workspace.root, { context: 3 });
            ui.result(text.trim() === '' ? 'No changes.' : truncate(text, 8_000));
            return {};
        }
        /* -------------------------------- memory -------------------------------- */
        case 'memory': {
            if (argument === '') {
                const records = await workspace.stores.memory.list({ project_id: workspace.project.id, limit: 15 });
                ui.heading('Memory (most recent)');
                ui.table(['id', 'type', 'confidence', 'summary'], records.map((r) => [r.id, r.type, r.confidence, truncate(r.summary, 54)]));
                return {};
            }
            const hits = await workspace.stores.memory.search({ text: argument, limit: 8, project_id: workspace.project.id });
            ui.heading(`Memory search: ${argument}`);
            ui.table(['score', 'id', 'summary'], hits.map((h) => [h.score.toFixed(2), h.record.id, truncate(h.record.summary, 64)]));
            return {};
        }
        case 'remember': {
            if (argument === '') {
                ui.warn('usage: /remember <text>');
                return {};
            }
            const record = await workspace.stores.memory.write({
                type: 'FACT',
                scope: 'project',
                summary: argument,
                tags: ['user-instruction'],
                source_refs: [{ kind: 'session', conversation_id: runtime.conversationId, session_id: runtime.session.id }],
                confidence: 'verified',
                importance: 'important',
                verification_state: 'verified',
                project_id: workspace.project.id,
                session_id: runtime.session.id,
            });
            ui.success(`Stored ${record.id} as project memory — it will be retrieved later. This is storage, not model training.`);
            return {};
        }
        case 'forget': {
            if (argument === '') {
                ui.warn('usage: /forget <query>');
                return {};
            }
            const hits = await workspace.stores.memory.search({ text: argument, limit: 10, project_id: workspace.project.id });
            let deleted = 0;
            for (const hit of hits)
                if (await workspace.stores.memory.delete(hit.record.id))
                    deleted += 1;
            ui.success(`Deleted ${deleted} record(s).`);
            return {};
        }
        case 'usage': {
            ui.heading('Token usage (this session)');
            ui.keyValue([
                ['input tokens', formatTokens(totals.input)],
                ['output tokens', formatTokens(totals.output)],
                ['turns', String(totals.turns)],
                ['tool calls', String(totals.tools)],
                ['exactness', totals.estimated ? 'partly estimated (provider did not report usage)' : 'reported by the provider'],
            ]);
            const dry = await runtime.agent.dryRun('the next request');
            ui.out('');
            ui.result(dry.report);
            return {};
        }
        /* --------------------------------- model -------------------------------- */
        case 'model': {
            if (argument !== '')
                return switchModel(ctx, runtime, argument);
            ui.heading('Active model');
            ui.keyValue([
                ['provider', runtime.model.provider],
                ['model', runtime.model.id],
                ['context window', formatTokens(runtime.model.context_limit)],
                ['max output', formatTokens(runtime.model.max_output)],
            ]);
            return {};
        }
        case 'models': {
            if (argument !== '')
                return switchModel(ctx, runtime, argument);
            const models = await listConfiguredModels(ctx);
            ui.heading('Models');
            models.forEach((entry, index) => {
                const active = entry.provider === runtime.model.provider && entry.model.id === runtime.model.id;
                ui.out(`  ${String(index + 1).padStart(2)}) ${active ? ui.color('green', '●') : ' '} ${entry.model.id} ${ui.dim(`${entry.provider} · ${formatTokens(entry.model.context_limit)} ctx`)}`);
            });
            ui.out('');
            ui.out(ui.dim('  Switch with /model <number> or /model <id>. Add more with `lc providers add`.'));
            return {};
        }
        case 'providers': {
            ui.heading('Providers');
            for (const provider of ctx.config.providers) {
                const active = provider.id === ctx.config.active_provider;
                const credential = await describeCredential(ctx, provider.id, provider.api_key_env);
                ui.out(`  ${active ? ui.color('green', '●') : ' '} ${ui.bold(provider.id)} ${ui.dim(`(${provider.kind})`)}${provider.enabled ? '' : ui.dim(' [disabled]')}`);
                ui.out(`      ${ui.dim('url')} ${provider.base_url ?? '(default)'}`);
                ui.out(`      ${ui.dim('key')} ${credential}`);
                ui.out(`      ${ui.dim('models')} ${provider.models.map((m) => m.id).join(', ') || '(none)'}`);
            }
            ui.out('');
            ui.out(ui.dim('  Change key/URL with `lc providers add` (rewrites this entry) or edit config with `lc config edit`.'));
            return {};
        }
        case 'permissions': {
            ui.heading('Permissions');
            ui.keyValue([
                ['mode', ctx.config.permissions.mode],
                ['bypass', runtime.bypass ? ui.color('yellow', 'ON — confirmations disabled for this session') : 'off'],
                ['outside project', ctx.config.permissions.allow_outside_project ? 'allowed' : 'blocked'],
                ['allow rules', ctx.config.permissions.allow.join(', ') || '(none)'],
                ['deny rules', ctx.config.permissions.deny.join(', ') || '(none)'],
            ]);
            ui.out('');
            ui.out(ui.dim('  /nopermission toggles bypass. Deny rules and catastrophic commands stay blocked either way.'));
            return {};
        }
        case 'nopermission': {
            const next = argument === '' ? !runtime.bypass : !['off', 'false', '0', 'no'].includes(argument.toLowerCase());
            runtime.bypass = next;
            runtime.registry.permissions.setBypass(next);
            if (next) {
                ui.warn('Permission bypass ON. File writes and commands run without asking, for this session only.');
                ui.out(ui.dim('  Still blocked: deny rules, and catastrophic commands (rm -rf /, fork bombs, curl|sh, force push).'));
            }
            else {
                ui.success(`Permission bypass OFF. Mode "${ctx.config.permissions.mode}" applies again.`);
            }
            return {};
        }
        /* -------------------------------- system -------------------------------- */
        case 'tools': {
            ui.heading('Tools');
            ui.table(['name', 'category', 'mutating'], runtime.registry.list().map((tool) => [tool.name, tool.category, tool.mutating ? 'yes' : 'no']));
            return {};
        }
        case 'verbose': {
            ui.setResponseMode(ui.responseMode === 'verbose' ? 'normal' : 'verbose');
            ui.success(`Response mode: ${ui.responseMode}`);
            return {};
        }
        case 'debug': {
            ui.setResponseMode(ui.responseMode === 'debug' ? 'normal' : 'debug');
            ui.success(`Response mode: ${ui.responseMode}${ui.responseMode === 'debug' ? ' — retrieval traces and tool policy are shown' : ''}`);
            return {};
        }
        case 'quiet': {
            ui.setResponseMode(ui.responseMode === 'quiet' ? 'normal' : 'quiet');
            ui.success(`Response mode: ${ui.responseMode}`);
            return {};
        }
        case 'doctor': {
            const doctor = COMMANDS.doctor;
            if (doctor)
                await doctor(ctx, argument);
            else
                ui.warn('The doctor command is unavailable in this build.');
            return {};
        }
        default:
            ui.warn(`Unknown command /${command}. Type / for the menu.`);
            return {};
    }
}
/** Switch the live model (and provider) without restarting the session. */
async function switchModel(ctx, runtime, argument) {
    const { ui } = ctx;
    const models = await listConfiguredModels(ctx);
    const asNumber = Number(argument);
    const entry = Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= models.length ? models[Math.floor(asNumber) - 1] : models.find((candidate) => candidate.model.id === argument);
    if (!entry) {
        ui.warn(`No configured model matches "${argument}". Use /models to see the list, or add one with \`lc providers add\`.`);
        return {};
    }
    try {
        runtime.provider = entry.provider === ctx.config.active_provider ? runtime.provider : await createProvider(entry.providerConfig, {});
        runtime.model = entry.model;
        runtime.rebuild();
        await saveGlobalConfig({ ...ctx.config, active_provider: entry.provider, active_model: entry.model.id });
        ctx.config.active_provider = entry.provider;
        ctx.config.active_model = entry.model.id;
        await runtime.workspace.stores.sessions.update(runtime.session.id, { provider: entry.provider, model: entry.model.id });
        ui.success(`Switched to ${entry.provider}/${entry.model.id} (${formatTokens(entry.model.context_limit)} context).`);
    }
    catch (error) {
        ui.error(`Could not switch model: ${describeError(error)}`);
    }
    return {};
}
async function listConfiguredModels(ctx) {
    const out = [];
    for (const provider of ctx.config.providers) {
        if (!provider.enabled || provider.kind === 'mock')
            continue;
        for (const model of provider.models) {
            out.push({ provider: provider.id, providerConfig: provider, model: modelDescriptor(provider, model) });
        }
    }
    // The offline mock is still selectable when nothing else is configured.
    if (out.length === 0) {
        for (const provider of ctx.config.providers) {
            for (const model of provider.models)
                out.push({ provider: provider.id, providerConfig: provider, model: modelDescriptor(provider, model) });
        }
    }
    return out;
}
async function describeCredential(ctx, providerId, envName) {
    if (envName && process.env[envName])
        return `environment variable ${envName}`;
    const { resolveSecret } = await import('../security/secrets.js');
    const stored = await resolveSecret(`providers.${providerId}.api_key`).catch(() => undefined);
    if (stored)
        return 'stored in credentials.json (0600)';
    if (envName)
        return ctx.ui.color('yellow', `not set (expected ${envName}, or store it with \`lc init\`)`);
    return ctx.ui.dim('none');
}
function formatHistoryLine(ctx, message) {
    const { ui } = ctx;
    const role = message.role === 'user' ? ui.color('cyan', 'you ') : message.role === 'assistant' ? ui.color('magenta', 'lc  ') : ui.dim(message.role.padEnd(4));
    const when = ui.dim(message.timestamp.slice(11, 19));
    const body = truncate(message.content.replace(/\s+/g, ' ').trim(), 100);
    return `  ${role} ${when}  ${body}`;
}
function renderSlashHelp() {
    const groups = new Map();
    for (const spec of SLASH_COMMANDS) {
        const list = groups.get(spec.group) ?? [];
        list.push(`  /${spec.name}${spec.args ? ` ${spec.args}` : ''}`.padEnd(26) + spec.description);
        groups.set(spec.group, list);
    }
    const lines = ['Commands (the same list appears when you type "/")'];
    for (const [group, entries] of groups) {
        lines.push('');
        lines.push(`  ${group.toUpperCase()}`);
        lines.push(...entries);
    }
    lines.push('');
    lines.push('  Anything else you type is a request for the agent.');
    return lines.join('\n');
}
/* --------------------------------- session --------------------------------- */
async function startSession(ctx, workspace, model, resumeId) {
    if (resumeId) {
        const existing = await workspace.stores.sessions.resolve(resumeId);
        if (existing) {
            await workspace.stores.sessions.update(existing.id, { status: 'active' });
            return { ...existing, status: 'active' };
        }
        ctx.ui.warn(`Session ${resumeId} not found; starting a new one.`);
    }
    return workspace.stores.sessions.create({
        project_id: workspace.project.id,
        project_root: workspace.root,
        provider: model.provider,
        model: model.id,
        title: `session on ${workspace.project.name}`,
    });
}
async function updateTaskState(workspace, sessionId, current, request, acted) {
    const state = current ??
        (await workspace.stores.tasks.create({
            title: truncate(request, 60),
            goal: request,
            project_id: workspace.project.id,
            session_id: sessionId,
        }));
    if (acted) {
        state.status = 'in_progress';
        if (state.pending.length === 0)
            addPending(state, truncate(request, 120));
    }
    if (/\b(done|finished|fixed|working now|that'?s it)\b/i.test(request)) {
        completePending(state, truncate(request, 120));
        if (state.pending.length === 0)
            state.status = 'done';
    }
    if (/\b(decided|we (?:will|should) use|let'?s use|go with)\b/i.test(request)) {
        recordDecision(state, { statement: truncate(request, 200) });
    }
    state.updated_at = new Date().toISOString();
    await workspace.stores.tasks.upsert(state);
    await workspace.stores.sessions.saveTaskState(sessionId, state);
    return state;
}
/* --------------------------------- helpers -------------------------------- */
async function resolveModel(ctx, workspace) {
    const providerId = typeof ctx.args.flags.provider === 'string' ? ctx.args.flags.provider : ctx.config.active_provider ?? workspace.project.default_model;
    const providerConfig = ctx.config.providers.find((p) => p.id === providerId && p.enabled) ?? ctx.config.providers.find((p) => p.enabled);
    if (!providerConfig)
        return undefined;
    const modelId = typeof ctx.args.flags.model === 'string' ? ctx.args.flags.model : ctx.config.active_model;
    const modelConfig = providerConfig.models.find((m) => m.id === modelId) ?? providerConfig.models[0];
    if (!modelConfig)
        return undefined;
    try {
        const provider = await createProvider(providerConfig, {});
        return { provider, model: modelDescriptor(providerConfig, modelConfig) };
    }
    catch (error) {
        ctx.ui.error(`Could not create the ${providerConfig.id} provider: ${describeError(error)}`);
        return undefined;
    }
}
async function safeEmbedder(ctx) {
    if (!ctx.config.embedding.enabled)
        return undefined;
    try {
        return await createEmbeddingClient(ctx.config);
    }
    catch (error) {
        ctx.ui.warn(`Embeddings unavailable (${describeError(error)}); falling back to keyword retrieval.`);
        return undefined;
    }
}
async function projectCounts(workspace) {
    const files = await workspace.stores.index.listFiles(workspace.project.id).catch(() => []);
    const memory = await workspace.stores.memory.count({ project_id: workspace.project.id }).catch(() => 0);
    return { files: files.length, memory };
}
/**
 * The session header. It is the first thing a user sees, so it states exactly
 * what the agent currently knows: which model, which project, what the index
 * and memory contain, and whether prompts are bypassed.
 */
function printBanner(ctx, workspace, model, sessionId, counts) {
    const { ui } = ctx;
    const inner = 66;
    const labelWidth = 13;
    const valueWidth = inner - labelWidth - 1;
    const title = `Low Context ${VERSION}`;
    const modeNote = ctx.config.permissions.mode === 'safe' ? 'read-only' : ctx.config.permissions.mode === 'trusted' ? 'runs without asking' : 'confirms writes and commands';
    // Plain values only: padding is computed on visible length, so no ANSI here.
    const rows = [
        ['model', `${model.provider}/${model.id} · ${formatTokens(model.context_limit)} window`],
        ['project', `${workspace.project.name} · ${workspace.root}`],
        ['retrieval', `${ctx.config.context.strategy} · ${counts.files} files indexed · ${counts.memory} memories`],
        ['permissions', `${ctx.config.permissions.mode} · ${modeNote}`],
        ['session', sessionId],
        ['hint', 'type / for the command menu'],
    ];
    ui.out('');
    ui.out(`╭─ ${title} ${'─'.repeat(Math.max(0, inner - title.length - 4))}╮`);
    for (const [label, raw] of rows) {
        const value = truncate(raw, valueWidth);
        const pad = ' '.repeat(Math.max(0, valueWidth - value.length));
        ui.out(`${ui.dim('│')} ${ui.dim(label.padEnd(labelWidth))}${label === 'hint' ? ui.dim(value) : value}${pad}${ui.dim('│')}`);
    }
    ui.out(`╰${'─'.repeat(inner)}╯`);
}
//# sourceMappingURL=chat.js.map