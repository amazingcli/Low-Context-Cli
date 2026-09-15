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
 *     `/memory`, `/index`), because the whole product premise is that the user
 *     can see and control what the agent knows.
 */
import { createInterface } from 'node:readline/promises';
import { stdin } from 'node:process';
import { createProvider, createEmbeddingClient, modelDescriptor } from '../providers/registry.js';
import { Agent, type AgentUi } from '../agent/loop.js';
import { registryFromConfig } from '../tools/registry.js';
import { renderBudgetLine } from '../context/builder.js';
import { formatTokens } from '../context/estimator.js';
import { recordDecision, addPending, completePending, renderTaskState } from '../storage/task-store.js';
import { describeError } from '../core/errors.js';
import { formatBytes, truncate } from '../core/util.js';
import { VERSION } from './commands.js';
import type { CommandContext } from './commands.js';
import type { Workspace } from '../agent/workspace.js';
import type { ModelDescriptor, RetrievalTrace, TaskState, ToolResult, UsageReport } from '../core/types.js';
import type { ChatProvider } from '../providers/types.js';
import type { PermissionRequest } from '../tools/types.js';

export interface AgentTurnOptions {
  /** Do not give the model any tools; it may only plan. */
  planOnly?: boolean;
  /** Print retrieval/context detail for this turn. */
  explain?: boolean;
  sessionId?: string;
  conversationId?: string;
  taskState?: TaskState;
}

/** One-shot turn: the shared implementation behind `run`, `plan` and `analyze`. */
export async function runAgentTurn(ctx: CommandContext, request: string, options: AgentTurnOptions = {}): Promise<number> {
  const workspace = await ctx.openWorkspace({ refresh: false });
  const prepared = await resolveModel(ctx, workspace);
  if (!prepared) return 2;
  const { provider, model } = prepared;

  const ui: AgentUi = buildAgentUi(ctx, { explain: options.explain === true });
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

  ctx.ui.startSpinner('thinking...');
  let streamed = false;
  agent.setUi({
    ...ui,
    text: (chunk) => {
      streamed = true;
      ctx.ui.stream(chunk);
    },
  });

  try {
    const result = await agent.run(request);
    ctx.ui.stopSpinner();
    if (streamed) ctx.ui.endStream();
    else ctx.ui.result(result.text);
    printTurnFooter(ctx, result.usage, result.contextReport ? renderBudgetLine(result.contextReport) : undefined, result.toolCalls, options.explain === true ? result.trace : undefined);
    await workspace.flush();
    return 0;
  } catch (error) {
    ctx.ui.stopSpinner();
    ctx.ui.error(describeError(error));
    return 1;
  }
}

function buildAgentUi(ctx: CommandContext, options: { explain: boolean }): AgentUi {
  const ui = ctx.ui;
  return {
    text: () => undefined,
    reasoning: (chunk) => {
      if (ui.debug) ui.note(`reasoning: ${chunk}`);
    },
    status: (message) => {
      if (message === '') ui.stopSpinner();
    },
    note: (message) => ui.note(message),
    toolCall: (call, preview) => {
      ui.stopSpinner();
      const args = Object.keys(call.arguments).length === 0 ? '' : ` ${truncate(JSON.stringify(call.arguments), 90)}`;
      ui.out(`${ui.color('magenta', '⚙')} ${ui.bold(call.name)}${ui.dim(args)}`);
      if (ui.debug && preview) ui.out(ui.dim(`  policy: ${preview}`));
    },
    toolResult: (result: ToolResult) => {
      const badge = result.ok ? ui.color('green', '✓') : ui.color('red', '✗');
      const files = result.affected_files && result.affected_files.length > 0 ? ` ${ui.dim(result.affected_files.slice(0, 4).join(', '))}` : '';
      const size = result.truncated ? ` ${ui.dim(`(full output: ${formatBytes(result.bytes)})`)}` : '';
      ui.out(`  ${badge} ${result.tool} ${ui.dim(`${result.duration_ms} ms`)}${files}${size}`);
      if (!result.ok && result.error && ui.verbose) ui.out(ui.dim(`    ${truncate(result.error, 160)}`));
    },
    retrieval: (trace) => {
      if (!options.explain && !ui.debug) return;
      ui.out(ui.bold('Retrieval'));
      for (const step of trace.steps) {
        ui.out(`  ${step.stage.padEnd(16)} ${String(step.kept).padStart(3)}/${String(step.candidates).padEnd(3)} ${ui.dim(`${step.duration_ms} ms`)} ${ui.dim(truncate(step.detail, 70))}`);
      }
      for (const candidate of trace.candidates.slice(0, 10)) {
        ui.out(`  ${candidate.score.toFixed(2)} ${candidate.verified ? ui.color('green', 'verified') : ui.dim('unverified')} ${truncate(candidate.file_path ?? candidate.id, 60)}`);
        ui.out(ui.dim(`       ${candidate.reason}`));
      }
    },
    contextReport: (report) => {
      if (!options.explain && !ui.debug && !ctx.config.ui.show_context_bar) return;
      if (ui.quiet) return;
      const bar = renderContextBar(report.used_tokens, report.usable_tokens);
      ui.note(`context ${bar} ${formatTokens(report.used_tokens)}/${formatTokens(report.usable_tokens)} (${report.strategy})`);
    },
    usage: (_usage: UsageReport) => {
      // Aggregate token accounting is printed by the caller after the turn.
      return;
    },
    verification: (report) => {
      const badge = report.passed ? ui.color('green', 'verified') : ui.color('yellow', 'unverified');
      ui.out(`${badge} ${ui.dim(report.summary.split('\n')[0] ?? '')}`);
      if (!report.passed && ui.verbose) for (const line of report.summary.split('\n').slice(1)) ui.out(ui.dim(`  ${line}`));
    },
    error: (message) => ui.error(message),
    confirm: (request) => confirmToolUse(ctx, request),
  };
}

function renderContextBar(used: number, usable: number, width = 20): string {
  const ratio = usable <= 0 ? 0 : Math.min(1, used / usable);
  const filled = Math.round(ratio * width);
  return `[${'█'.repeat(filled)}${'·'.repeat(Math.max(0, width - filled))}]`;
}

async function confirmToolUse(ctx: CommandContext, request: PermissionRequest): Promise<boolean> {
  if (ctx.args.flags.yes === true) return true;
  return ctx.ui.confirm(`Allow ${request.resource} ${request.destructive ? '(destructive)' : ''}?`, {
    detail: `  ${request.summary}`,
    defaultYes: false,
  });
}

function printTurnFooter(
  ctx: CommandContext,
  usage: readonly UsageReport[],
  budget: string | undefined,
  toolCalls: number,
  trace: RetrievalTrace | undefined,
): void {
  if (!ctx.config.ui.show_token_usage || ctx.ui.quiet) return;
  const input = usage.reduce((sum, u) => sum + u.input_tokens, 0);
  const output = usage.reduce((sum, u) => sum + u.output_tokens, 0);
  const anyEstimated = usage.some((u) => u.estimated);
  if (input > 0 || output > 0) {
    ctx.ui.note(`tokens: ${formatTokens(input)} in / ${formatTokens(output)} out${anyEstimated ? ' (estimated)' : ''}, ${toolCalls} tool call(s)`);
  }
  if (budget && ctx.ui.debug) ctx.ui.note(budget);
  if (trace && ctx.ui.debug) {
    for (const step of trace.steps) ctx.ui.note(`trace ${step.stage}: ${step.kept}/${step.candidates} kept in ${step.duration_ms} ms`);
  }
}

/* ------------------------------- interactive ------------------------------- */

const SLASH_HELP = `Slash commands
  /help                 show this help
  /status               project, model, index and memory summary
  /context              the context budget for the next request
  /explain <request>    run a request with the retrieval trace shown
  /memory [query]       list or search stored memory
  /remember <text>      store a memory record
  /forget <query>       delete matching memory records
  /index                refresh the project index
  /map [module]         show the project map
  /diff                 show the working-tree diff
  /tools                list available tools
  /model                show the active model
  /clear                start a fresh conversation (history stays on disk)
  /exit, /quit          end the session`;

export async function runInteractive(ctx: CommandContext & { resumeSessionId?: string }): Promise<number> {
  const { ui } = ctx;
  const workspace = await ctx.openWorkspace({ refresh: true });
  const prepared = await resolveModel(ctx, workspace);
  if (!prepared) {
    ui.warn('No provider is configured. Run `lc init` first, or set one with `lc providers add`.');
    return 2;
  }
  const { provider, model } = prepared;

  const session = await startSession(ctx, workspace, model, ctx.resumeSessionId);
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
  let taskState = session.task_state ?? (await workspace.stores.tasks.active(session.id));

  printBanner(ctx, workspace, model, session.id);
  if (taskState) {
    ui.out('');
    ui.out(ui.bold('Restored task state (no transcript replay)'));
    ui.out(renderTaskState(taskState));
  }
  ui.out('');
  ui.out(ui.dim('Type a request, or /help for commands. Ctrl-C cancels the current request, /exit ends the session.'));

  const embedder = await safeEmbedder(ctx);
  const agent = new Agent({
    workspace,
    provider,
    model,
    registry: registryFromConfig(ctx.config),
    logger: ctx.logger,
    events: ctx.events,
    ui: buildAgentUi(ctx, { explain: ctx.config.ui.response_mode === 'debug' }),
    sessionId: session.id,
    conversationId,
    ...(taskState === undefined ? {} : { taskState }),
    embedder,
  });

  const rl = createInterface({ input: stdin, output: process.stdout, terminal: stdin.isTTY === true, historySize: 200 });
  let interrupted = false;
  process.on('SIGINT', () => {
    if (!interrupted) {
      interrupted = true;
      ui.warn('interrupted');
    }
  });

  try {
    for (;;) {
      const prompt = ctx.ui.color('cyan', `${workspace.project.name}› `);
      let line: string;
      try {
        line = (await rl.question(`${prompt}`)).trim();
      } catch {
        break;
      }
      if (line === '') continue;
      if (line === '/exit' || line === '/quit') break;

      if (line.startsWith('/')) {
        const handled = await handleSlashCommand(ctx, workspace, agent, line, { conversationId, taskState });
        if (handled.conversationId) conversationId = handled.conversationId;
        if (handled.taskState) taskState = handled.taskState;
        if (handled.endSession) break;
        continue;
      }

      ui.startSpinner('retrieving...');
      let streamed = false;
      agent.setUi({
        ...buildAgentUi(ctx, { explain: false }),
        text: (chunk) => {
          if (!streamed) {
            ui.stopSpinner();
            streamed = true;
          }
          ui.stream(chunk);
        },
        toolCall: () => ui.stopSpinner(),
      });

      const started = Date.now();
      try {
        const result = await agent.run(line);
        ui.stopSpinner();
        if (streamed) ui.endStream();
        else ui.result(result.text);

        taskState = await updateTaskState(workspace, session.id, taskState, line, result.toolCalls > 0);
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const tokens = result.usage.reduce((sum, u) => sum + u.input_tokens + u.output_tokens, 0);
        ui.out(
          ui.dim(
            `— ${elapsed}s · ${result.turns} turn(s) · ${result.toolCalls} tool call(s) · ~${formatTokens(tokens)} tokens · context ${renderContextBar(result.contextReport?.used_tokens ?? 0, result.contextReport?.usable_tokens ?? 1)}`,
          ),
        );
        if (result.stoppedEarly) ui.note('retrieval stopped early: enough verified evidence was found');
      } catch (error) {
        ui.stopSpinner();
        ui.error(describeError(error));
      }
      await workspace.flush();
    }
  } finally {
    rl.close();
    await workspace.stores.sessions.update(session.id, {
      status: 'idle',
      ...(taskState === undefined ? {} : { task_state: taskState }),
    });
    await workspace.flush();
  }

  ui.out('');
  ui.info(`Session ${session.id} saved. Resume with \`lc sessions resume ${session.id}\`.`);
  return 0;
}

interface SlashResult {
  conversationId?: string;
  taskState?: TaskState;
  endSession?: boolean;
}

async function handleSlashCommand(
  ctx: CommandContext,
  workspace: Workspace,
  agent: Agent,
  line: string,
  state: { conversationId: string; taskState?: TaskState },
): Promise<SlashResult> {
  const { ui } = ctx;
  const [command, ...rest] = line.slice(1).split(' ');
  const argument = rest.join(' ').trim();

  switch (command) {
    case 'help':
      ui.result(SLASH_HELP);
      return {};
    case 'status': {
      const files = await workspace.stores.index.listFiles(workspace.project.id);
      const memory = await workspace.stores.memory.count({ project_id: workspace.project.id });
      ui.keyValue([
        ['project', workspace.project.name],
        ['model', `${ctx.config.active_provider}/${ctx.config.active_model}`],
        ['indexed files', String(files.length)],
        ['memory records', String(memory)],
        ['conversation', state.conversationId],
      ]);
      return {};
    }
    case 'context': {
      const dry = await agent.dryRun(argument || 'the next request');
      ui.result(dry.report);
      return {};
    }
    case 'explain': {
      if (argument === '') {
        ui.warn('usage: /explain <request>');
        return {};
      }
      const result = await agent.run(argument);
      ui.result(result.text);
      if (result.trace) {
        ui.out('');
        ui.out(ui.bold('Why these sources'));
        for (const candidate of result.trace.candidates.slice(0, 12)) {
          ui.out(`  ${candidate.score.toFixed(2)} ${candidate.verified ? 'verified' : 'unverified'} ${truncate(candidate.file_path ?? candidate.id, 60)}`);
          ui.out(ui.dim(`       ${candidate.reason}`));
        }
      }
      return {};
    }
    case 'memory': {
      if (argument === '') {
        const records = await workspace.stores.memory.list({ project_id: workspace.project.id, limit: 15 });
        ui.table(['id', 'type', 'importance', 'summary'], records.map((r) => [r.id, r.type, r.importance, truncate(r.summary, 60)]));
        return {};
      }
      const hits = await workspace.stores.memory.search({ text: argument, limit: 8, project_id: workspace.project.id });
      ui.table(['score', 'id', 'summary'], hits.map((h) => [h.score.toFixed(2), h.record.id, truncate(h.record.summary, 70)]));
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
        source_refs: [],
        confidence: 'verified',
        importance: 'important',
        verification_state: 'verified',
        project_id: workspace.project.id,
      });
      ui.success(`Stored ${record.id}.`);
      return {};
    }
    case 'forget': {
      if (argument === '') {
        ui.warn('usage: /forget <query>');
        return {};
      }
      const hits = await workspace.stores.memory.search({ text: argument, limit: 10, project_id: workspace.project.id });
      let deleted = 0;
      for (const hit of hits) if (await workspace.stores.memory.delete(hit.record.id)) deleted += 1;
      ui.success(`Deleted ${deleted} record(s).`);
      return {};
    }
    case 'index': {
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
    case 'diff': {
      const git = await import('../git/git.js');
      const text = await git.diff(workspace.root, { context: 3 });
      ui.result(text.trim() === '' ? 'No changes.' : truncate(text, 8_000));
      return {};
    }
    case 'tools': {
      const registry = registryFromConfig(ctx.config);
      ui.table(['name', 'category', 'mutating'], registry.list().map((tool) => [tool.name, tool.category, tool.mutating ? 'yes' : 'no']));
      return {};
    }
    case 'model': {
      ui.result(`${ctx.config.active_provider}/${ctx.config.active_model}`);
      return {};
    }
    case 'clear': {
      const conversation = await workspace.stores.conversations.create({
        project_id: workspace.project.id,
        title: 'new conversation',
      });
      ui.success(`Started conversation ${conversation.id}. Previous history remains on disk and searchable.`);
      return { conversationId: conversation.id };
    }
    default:
      ui.warn(`Unknown command /${command}. Try /help.`);
      return {};
  }
}

/* --------------------------------- session --------------------------------- */

async function startSession(
  ctx: CommandContext,
  workspace: Workspace,
  model: ModelDescriptor,
  resumeId?: string,
): Promise<Awaited<ReturnType<Workspace['stores']['sessions']['create']>>> {
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

async function updateTaskState(
  workspace: Workspace,
  sessionId: string,
  current: TaskState | undefined,
  request: string,
  acted: boolean,
): Promise<TaskState> {
  const state: TaskState =
    current ??
    (await workspace.stores.tasks.create({
      title: truncate(request, 60),
      goal: request,
      project_id: workspace.project.id,
      session_id: sessionId,
    }));

  if (acted) {
    state.status = 'in_progress';
    if (state.pending.length === 0) addPending(state, truncate(request, 120));
  }
  if (/\b(done|finished|fixed|working now|that'?s it)\b/i.test(request)) {
    completePending(state, truncate(request, 120));
    if (state.pending.length === 0) state.status = 'done';
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

async function resolveModel(
  ctx: CommandContext,
  workspace: Workspace,
): Promise<{ provider: ChatProvider; model: ModelDescriptor } | undefined> {
  const providerId = typeof ctx.args.flags.provider === 'string' ? ctx.args.flags.provider : ctx.config.active_provider ?? workspace.project.default_model;
  const providerConfig =
    ctx.config.providers.find((p) => p.id === providerId && p.enabled) ?? ctx.config.providers.find((p) => p.enabled);
  if (!providerConfig) return undefined;
  const modelId = typeof ctx.args.flags.model === 'string' ? ctx.args.flags.model : ctx.config.active_model;
  const modelConfig = providerConfig.models.find((m) => m.id === modelId) ?? providerConfig.models[0];
  if (!modelConfig) return undefined;
  try {
    const provider = await createProvider(providerConfig, {});
    return { provider, model: modelDescriptor(providerConfig, modelConfig) };
  } catch (error) {
    ctx.ui.error(`Could not create the ${providerConfig.id} provider: ${describeError(error)}`);
    return undefined;
  }
}

async function safeEmbedder(ctx: CommandContext) {
  if (!ctx.config.embedding.enabled) return undefined;
  try {
    return await createEmbeddingClient(ctx.config);
  } catch (error) {
    ctx.ui.warn(`Embeddings unavailable (${describeError(error)}); falling back to keyword retrieval.`);
    return undefined;
  }
}

function printBanner(ctx: CommandContext, workspace: Workspace, model: ModelDescriptor, sessionId: string): void {
  const { ui } = ctx;
  ui.out('');
  ui.out(ui.bold(`Low Context ${VERSION}`));
  ui.out(ui.dim('─'.repeat(56)));
  ui.keyValue([
    ['Model', `${model.provider}/${model.id}`],
    ['Project', `${workspace.project.name}  ${ui.dim(workspace.root)}`],
    ['Strategy', ctx.config.context.strategy],
    ['Permissions', ctx.config.permissions.mode],
    ['Session', sessionId],
  ]);
  ui.out(ui.dim('─'.repeat(56)));
}
