/**
 * Command implementations (§30, §48, §49).
 *
 * Every handler shares one shape: build a context, do the work, print something
 * a human asked for, return an exit code. Handlers never call `process.exit`, so
 * they compose (doctor calls the same checks the individual commands use) and
 * are testable.
 *
 * Two rules run through the file:
 *  - output that answers the user's question goes through `ui.result`, so
 *    `--quiet` cannot hide it;
 *  - anything that mutates persistent state prints what changed, because the
 *    user owns their memory and index (§47, §65).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultConfig,
  globalConfigPath,
  mergeConfig,
  projectConfigPath,
  saveGlobalConfig,
  validateConfig,
  type LowContextConfig,
  type ProviderConfig,
  type ProviderKind,
} from '../core/config.js';
import { AgentEventLog, Logger, listLogFiles, pruneLogs, readLogTail } from '../core/logger.js';
import { globalPaths, projectPaths } from '../core/paths.js';
import { describeError } from '../core/errors.js';
import { atomicWrite, formatBytes, truncate } from '../core/util.js';
import { createEmbeddingClient, createProvider, listAllModels, modelDescriptor } from '../providers/registry.js';
import type { Workspace } from '../agent/workspace.js';
import { registryFromConfig } from '../tools/registry.js';
import { PermissionEngine } from '../tools/permissions.js';
import { buildDirectoryTree, renderModuleMap, renderProjectMap, renderFileMapEntry, renderTree, buildProjectMap } from '../index/project-map.js';
import { refreshProjectIndex, detectStale } from '../index/indexer.js';
import { redactString } from '../security/redact.js';
import { maskSecret, resolveSecret, deleteCredential } from '../security/secrets.js';
import { runAgentTurn } from './chat.js';
import { flagBool, flagNumber, flagString, type ParsedArgs } from './args.js';
import type { Ui } from './ui.js';
import type { MemoryRecord, PermissionMode } from '../core/types.js';
import * as git from '../git/git.js';

export interface CommandContext {
  args: ParsedArgs;
  ui: Ui;
  config: LowContextConfig;
  configSources: string[];
  logger: Logger;
  events: AgentEventLog;
  cwd: string;
  openWorkspace(options?: { refresh?: boolean }): Promise<Workspace>;
}

export type CommandHandler = (ctx: CommandContext) => Promise<number>;

/* ================================ help / version ============================ */

const HELP = `Low Context — retrieval-first AI coding CLI

  The agent does not hold your whole project in context. It keeps an index,
  retrieves what matters, verifies the real source, and updates its memory.

USAGE
  lc                              start an interactive session
  lc "fix the login bug"          one-shot request
  lc <command> [subcommand] [options]

CORE
  init                            configure a provider and model
  chat                            interactive session (same as no command)
  run "<request>"                 one-shot request, prints the answer
  plan "<request>"                ask for a plan without executing tools
  analyze [path]                  map a project and summarise its architecture
  status                          project, model, context and index summary

PROJECT
  index [status|refresh|rebuild|drop]
  map [tree|file <path>|module <name>]
  files [list|show <path>]
  search <query>                  search indexed files and symbols
  context [show]                  what would be sent to the model, and why

MEMORY
  memory list|search|show|forget|delete|supersede|rebuild|export|stats
  sessions list|resume|show|end|delete

CONFIGURATION
  providers list|add|remove|test|enable|disable
  models list|use|show|test
  config show|get|set|path|edit|reset
  permissions show|mode|allow|deny|reset
  tools list|show <name>
  logs list|tail|path|prune
  doctor                          diagnose the whole installation
  version                         print the version
  help [command]                  this help, or help for one command

COMMON OPTIONS
  --provider <id> --model <id>    override for one run
  --strategy minimal|balanced|deep|maximum
  --mode safe|ask|trusted         permission mode for this run
  --project <path>                operate on another project
  --quiet | --verbose | --debug   response detail
  --no-color                      disable ANSI colour
  --yes                           approve confirmations non-interactively
`;

const VERSION = '0.1.0';

/* ================================= helpers ================================= */

async function withWorkspace(ctx: CommandContext, options: { refresh?: boolean } = {}): Promise<Workspace> {
  return ctx.openWorkspace(options);
}

function describeIndexSources(ctx: CommandContext): string {
  return ctx.configSources.length === 0 ? '(defaults only)' : ctx.configSources.join(', ');
}

function requireOk(problems: readonly string[], ui: Ui): boolean {
  if (problems.length === 0) return true;
  ui.error('Configuration problems detected:');
  for (const problem of problems) ui.out(`  - ${problem}`);
  return false;
}

/* ================================== help ================================== */

const helpCommand: CommandHandler = async (ctx) => {
  const topic = ctx.args.positionals[0];
  if (!topic) {
    ctx.ui.result(HELP);
    return 0;
  }
  ctx.ui.result(topicHelp(topic) ?? HELP);
  return 0;
};

function topicHelp(topic: string): string | undefined {
  const topics: Record<string, string> = {
    memory: `memory — persistent, user-controlled project memory

  memory list [--scope <scope>] [--type <TYPE>] [--limit n]
  memory search <query> [--limit n]
  memory show <id>
  memory forget <query> [--limit n]      delete the best matches
  memory delete <id>
  memory rebuild                          rebuild the search index from records
  memory export [--out file.json]         write a JSON copy of every record
  memory stats                            counts by type, scope and importance

  Memory is external storage. It is never model training, and a memory is a
  summary — verify against the source before acting on it.`,
    index: `index — the project navigation index

  index status          what is indexed, and whether it is stale
  index refresh         incremental update of changed files
  index rebuild         full re-index (--force)
  index drop            remove this project's index

  The index is a map, not source. When the index and a file disagree, the file
  wins and the index is refreshed.`,
    context: `context — what the agent would send

  context show          the budget breakdown for the last/next request
  context explain       the retrieval trace: why each item was chosen

  Context is a limited working area, not a memory. Items that do not fit are
  listed as dropped, never silently omitted.`,
    providers: `providers — model backends

  providers list
  providers add --name <id> --kind openai|anthropic|gemini|local|custom|mock [--base-url URL]
  providers test <id>
  providers remove <id>`,
    models: `models — model selection

  models list [--provider <id>]
  models use <model-id> [--provider <id>]
  models show
  models test [--model <id>]`,
    permissions: `permissions — terminal and filesystem safety

  permissions show
  permissions mode safe|ask|trusted
  permissions allow <rule>        e.g. "command:git *" or "path:src/**"
  permissions deny <rule>
  permissions reset

  Deny rules always beat allow rules, and a project config can only tighten,
  never loosen, the policy.`,
  };
  return topics[topic];
}

/* ================================= version ================================= */

const versionCommand: CommandHandler = async (ctx) => {
  ctx.ui.result(`low-context ${VERSION}`);
  ctx.ui.out(`node ${process.version} · ${process.platform} ${process.arch}`);
  ctx.ui.out(`home ${globalPaths().home}`);
  return 0;
};

/* ================================== init =================================== */

async function providersCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui, config } = ctx;
  switch (sub) {
    case 'list':
    case '': {
      const rows = config.providers.map((provider) => [
        provider.id,
        provider.kind,
        provider.enabled ? 'enabled' : 'disabled',
        provider.api_key_env ?? provider.api_key_ref ?? '(none)',
        String(provider.models.length),
      ]);
      ui.heading('Providers');
      ui.table(['id', 'kind', 'state', 'credential', 'models'], rows);
      const active = config.active_provider ?? '(none)';
      ui.out('');
      ui.out(`Active provider: ${active}`);
      return 0;
    }
    case 'add': {
      const name = flagString(ctx.args.flags, 'name') ?? ctx.args.positionals[0];
      const kind = (flagString(ctx.args.flags, 'kind') ?? 'openai') as ProviderKind;
      if (!name) {
        ui.error('providers add requires --name <id>');
        return 2;
      }
      if (!['openai', 'anthropic', 'gemini', 'local', 'custom', 'mock'].includes(kind)) {
        ui.error(`unknown provider kind: ${kind}`);
        return 2;
      }
      const baseUrl = flagString(ctx.args.flags, 'base-url');
      const provider: ProviderConfig = {
        id: name,
        kind,
        label: name,
        enabled: true,
        ...(baseUrl === undefined ? {} : { base_url: baseUrl }),
        api_key_env: `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`,
        api_key_ref: `providers.${name}.api_key`,
        models: [{ id: flagString(ctx.args.flags, 'model') ?? 'default' }],
      };
      const next = { ...config, providers: [...config.providers.filter((p) => p.id !== name), provider] };
      await saveGlobalConfig(next);
      ui.success(`Added provider "${name}" (${kind}).`);
      ui.out(`Set ${provider.api_key_env} in your environment, or run: lc providers test ${name}`);
      return 0;
    }
    case 'remove': {
      const name = ctx.args.positionals[0];
      if (!name) {
        ui.error('providers remove requires a provider id');
        return 2;
      }
      const next = { ...config, providers: config.providers.filter((p) => p.id !== name) };
      if (next.active_provider === name) next.active_provider = undefined;
      await saveGlobalConfig(next);
      await deleteCredential(`providers.${name}.api_key`);
      ui.success(`Removed provider "${name}".`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      const name = ctx.args.positionals[0];
      if (!name) {
        ui.error(`providers ${sub} requires a provider id`);
        return 2;
      }
      const next = {
        ...config,
        providers: config.providers.map((p) => (p.id === name ? { ...p, enabled: sub === 'enable' } : p)),
      };
      await saveGlobalConfig(next);
      ui.success(`Provider "${name}" ${sub}d.`);
      return 0;
    }
    case 'test': {
      const name = ctx.args.positionals[0] ?? config.active_provider;
      const provider = config.providers.find((p) => p.id === name);
      if (!provider) {
        ui.error(`Unknown provider: ${name ?? '(none configured)'}`);
        return 2;
      }
      const secret = await resolveSecret(provider.api_key_ref, provider.api_key_env ? [provider.api_key_env] : []);
      ui.info(`credential: ${maskSecret(secret)}`);
      if (provider.kind !== 'mock' && provider.kind !== 'local' && !secret) {
        ui.error(`No credential found. Set ${provider.api_key_env} or run \`lc config set providers.${provider.id}.api_key\`.`);
        return 1;
      }
      try {
        const client = await createProvider(provider, {});
        const models = await client.listModels();
        ui.success(`Provider "${provider.id}" reachable. ${models.length} model(s) known.`);
        return 0;
      } catch (error) {
        ui.error(`Provider check failed: ${describeError(error)}`);
        return 1;
      }
    }
    default:
      ui.error(`Unknown providers subcommand: ${sub}`);
      return 2;
  }
}

async function modelsCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui, config } = ctx;
  switch (sub) {
    case 'list':
    case '': {
      const filter = flagString(ctx.args.flags, 'provider');
      const rows = listAllModels(config)
        .filter((model) => filter === undefined || model.provider === filter)
        .map((model) => [
          model.provider,
          model.id,
          `${Math.round(model.context_limit / 1000)}k`,
          String(model.max_output),
          model.capabilities.tool_calling ? 'tools' : '-',
          model.capabilities.reasoning ? 'reasoning' : '-',
        ]);
      ui.heading('Models');
      ui.table(['provider', 'model', 'context', 'max out', 'capabilities', ''], rows);
      return 0;
    }
    case 'use': {
      const model = ctx.args.positionals[0] ?? flagString(ctx.args.flags, 'model');
      if (!model) {
        ui.error('models use requires a model id');
        return 2;
      }
      const providerId = flagString(ctx.args.flags, 'provider') ?? config.active_provider ?? config.providers[0]?.id;
      const provider = config.providers.find((p) => p.id === providerId);
      if (!provider) {
        ui.error(`Unknown provider: ${providerId}`);
        return 2;
      }
      const next = { ...config, active_provider: provider.id, active_model: model };
      await saveGlobalConfig(next);
      ui.success(`Active model: ${provider.id}/${model}`);
      return 0;
    }
    case 'show': {
      const active = config.active_provider ? config.providers.find((p) => p.id === config.active_provider) : undefined;
      ui.heading('Active model');
      ui.keyValue([
        ['provider', config.active_provider ?? '(unset)'],
        ['model', config.active_model ?? '(unset)'],
        ['fallback provider', config.fallback_provider ?? '(none)'],
        ['fallback model', config.fallback_model ?? '(none)'],
        ['context limit', String(active?.models.find((m) => m.id === config.active_model)?.context_limit ?? '(unknown)')],
      ]);
      return 0;
    }
    case 'test': {
      const providerId = flagString(ctx.args.flags, 'provider') ?? config.active_provider;
      const provider = config.providers.find((p) => p.id === providerId);
      if (!provider) {
        ui.error('No provider selected.');
        return 2;
      }
      const model = flagString(ctx.args.flags, 'model') ?? config.active_model ?? provider.models[0]?.id;
      if (!model) {
        ui.error('No model selected.');
        return 2;
      }
      try {
        const client = await createProvider(provider, {});
        ctx.ui.info('Sending a one-token probe...');
        let text = '';
        for await (const event of client.generate({
          model,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          max_output_tokens: 16,
        })) {
          if (event.type === 'text') text += event.text;
        }
        ui.success(`Model responded: ${truncate(text.trim() || '(empty)', 120)}`);
        return 0;
      } catch (error) {
        ui.error(`Model test failed: ${describeError(error)}`);
        return 1;
      }
    }
    default:
      ui.error(`Unknown models subcommand: ${sub}`);
      return 2;
  }
}

/* ================================== index ================================== */

async function indexCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const effective = sub === '' ? 'status' : sub;
  if (effective === 'drop') {
    const workspace = await withWorkspace(ctx);
    await workspace.stores.index.dropProject(workspace.project.id);
    await workspace.flush();
    ui.success('Dropped the index for this project. Run `lc index refresh` to rebuild it.');
    return 0;
  }

  const workspace = await withWorkspace(ctx, { refresh: false });
  const projectId = workspace.project.id;

  if (effective === 'status') {
    const files = await workspace.stores.index.listFiles(projectId);
    const modules = await workspace.stores.index.listModules(projectId);
    const stale = await detectStale(workspace.root, files);
    ui.heading('Index status');
    ui.keyValue([
      ['project', workspace.project.name],
      ['root', workspace.root],
      ['files', String(files.length)],
      ['modules', String(modules.length)],
      ['symbols', String(files.reduce((n, f) => n + f.symbols.length, 0))],
      ['languages', [...new Set(files.map((f) => f.language))].slice(0, 8).join(', ') || '(none)'],
      ['stale files', stale.length === 0 ? 'none' : `${stale.length} (${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', …' : ''})`],
    ]);
    if (stale.length > 0) ui.warn(`The index is behind the working tree. Run \`lc index refresh\` before relying on it.`);
    return 0;
  }

  if (effective === 'refresh' || effective === 'rebuild') {
    const force = effective === 'rebuild' || flagBool(ctx.args.flags, 'force');
    ui.info(force ? 'Rebuilding the index (full scan)...' : 'Refreshing the index (changed files only)...');
    const result = await refreshProjectIndex({
      root: workspace.root,
      projectId,
      store: workspace.stores.index,
      maxFileBytes: workspace.config.index.max_file_bytes,
      followSymlinks: workspace.config.index.follow_symlinks,
      extraIgnore: workspace.config.index.extra_ignore,
      force,
      onProgress: ({ done, total, path }) => ui.updateSpinner(`indexing ${done}/${total} ${path ?? ''}`),
    });
    ui.stopSpinner();
    ui.success(`Indexed ${result.scanned} file(s) in ${result.duration_ms} ms.`);
    ui.keyValue([
      ['added', String(result.added)],
      ['changed', String(result.changed)],
      ['removed', String(result.removed)],
      ['skipped', `${result.skipped} (too large or binary)`],
      ['modules', String(result.modules)],
    ]);
    return 0;
  }

  ui.error(`Unknown index subcommand: ${effective}`);
  return 2;
}

/* =================================== map =================================== */

async function mapCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const workspace = await withWorkspace(ctx);
  const files = await workspace.stores.index.listFiles(workspace.project.id);
  const modules = await workspace.stores.index.listModules(workspace.project.id);
  if (files.length === 0) {
    ui.warn('No index yet. Run `lc index refresh` first.');
    return 1;
  }
  const map = buildProjectMap(workspace.root, files, modules);
  const depth = flagNumber(ctx.args.flags, 'depth') ?? 3;

  if (sub === 'file') {
    const path = ctx.args.positionals[0];
    if (!path) {
      ui.error('map file requires a path');
      return 2;
    }
    const file = files.find((f) => f.path === path) ?? files.find((f) => f.path.endsWith(`/${path}`));
    if (!file) {
      ui.error(`Not indexed: ${path}`);
      return 1;
    }
    ui.result(renderFileMapEntry(file));
    return 0;
  }

  if (sub === 'module') {
    const name = ctx.args.positionals[0];
    if (!name) {
      ui.error('map module requires a name');
      return 2;
    }
    ui.result(renderModuleMap(map, name, { maxDepth: depth, maxFiles: 400 }));
    return 0;
  }

  if (sub === 'tree') {
    const tree = buildDirectoryTree(files.map((f) => f.path));
    ui.result(renderTree(tree, { maxDepth: depth, maxFiles: 400 }));
    return 0;
  }

  ui.result(renderProjectMap(map, { maxDepth: depth }));
  ui.out('');
  ui.out(ui.dim('This is a navigation index. Read a file before changing it — the source wins over the index.'));
  return 0;
}

async function filesCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const workspace = await withWorkspace(ctx);
  const files = await workspace.stores.index.listFiles(workspace.project.id);
  if (sub === 'show') {
    const path = ctx.args.positionals[0];
    if (!path) {
      ui.error('files show requires a path');
      return 2;
    }
    const file = files.find((f) => f.path === path);
    if (!file) {
      ui.error(`Not indexed: ${path}`);
      return 1;
    }
    ui.result(renderFileMapEntry(file));
    return 0;
  }
  const rows = files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, flagNumber(ctx.args.flags, 'limit') ?? 200)
    .map((file) => [file.path, file.language, String(file.symbols.length), formatBytes(file.size), file.verification_state]);
  ui.heading(`Indexed files (${files.length})`);
  ui.table(['path', 'language', 'symbols', 'size', 'state'], rows);
  return 0;
}

async function searchCommand(ctx: CommandContext): Promise<number> {
  const { ui } = ctx;
  const query = ctx.args.positionals.join(' ') || ctx.args.rest;
  if (query.trim() === '') {
    ui.error('search requires a query');
    return 2;
  }
  const workspace = await withWorkspace(ctx);
  const limit = flagNumber(ctx.args.flags, 'limit') ?? 15;
  const fileHits = await workspace.stores.index.searchFiles(workspace.project.id, query, limit);
  const symbolHits = await workspace.stores.index.findSymbol(workspace.project.id, query, limit);
  const memoryHits = await workspace.stores.memory.search({ text: query, limit: 5, project_id: workspace.project.id });

  ui.heading(`Search: ${query}`);
  ui.out(ui.bold('Files'));
  ui.table(
    ['score', 'path', 'state', 'matched'],
    fileHits.map((hit) => [hit.score.toFixed(2), hit.file.path, hit.file.verification_state, hit.matched.join(', ')]),
  );
  if (symbolHits.length > 0) {
    ui.out('');
    ui.out(ui.bold('Symbols'));
    ui.table(['score', 'symbol', 'file'], symbolHits.map((hit) => [hit.score.toFixed(2), hit.symbol, hit.file.path]));
  }
  if (memoryHits.length > 0) {
    ui.out('');
    ui.out(ui.bold('Memory'));
    ui.table(
      ['score', 'id', 'type', 'summary'],
      memoryHits.map((hit) => [hit.score.toFixed(2), hit.record.id, hit.record.type, truncate(hit.record.summary, 70)]),
    );
  }
  if (fileHits.length === 0 && symbolHits.length === 0 && memoryHits.length === 0) {
    ui.warn('Nothing matched. Try `lc index refresh` if the project changed recently.');
  }
  return 0;
}

/* ================================= memory ================================== */

async function memoryCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui, config } = ctx;
  const workspace = await withWorkspace(ctx);
  const store = workspace.stores.memory;
  const projectId = workspace.project.id;
  const effective = sub === '' ? 'list' : sub;

  switch (effective) {
    case 'list': {
      const limit = flagNumber(ctx.args.flags, 'limit') ?? 40;
      const records = await store.list({
        project_id: flagBool(ctx.args.flags, 'all') ? undefined : projectId,
        limit,
        include_superseded: flagBool(ctx.args.flags, 'include-superseded'),
      });
      ui.heading(`Memory (${records.length} shown)`);
      ui.table(
        ['id', 'type', 'scope', 'importance', 'updated', 'summary'],
        records.map((record) => [
          record.id,
          record.type,
          record.scope,
          record.importance,
          record.updated_at.slice(0, 10),
          truncate(record.summary, 64),
        ]),
      );
      ui.out('');
      ui.out(ui.dim(`Storage: ${join(projectPaths(workspace.root, { local: config.storage.project_local }).dir, 'memory')}`));
      return 0;
    }
    case 'search': {
      const query = ctx.args.positionals.join(' ');
      if (query === '') {
        ui.error('memory search requires a query');
        return 2;
      }
      const hits = await store.search({ text: query, limit: flagNumber(ctx.args.flags, 'limit') ?? 10, project_id: projectId });
      if (hits.length === 0) {
        ui.warn(`No memory records match "${query}".`);
        return 1;
      }
      for (const hit of hits) {
        ui.result(`${hit.score.toFixed(2)}  ${hit.record.id}  ${hit.record.type}/${hit.record.confidence}`);
        ui.result(`      ${truncate(hit.record.summary, 110)}`);
        ui.result(ui.dim(`      ${hit.reason}`));
      }
      return 0;
    }
    case 'show': {
      const id = ctx.args.positionals[0];
      if (!id) {
        ui.error('memory show requires an id');
        return 2;
      }
      const record = await store.get(id);
      if (!record) {
        ui.error(`No memory record: ${id}`);
        return 1;
      }
      renderMemoryRecord(ui, record);

      // Provenance is only useful if it is one command away (§8, §50): fetch the
      // original messages the record cites.
      if (flagBool(ctx.args.flags, 'source')) {
        const messageRefs = record.source_refs.filter((ref) => ref.kind === 'message' && ref.message_id !== undefined);
        if (messageRefs.length === 0) {
          ui.warn('This record has no message references to show.');
        } else {
          ui.out('');
          ui.out(ui.bold('Source messages'));
          const byConversation = new Map<string, string[]>();
          for (const ref of messageRefs) {
            const ids = byConversation.get(ref.conversation_id ?? '') ?? [];
            if (ref.message_id) ids.push(ref.message_id);
            byConversation.set(ref.conversation_id ?? '', ids);
          }
          for (const [conversationId, messageIds] of byConversation) {
            const messages = await workspace.stores.conversations.messagesByIds(messageIds);
            ui.out(ui.dim(`conversation ${conversationId}`));
            for (const message of messages) {
              ui.out(`  ${message.id}  ${message.role}  ${message.timestamp}`);
              ui.out(ui.dim(`    ${truncate(message.content.replace(/\s+/g, ' '), 200)}`));
            }
          }
        }
      }

      // Corrections keep both records: show the chain (§11).
      if (flagBool(ctx.args.flags, 'history')) {
        const chain: MemoryRecord[] = [];
        const supersededIds = record.supersedes ?? [];
        for (const oldId of supersededIds) {
          const old = await store.get(oldId);
          if (old) chain.push(old);
        }
        const newer = record.superseded_by ? await store.get(record.superseded_by) : undefined;
        if (chain.length > 0 || newer) {
          ui.out('');
          ui.out(ui.bold('Correction history'));
          for (const old of [...chain].reverse()) {
            ui.out(`  ← ${old.id}  ${old.status}  ${truncate(old.summary, 80)}`);
          }
          ui.out(`  • ${record.id}  ${record.status}  ${truncate(record.summary, 80)}`);
          if (newer) ui.out(`  → ${newer.id}  ${newer.status}  ${truncate(newer.summary, 80)}`);
        } else {
          ui.out('');
          ui.out(ui.dim('No corrections recorded for this record.'));
        }
      }
      return 0;
    }
    case 'supersede': {
      const oldId = ctx.args.positionals[0];
      const newId = ctx.args.positionals[1];
      if (!oldId || !newId) {
        ui.error('memory supersede requires: lc memory supersede OLD_ID --with NEW_ID');
        ui.error('  or:               lc memory supersede OLD_ID "Corrected summary text"');
        return 2;
      }
      const old = await store.get(oldId);
      if (!old) {
        ui.error(`No memory record: ${oldId}`);
        return 1;
      }
      // Either point at an existing replacement record, or create one from text.
      const withFlag = flagString(ctx.args.flags, 'with');
      const replacementText = flagString(ctx.args.flags, 'text') ?? (newId !== oldId && !newId.startsWith('mem_') ? ctx.args.positionals.slice(1).join(' ') : undefined);
      let replacementId = withFlag ?? (replacementText === undefined ? newId : undefined);
      if (replacementId && (await store.get(replacementId)) === undefined) {
        ui.error(`No replacement record: ${replacementId}`);
        return 1;
      }
      if (!replacementId) {
        if (!replacementText || replacementText.trim() === '') {
          ui.error('Provide an existing record id, --with <id>, or the corrected text.');
          return 2;
        }
        const created = await store.write({
          type: old.type,
          scope: old.scope,
          summary: replacementText.replace(/\s+/g, ' ').trim(),
          detail: old.detail,
          tags: [...old.tags, 'correction'],
          // The correction is verified only insofar as the user verified it (§35).
          confidence: 'high',
          importance: old.importance,
          project_id: old.project_id,
          session_id: old.session_id,
          task_id: old.task_id,
          module_path: old.module_path,
          supersedes: old.id,
          source_refs: old.source_refs.slice(0, 3),
        });
        replacementId = created.id;
      } else {
        await store.supersede(oldId, replacementId);
      }
      const replacement = await store.get(replacementId);
      ui.success(`Superseded ${oldId} → ${replacementId}`);
      if (replacement) ui.out(`  ${truncate(replacement.summary, 100)}`);
      return 0;
    }
    case 'delete': {
      const id = ctx.args.positionals[0];
      if (!id) {
        ui.error('memory delete requires an id');
        return 2;
      }
      const ok = await store.delete(id);
      if (ok) ui.success(`Deleted ${id}.`);
      else ui.error(`No such record: ${id}`);
      return ok ? 0 : 1;
    }
    case 'forget': {
      const query = ctx.args.positionals.join(' ');
      if (query === '') {
        ui.error('memory forget requires a query');
        return 2;
      }
      const hits = await store.search({ text: query, limit: flagNumber(ctx.args.flags, 'limit') ?? 10, project_id: projectId });
      if (hits.length === 0) {
        ui.warn('Nothing matched; nothing deleted.');
        return 1;
      }
      ui.out('About to delete:');
      for (const hit of hits) ui.out(`  ${hit.record.id}  ${truncate(hit.record.summary, 80)}`);
      const approved = flagBool(ctx.args.flags, 'yes') || (await ui.confirm(`Delete ${hits.length} record(s)?`, { defaultYes: false }));
      if (!approved) {
        ui.info('Cancelled.');
        return 1;
      }
      let deleted = 0;
      for (const hit of hits) if (await store.delete(hit.record.id)) deleted += 1;
      ui.success(`Deleted ${deleted} record(s).`);
      return 0;
    }
    case 'rebuild': {
      const result = await store.rebuild();
      ui.success(`Rebuilt the memory search index over ${result.records} record(s) in ${result.duration_ms} ms.`);
      return 0;
    }
    case 'export': {
      const records = await store.export({ project_id: flagBool(ctx.args.flags, 'all') ? undefined : projectId });
      const out = flagString(ctx.args.flags, 'out') ?? `${workspace.root}/.low-context/memory-export.json`;
      await atomicWrite(out, `${JSON.stringify({ exported_at: new Date().toISOString(), records }, null, 2)}\n`);
      ui.success(`Exported ${records.length} record(s) to ${out}`);
      return 0;
    }
    case 'stats': {
      const records = await store.list({ project_id: projectId, limit: 10_000, include_superseded: true });
      const byType = new Map<string, number>();
      const byScope = new Map<string, number>();
      const byImportance = new Map<string, number>();
      for (const record of records) {
        byType.set(record.type, (byType.get(record.type) ?? 0) + 1);
        byScope.set(record.scope, (byScope.get(record.scope) ?? 0) + 1);
        byImportance.set(record.importance, (byImportance.get(record.importance) ?? 0) + 1);
      }
      ui.heading('Memory statistics');
      ui.out(`total records: ${records.length}`);
      ui.out(ui.bold('by type'));
      ui.table(['type', 'count'], [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]));
      ui.out(ui.bold('by scope'));
      ui.table(['scope', 'count'], [...byScope.entries()].map(([k, v]) => [k, String(v)]));
      ui.out(ui.bold('by importance'));
      ui.table(['importance', 'count'], [...byImportance.entries()].map(([k, v]) => [k, String(v)]));
      return 0;
    }
    default:
      ui.error(`Unknown memory subcommand: ${effective}`);
      return 2;
  }
}

function renderMemoryRecord(ui: Ui, record: MemoryRecord): void {
  ui.heading(`Memory ${record.id}`);
  ui.keyValue([
    ['type', record.type],
    ['scope', record.scope],
    ['project', record.project_id ?? '(none)'],
    ['importance', record.importance],
    ['confidence', record.confidence],
    ['status', record.status],
    ['verification', record.verification_state],
    ['created', record.created_at],
    ['updated', record.updated_at],
    ['accessed', `${record.access_count} time(s)`],
  ]);
  ui.out('');
  ui.out(record.summary);
  if (record.detail) ui.out(record.detail);
  if (record.source_refs.length > 0) {
    ui.out('');
    ui.out(ui.bold('Sources (retrieve the original before relying on this)'));
    for (const ref of record.source_refs) {
      ui.out(`  ${ref.kind}${ref.file_path ? ` file=${ref.file_path}` : ''}${ref.message_id ? ` message=${ref.message_id}` : ''}${ref.commit ? ` commit=${ref.commit}` : ''}`);
    }
  } else {
    ui.out('');
    ui.warn('No source reference recorded. Treat this as unverified.');
  }
}

/* ================================= sessions ================================ */

async function sessionsCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const workspace = await withWorkspace(ctx);
  const store = workspace.stores.sessions;
  switch (sub) {
    case 'list':
    case '': {
      const sessions = await store.list({ limit: flagNumber(ctx.args.flags, 'limit') ?? 20 });
      ui.heading('Sessions');
      ui.table(
        ['id', 'status', 'model', 'messages', 'updated', 'title'],
        sessions.map((session) => [
          session.id,
          session.status,
          session.model ?? '-',
          String(session.message_count),
          session.updated_at.slice(0, 16).replace('T', ' '),
          session.title ?? '(untitled)',
        ]),
      );
      return 0;
    }
    case 'show': {
      const id = ctx.args.positionals[0];
      const session = id ? await store.resolve(id) : await store.latest(workspace.project.id);
      if (!session) {
        ui.error('No such session.');
        return 1;
      }
      ui.heading(`Session ${session.id}`);
      ui.keyValue([
        ['status', session.status],
        ['project', session.project_root ?? '-'],
        ['model', `${session.provider ?? '-'}/${session.model ?? '-'}`],
        ['messages', String(session.message_count)],
        ['created', session.created_at],
        ['updated', session.updated_at],
      ]);
      if (session.task_state) {
        ui.out('');
        ui.out(ui.bold('Task state (restored without replaying history)'));
        ui.keyValue([
          ['title', session.task_state.title],
          ['goal', session.task_state.goal],
          ['status', session.task_state.status],
          ['pending', session.task_state.pending.join('; ') || '(none)'],
          ['files', session.task_state.relevant_files.slice(0, 8).join(', ') || '(none)'],
        ]);
      }
      return 0;
    }
    case 'end': {
      const id = ctx.args.positionals[0];
      const session = id ? await store.resolve(id) : await store.latest(workspace.project.id);
      if (!session) {
        ui.error('No active session.');
        return 1;
      }
      await store.end(session.id);
      ui.success(`Ended session ${session.id}.`);
      return 0;
    }
    case 'delete': {
      const id = ctx.args.positionals[0];
      if (!id) {
        ui.error('sessions delete requires an id');
        return 2;
      }
      const ok = await store.delete(id);
      ui.success(ok ? `Deleted session ${id}.` : 'No such session.');
      return ok ? 0 : 1;
    }
    case 'resume': {
      const id = ctx.args.positionals[0];
      const session = id ? await store.resolve(id) : await store.latest(workspace.project.id);
      if (!session) {
        ui.error('No session to resume. Run `lc sessions list`.');
        return 1;
      }
      ui.info(`Resuming ${session.id}. History stays on disk; only the task state and a summary are loaded.`);
      const { runInteractive } = await import('./chat.js');
      return runInteractive({ ...ctx, resumeSessionId: session.id });
    }
    default:
      ui.error(`Unknown sessions subcommand: ${sub}`);
      return 2;
  }
}

/* ================================== config ================================ */

function getPathValue(object: unknown, path: string): unknown {
  let current: unknown = object;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function configCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const effective = sub === '' ? 'show' : sub;
  switch (effective) {
    case 'show': {
      ui.heading('Configuration');
      ui.keyValue([
        ['global file', globalConfigPath()],
        ['project file', projectConfigPath(ctx.cwd, ctx.config.storage.project_local)],
        ['sources', describeIndexSources(ctx)],
      ]);
      ui.out('');
      ui.result(redactConfig(ctx.config));
      return 0;
    }
    case 'path': {
      ui.result(globalConfigPath());
      return 0;
    }
    case 'get': {
      const key = ctx.args.positionals[0];
      if (!key) {
        ui.error('config get requires a key, e.g. `config get retrieval.top_k`');
        return 2;
      }
      const value = getPathValue(ctx.config, key);
      ui.result(value === undefined ? '(unset)' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      return 0;
    }
    case 'set': {
      const [key, ...rest] = ctx.args.positionals;
      const raw = rest.join(' ') || flagString(ctx.args.flags, 'value');
      if (!key || raw === undefined) {
        ui.error('config set requires <key> <value>');
        return 2;
      }
      const patch = buildPatch(key, raw);
      const merged = mergeConfig(ctx.config, patch);
      const problems = validateConfig(merged);
      if (problems.length > 0 && !requireOk(problems, ui)) return 2;
      await saveGlobalConfig(stripRuntimeConfig(merged));
      ui.success(`Set ${key} = ${raw}`);
      return 0;
    }
    case 'reset': {
      const approved = flagBool(ctx.args.flags, 'yes') || (await ui.confirm('Reset the global config to defaults?', { defaultYes: false }));
      if (!approved) {
        ui.info('Cancelled.');
        return 1;
      }
      await saveGlobalConfig(defaultConfig());
      ui.success('Global config reset to defaults.');
      return 0;
    }
    case 'edit': {
      ui.result(`${globalConfigPath()}`);
      ui.info('Open that file in your editor. Low Context re-reads it on every run.');
      return 0;
    }
    default:
      ui.error(`Unknown config subcommand: ${effective}`);
      return 2;
  }
}

function buildPatch(key: string, raw: string): Record<string, unknown> {
  const parts = key.split('.');
  let value: unknown = /^-?\d+$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw;
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      value = JSON.parse(raw);
    } catch {
      // Keep the raw string; validation will catch nonsense.
    }
  }
  const out: Record<string, unknown> = {};
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    const next: Record<string, unknown> = {};
    cursor[part] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1] as string] = value;
  return out;
}

/** Remove runtime-only fields so the saved config never contains resolved paths. */
function stripRuntimeConfig(config: LowContextConfig): LowContextConfig {
  return { ...config, providers: config.providers.map((provider) => ({ ...provider })) };
}

function redactConfig(config: LowContextConfig): string {
  return redactString(JSON.stringify(config, null, 2));
}

/* =============================== permissions ============================== */

async function permissionsCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui, config } = ctx;
  const effective = sub === '' ? 'show' : sub;
  switch (effective) {
    case 'show': {
      const engine = new PermissionEngine({
        mode: config.permissions.mode,
        allow: config.permissions.allow,
        deny: config.permissions.deny,
        allow_outside_project: config.permissions.allow_outside_project,
        require_confirmation_for_destructive: config.permissions.require_confirmation_for_destructive,
      });
      ui.heading('Permissions');
      ui.keyValue([
        ['mode', config.permissions.mode],
        ['outside project', config.permissions.allow_outside_project ? 'allowed' : 'blocked'],
        ['command timeout', `${config.permissions.timeout_ms} ms`],
        ['output cap', formatBytes(config.permissions.max_output_bytes)],
        ['allow rules', config.permissions.allow.join(', ') || '(none)'],
        ['deny rules', config.permissions.deny.join(', ') || '(none)'],
      ]);
      ui.out('');
      ui.out(ui.dim('Deny beats allow. A project config can tighten but never loosen this.'));
      const probe = engine.decide({ summary: 'probe', resource: 'command', subject: 'rm -rf /', destructive: true });
      ui.out(`  sample catastrophic command → ${probe.allowed ? 'ALLOWED (rule)' : 'refused'}${probe.rule ? ` by ${probe.rule}` : ''}`);
      return 0;
    }
    case 'mode': {
      const mode = ctx.args.positionals[0] as PermissionMode | undefined;
      if (!mode || !['safe', 'ask', 'trusted'].includes(mode)) {
        ui.error('permissions mode requires one of: safe, ask, trusted');
        return 2;
      }
      await saveGlobalConfig({ ...config, permissions: { ...config.permissions, mode } });
      ui.success(`Permission mode set to "${mode}".`);
      return 0;
    }
    case 'allow':
    case 'deny': {
      const rule = ctx.args.positionals.join(' ');
      if (rule === '') {
        ui.error(`permissions ${effective} requires a rule, e.g. "command:git *"`);
        return 2;
      }
      const list = effective === 'allow' ? [...config.permissions.allow, rule] : [...config.permissions.deny, rule];
      await saveGlobalConfig({
        ...config,
        permissions: {
          ...config.permissions,
          allow: effective === 'allow' ? list : config.permissions.allow,
          deny: effective === 'deny' ? list : config.permissions.deny,
        },
      });
      ui.success(`Added ${effective} rule: ${rule}`);
      return 0;
    }
    case 'reset': {
      await saveGlobalConfig({ ...config, permissions: defaultConfig().permissions });
      ui.success('Permission rules reset to defaults.');
      return 0;
    }
    default:
      ui.error(`Unknown permissions subcommand: ${effective}`);
      return 2;
  }
}

/* ================================== tools ================================= */

async function toolsCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui, config } = ctx;
  const registry = registryFromConfig(config);
  if (sub === 'show') {
    const name = ctx.args.positionals[0];
    const tool = name ? registry.get(name) : undefined;
    if (!tool) {
      ui.error(`Unknown tool: ${name ?? '(none)'}`);
      return 1;
    }
    ui.heading(`Tool ${tool.name}`);
    ui.keyValue([
      ['category', tool.category],
      ['mutating', tool.mutating ? 'yes' : 'no'],
      ['enabled', registry.isEnabled(tool.name) ? 'yes' : 'no'],
    ]);
    ui.out('');
    ui.out(tool.description);
    ui.out('');
    ui.out(ui.bold('Parameters'));
    ui.result(JSON.stringify(tool.parameters, null, 2));
    return 0;
  }
  ui.heading('Tools');
  ui.table(
    ['name', 'category', 'mutating', 'enabled', 'purpose'],
    registry.list().map((tool) => [tool.name, tool.category, tool.mutating ? 'yes' : 'no', 'yes', truncate(tool.description, 60)]),
  );
  return 0;
}

/* ================================== logs ================================== */

async function logsCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const dir = globalPaths().logs;
  const effective = sub === '' ? 'list' : sub;
  switch (effective) {
    case 'list': {
      const files = await listLogFiles(dir);
      ui.heading('Log files');
      ui.table(['file', 'size', 'modified'], files.map((file) => [file.path, formatBytes(file.bytes), file.modified_at.slice(0, 19).replace('T', ' ')]));
      if (files.length === 0) ui.info('No logs yet. Run a request first.');
      return 0;
    }
    case 'path':
      ui.result(dir);
      return 0;
    case 'tail': {
      const files = await listLogFiles(dir);
      const latest = files[0];
      if (!latest) {
        ui.warn('No log files yet.');
        return 1;
      }
      const lines = await readLogTail(latest.path, flagNumber(ctx.args.flags, 'limit') ?? 40);
      ui.heading(`Tail of ${latest.path}`);
      for (const entry of lines) {
        ui.out(`${entry.at.slice(11, 19)} ${entry.level.padEnd(5)} ${entry.event}${entry.data ? ` ${truncate(JSON.stringify(entry.data), 140)}` : ''}`);
      }
      return 0;
    }
    case 'prune': {
      const days = flagNumber(ctx.args.flags, 'since') ?? 14;
      const removed = await pruneLogs(days, dir);
      ui.success(`Removed ${removed} log file(s) older than ${days} day(s).`);
      return 0;
    }
    default:
      ui.error(`Unknown logs subcommand: ${effective}`);
      return 2;
  }
}

/* ================================== status ================================ */

async function statusCommand(ctx: CommandContext): Promise<number> {
  const { ui } = ctx;
  const workspace = await withWorkspace(ctx);
  const provider = ctx.config.providers.find((p) => p.id === ctx.config.active_provider);
  const model = provider?.models.find((m) => m.id === ctx.config.active_model) ?? provider?.models[0];
  const files = await workspace.stores.index.listFiles(workspace.project.id);
  const memoryCount = await workspace.stores.memory.count({ project_id: workspace.project.id });
  const sessions = await workspace.stores.sessions.list({ project_id: workspace.project.id, limit: 5 });
  const branch = (await git.isGitRepo(workspace.root)) ? await git.shortStatusSummary(workspace.root) : 'not a git repository';

  ui.heading('Low Context');
  ui.keyValue([
    ['project', `${workspace.project.name} (${workspace.root})`],
    ['model', provider && model ? `${provider.id}/${model.id}` : '(not configured — run `lc init`)'],
    ['context strategy', ctx.config.context.strategy],
    ['permission mode', ctx.config.permissions.mode],
    ['indexed files', String(files.length)],
    ['memory records', String(memoryCount)],
    ['git', branch],
    ['state dir', projectPaths(workspace.root, { local: ctx.config.storage.project_local }).dir],
    ['sessions', sessions.length > 0 ? sessions.map((s) => s.id).join(', ') : '(none)'],
  ]);
  return 0;
}

/* ================================== doctor ================================ */

interface Check {
  name: string;
  status: 'OK' | 'WARN' | 'FAIL';
  detail: string;
  fix?: string;
}

async function doctorCommand(ctx: CommandContext): Promise<number> {
  const { ui, config } = ctx;
  const checks: Check[] = [];

  checks.push({ name: 'CLI', status: 'OK', detail: `low-context ${VERSION} on node ${process.version}` });

  const problems = validateConfig(config);
  checks.push(
    problems.length === 0
      ? { name: 'Config', status: 'OK', detail: `loaded from ${describeIndexSources(ctx)}` }
      : { name: 'Config', status: 'FAIL', detail: problems.join('; '), fix: `Run \`lc config reset\` or edit ${globalConfigPath()}` },
  );

  const provider = config.providers.find((p) => p.id === config.active_provider);
  if (!provider) {
    checks.push({ name: 'Provider', status: 'FAIL', detail: 'no active provider', fix: 'Run `lc init` or `lc providers list`' });
  } else {
    const secret = await resolveSecret(provider.api_key_ref, provider.api_key_env ? [provider.api_key_env] : []);
    const needsSecret = provider.kind === 'openai' || provider.kind === 'anthropic' || provider.kind === 'gemini' || provider.kind === 'custom';
    checks.push(
      !needsSecret || secret
        ? { name: 'Provider', status: 'OK', detail: `${provider.id} (${provider.kind}), credential ${maskSecret(secret)}` }
        : { name: 'Provider', status: 'WARN', detail: `${provider.id} has no credential`, fix: `export ${provider.api_key_env}=... or run \`lc config set providers.${provider.id}.api_key\`` },
    );
  }

  const model = provider?.models.find((m) => m.id === config.active_model) ?? provider?.models[0];
  checks.push(
    model
      ? { name: 'Model', status: 'OK', detail: `${model.id}, context ${model.context_limit ?? 'unknown'}` }
      : { name: 'Model', status: 'FAIL', detail: 'no model selected', fix: 'Run `lc models use <model-id>`' },
  );

  try {
    const workspace = await withWorkspace(ctx);
    const files = await workspace.stores.index.listFiles(workspace.project.id);
    const stale = await detectStale(workspace.root, files);
    checks.push(
      files.length === 0
        ? { name: 'Project index', status: 'WARN', detail: 'empty — nothing indexed yet', fix: 'Run `lc index refresh`' }
        : stale.length === 0
          ? { name: 'Project index', status: 'OK', detail: `${files.length} file(s), up to date` }
          : { name: 'Project index', status: 'WARN', detail: `${stale.length} file(s) changed since indexing`, fix: 'Run `lc index refresh`' },
    );

    const memoryCount = await workspace.stores.memory.count({ project_id: workspace.project.id });
    checks.push({ name: 'Memory store', status: 'OK', detail: `${memoryCount} record(s) for this project` });

    const registry = registryFromConfig(config);
    checks.push({ name: 'Tools', status: 'OK', detail: `${registry.list().length} tool(s) available` });

    const searchHits = await workspace.stores.index.searchFiles(workspace.project.id, 'function', 1);
    checks.push({ name: 'Search', status: 'OK', detail: `index search responded (${searchHits.length} sample hit(s))` });

    try {
      const probe = join(workspace.paths.dir, '.doctor-write-test');
      await atomicWrite(probe, 'ok');
      await rm(probe, { force: true });
      checks.push({ name: 'Filesystem', status: 'OK', detail: `writable: ${workspace.paths.dir}` });
    } catch (error) {
      checks.push({ name: 'Filesystem', status: 'FAIL', detail: `cannot write to ${workspace.paths.dir}: ${(error as Error).message}` });
    }

    try {
      const { executeCommand } = await import('../tools/terminal.js');
      const outcome = await executeCommand(process.platform === 'win32' ? 'ver' : 'echo low-context', {
        cwd: workspace.root,
        timeoutMs: 10_000,
        maxOutputBytes: 4_096,
        env: { PATH: process.env.PATH ?? '' },
      });
      checks.push(
        outcome.exit_code === 0
          ? { name: 'Terminal', status: 'OK', detail: `shell responded in ${outcome.duration_ms} ms` }
          : { name: 'Terminal', status: 'WARN', detail: `shell exit ${outcome.exit_code}` },
      );
    } catch (error) {
      checks.push({ name: 'Terminal', status: 'FAIL', detail: (error as Error).message, fix: 'Ensure /bin/sh (or cmd.exe) is available' });
    }

    if (config.embedding.enabled) {
      try {
        const embedder = await createEmbeddingClient(config);
        checks.push(
          embedder
            ? { name: 'Embeddings', status: 'OK', detail: `${config.embedding.mode}, ${embedder.dimensions} dimensions` }
            : { name: 'Embeddings', status: 'WARN', detail: 'enabled but no client could be built' },
        );
      } catch (error) {
        checks.push({ name: 'Embeddings', status: 'WARN', detail: (error as Error).message, fix: 'Set embedding.enabled=false to use keyword retrieval' });
      }
    } else {
      checks.push({ name: 'Embeddings', status: 'OK', detail: 'disabled — keyword/hybrid retrieval only (this is supported)' });
    }
  } catch (error) {
    checks.push({ name: 'Project', status: 'FAIL', detail: describeError(error), fix: 'Run from inside a project directory' });
  }

  ui.heading('Low Context diagnostics');
  let failures = 0;
  for (const check of checks) {
    const badge = check.status === 'OK' ? ui.color('green', 'OK  ') : check.status === 'WARN' ? ui.color('yellow', 'WARN') : ui.color('red', 'FAIL');
    ui.result(`${badge}  ${check.name.padEnd(16)} ${check.detail}`);
    if (check.fix) ui.result(`      ${ui.dim(`fix: ${check.fix}`)}`);
    if (check.status === 'FAIL') failures += 1;
  }
  return failures === 0 ? 0 : 1;
}

/* ================================= context ================================ */

async function contextCommand(ctx: CommandContext, sub: string): Promise<number> {
  const { ui } = ctx;
  const workspace = await withWorkspace(ctx);
  const request = ctx.args.positionals.join(' ') || 'summarize the current state of this project';

  if (sub === 'explain' || flagBool(ctx.args.flags, 'explain')) {
    const { runRetrieval } = await import('../retrieval/engine.js');
    const result = await runRetrieval(
      {
        config: ctx.config,
        indexStore: workspace.stores.index,
        memoryStore: workspace.stores.memory,
        conversationStore: workspace.stores.conversations,
        projectRoot: workspace.root,
        projectId: workspace.project.id,
      },
      { query: request, trace: true },
    );
    ui.heading('Retrieval trace');
    ui.keyValue([
      ['query', request],
      ['intent', result.intent.kind],
      ['modules', result.intent.modules.join(', ') || '(none)'],
      ['symbols', result.intent.symbols.join(', ') || '(none)'],
      ['candidates', String(result.trace.candidates.length)],
      ['stopped early', result.stoppedEarly ? 'yes (enough verified evidence)' : 'no'],
      ['duration', `${result.trace.duration_ms} ms`],
    ]);
    ui.out('');
    ui.out(ui.bold('Stages'));
    ui.table(['stage', 'detail', 'candidates', 'kept', 'ms'], result.trace.steps.map((step) => [step.stage, truncate(step.detail, 46), String(step.candidates), String(step.kept), String(step.duration_ms)]));
    ui.out('');
    ui.out(ui.bold('Selected sources'));
    ui.table(
      ['score', 'verified', 'source', 'reason'],
      result.trace.candidates.slice(0, 20).map((candidate) => [
        candidate.score.toFixed(2),
        candidate.verified ? 'yes' : 'no',
        truncate(candidate.file_path ?? candidate.id, 46),
        truncate(candidate.reason, 40),
      ]),
    );
    return 0;
  }

  // `context show` reports the budget the next request would actually use.
  const { Agent } = await import('../agent/loop.js');
  const activeProvider = ctx.config.providers.find((p) => p.id === ctx.config.active_provider);
  const activeModel = activeProvider?.models.find((m) => m.id === ctx.config.active_model) ?? activeProvider?.models[0];
  if (!activeProvider || !activeModel) {
    ui.warn('No provider/model configured; showing configuration-only view. Run `lc init`.');
    return 1;
  }
  const provider = await createProvider(activeProvider, {});
  const agent = new Agent({
    workspace,
    provider,
    model: modelDescriptor(activeProvider, activeModel),
    registry: registryFromConfig(ctx.config),
    logger: ctx.logger,
    events: ctx.events,
    ui: {
      text: () => undefined,
      contextReport: () => undefined,
    },
    verifyAfterEdits: false,
    includeTrace: true,
  });
  // A dry run: build the context for this request without sending it.
  const dry = await agent.dryRun(request);
  ui.heading('Context budget (dry run)');
  ui.result(dry.report);
  if (dry.trace !== undefined) {
    ui.out('');
    ui.out(ui.bold('Retrieval trace'));
    for (const step of dry.trace.steps) ui.out(`  ${step.stage.padEnd(16)} ${step.kept}/${step.candidates} kept  ${ui.dim(step.detail)}`);
  }
  return 0;
}

/* ================================= analyze =============================== */

async function analyzeCommand(ctx: CommandContext): Promise<number> {
  const { ui } = ctx;
  const scope = ctx.args.positionals[0];
  const workspace = await withWorkspace(ctx, { refresh: true });
  const files = await workspace.stores.index.listFiles(workspace.project.id);
  const modules = await workspace.stores.index.listModules(workspace.project.id);
  const map = buildProjectMap(workspace.root, files, modules);

  if (scope) {
    ui.result(renderModuleMap(map, scope, { maxDepth: 4, maxFiles: 400 }));
    return 0;
  }

  ui.heading(`Project overview — ${workspace.project.name}`);
  ui.keyValue([
    ['root', workspace.root],
    ['files', String(files.length)],
    ['modules', String(modules.length)],
    ['symbols', String(files.reduce((n, f) => n + f.symbols.length, 0))],
    ['languages', [...new Set(files.map((f) => f.language))].slice(0, 10).join(', ')],
  ]);
  ui.out('');
  ui.out(ui.bold('Modules'));
  ui.table(
    ['module', 'files', 'languages', 'key symbols'],
    modules.slice(0, 30).map((module) => [module.path, String(module.file_count), module.languages.join(','), truncate(module.top_symbols.slice(0, 4).join(', '), 40)]),
  );

  if (flagBool(ctx.args.flags, 'narrative') || flagBool(ctx.args.flags, 'deep')) {
    ui.out('');
    ui.info('Asking the model for an architectural summary from the map (not from the whole source tree)...');
    return runAgentTurn(ctx, `Summarise the architecture of this project: its modules, their responsibilities and how they depend on each other. Use the retrieved project map and index, and say when something is inferred rather than verified.${scope ? ` Focus on ${scope}.` : ''}`);
  }
  return 0;
}

/* ================================ registry ================================ */

export const COMMANDS: Record<string, (ctx: CommandContext, sub: string) => Promise<number>> = {
  help: helpCommand,
  version: versionCommand,
  providers: providersCommand,
  models: modelsCommand,
  index: indexCommand,
  map: mapCommand,
  files: filesCommand,
  search: searchCommand,
  memory: memoryCommand,
  sessions: sessionsCommand,
  session: sessionsCommand,
  config: configCommand,
  permissions: permissionsCommand,
  tools: toolsCommand,
  logs: logsCommand,
  status: statusCommand,
  doctor: doctorCommand,
  context: contextCommand,
  analyze: analyzeCommand,
};

/** Exposed for the splash banner and tests. */
export { HELP, VERSION };
