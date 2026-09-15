/**
 * Configuration model (§24, §25, §26).
 *
 * Precedence, lowest to highest:
 *   1. built-in defaults (`DEFAULT_CONFIG`)
 *   2. global config file        $LOW_CONTEXT_HOME/config/config.json
 *   3. project config file       <project>/.low-context/config.json
 *   4. environment variables     LOW_CONTEXT_*
 *   5. CLI flags                 (applied by the command layer)
 *
 * Secrets are *never* stored here. Providers reference credentials by name
 * (`api_key_env` or `api_key_ref`), and the resolved value is fetched through
 * `security/secrets.ts` at request time.
 */
import { join } from 'node:path';
import { globalPaths, projectPaths } from './paths.js';
import { LowContextError } from './errors.js';
import { atomicWrite, firstDefined, readJsonIfExists } from './util.js';
import type {
  ContextStrategy,
  PermissionMode,
  RankingWeights,
} from './types.js';
import { DEFAULT_WEIGHTS } from './types.js';

export const CONFIG_VERSION = 1;

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'local' | 'custom' | 'mock';

export interface ModelConfigEntry {
  id: string;
  label?: string;
  context_limit?: number;
  max_output?: number;
  /** Overrides for providers that only partially report capabilities. */
  capabilities?: Partial<ProviderCapabilitiesConfig>;
  /** Approximate price per million tokens, for cost display only. */
  input_per_mtok?: number;
  output_per_mtok?: number;
}

export interface ProviderCapabilitiesConfig {
  streaming: boolean;
  tool_calling: boolean;
  embeddings: boolean;
  vision: boolean;
  json_mode: boolean;
  reasoning: boolean;
  exact_usage: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  base_url?: string;
  /** Environment variable that holds the key (checked first). */
  api_key_env?: string;
  /** Key into the 0600 credentials file (fallback). */
  api_key_ref?: string;
  /** Extra headers, e.g. for gateway routing. Values may use `${ENV_VAR}`. */
  headers?: Record<string, string>;
  models: ModelConfigEntry[];
  capabilities?: Partial<ProviderCapabilitiesConfig>;
  /** Request timeout in ms. */
  timeout_ms?: number;
}

export interface LowContextConfig {
  version: number;
  active_provider?: string;
  active_model?: string;
  fallback_provider?: string;
  fallback_model?: string;
  providers: ProviderConfig[];

  generation: {
    temperature?: number;
    max_output_tokens: number;
    reasoning?: { effort?: 'low' | 'medium' | 'high'; budget_tokens?: number };
  };

  embedding: {
    enabled: boolean;
    /** 'local' uses the dependency-free hashing vectorizer; 'provider' calls an API. */
    mode: 'local' | 'provider';
    provider?: string;
    model?: string;
    dimensions: number;
  };

  retrieval: {
    mode: 'keyword' | 'hybrid' | 'semantic';
    top_k: number;
    adaptive: boolean;
    /** Stop retrieving once this many verified candidates are in hand (§63). */
    sufficient_verified: number;
    verify_sources: boolean;
    /** Hard ceiling on candidates considered before ranking. */
    max_candidates: number;
    weights: RankingWeights;
  };

  context: {
    strategy: ContextStrategy;
    reserve_output_tokens: number;
    /** Compact once utilisation crosses this fraction of the usable window. */
    compaction_threshold: number;
    keep_recent_messages: number;
    auto_compact: boolean;
    max_retrieved_file_bytes: number;
  };

  memory: {
    enabled: boolean;
    auto_capture: boolean;
    /** Records below this importance are stored but decayed/dropped first. */
    min_importance: 'temporary' | 'normal' | 'important' | 'critical';
    retention_days: number;
    /** Consolidate sessions longer than this many messages. */
    consolidate_after_messages: number;
  };

  index: {
    enabled: boolean;
    max_file_bytes: number;
    follow_symlinks: boolean;
    extra_ignore: string[];
    /** Refresh the index automatically when a chat session starts. */
    refresh_on_start: boolean;
  };

  permissions: {
    mode: PermissionMode;
    /** Glob-ish allow rules: `command:git *`, `path:src/**`, `tool:read_file`. */
    allow: string[];
    deny: string[];
    timeout_ms: number;
    max_output_bytes: number;
    allow_outside_project: boolean;
    /** Environment variables passed through to child processes. */
    env_allowlist: string[];
    require_confirmation_for_destructive: boolean;
  };

  ui: {
    response_mode: 'normal' | 'verbose' | 'quiet' | 'debug';
    color: 'auto' | 'always' | 'never';
    stream: boolean;
    show_retrieval: boolean;
    show_token_usage: boolean;
    show_context_bar: boolean;
    spinner: boolean;
  };

  storage: {
    /** When false, all project state is centralised under $LOW_CONTEXT_HOME/projects. */
    project_local: boolean;
  };

  privacy: {
    telemetry: boolean;
    redact_secrets: boolean;
    /** Persist full prompts in the debug log. Off by default. */
    log_prompts: boolean;
  };

  security: {
    injection_defense: boolean;
    /** Mark all retrieved repository/file content as untrusted data. */
    tag_untrusted_content: boolean;
    max_retrieved_file_bytes: number;
    scan_for_injection_patterns: boolean;
  };

  web: {
    enabled: boolean;
    /** Only an endpoint template; absent means "use the provider's built-in". */
    endpoint?: string;
    api_key_env?: string;
    max_results: number;
  };

  verification: {
    /** Re-read edited regions and run a check after changes (§21, §22). */
    enabled: boolean;
    /** Optional command to validate a change (e.g. `npm test`); empty = skip. */
    command?: string;
    /** Only verify edits under these path prefixes (empty = project root). */
    paths: string[];
  };

  tools: {
    /** Empty means "all tools enabled". */
    enabled: string[];
    disabled: string[];
  };
}

/* ------------------------------- defaults --------------------------------- */

export const PROJECT_CONFIG_FILE = 'config.json';

export function defaultProviders(): ProviderConfig[] {
  return [
    {
      id: 'openai',
      kind: 'openai',
      label: 'OpenAI',
      enabled: true,
      base_url: 'https://api.openai.com/v1',
      api_key_env: 'OPENAI_API_KEY',
      api_key_ref: 'providers.openai.api_key',
      models: [
        { id: 'gpt-4o', label: 'GPT-4o', context_limit: 128_000, max_output: 16_384 },
        { id: 'gpt-4o-mini', label: 'GPT-4o mini', context_limit: 128_000, max_output: 16_384 },
        { id: 'gpt-4.1', label: 'GPT-4.1', context_limit: 1_047_576, max_output: 32_768 },
      ],
    },
    {
      id: 'anthropic',
      kind: 'anthropic',
      label: 'Anthropic',
      enabled: true,
      base_url: 'https://api.anthropic.com/v1',
      api_key_env: 'ANTHROPIC_API_KEY',
      api_key_ref: 'providers.anthropic.api_key',
      models: [
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', context_limit: 200_000, max_output: 64_000 },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', context_limit: 200_000, max_output: 32_000 },
      ],
    },
    {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google Gemini',
      enabled: true,
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      api_key_env: 'GEMINI_API_KEY',
      api_key_ref: 'providers.gemini.api_key',
      models: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', context_limit: 1_048_576, max_output: 65_536 },
        { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', context_limit: 1_048_576, max_output: 65_536 },
      ],
    },
    {
      id: 'ollama',
      kind: 'local',
      label: 'Ollama (local)',
      enabled: true,
      base_url: 'http://127.0.0.1:11434/v1',
      api_key_env: 'OLLAMA_API_KEY',
      models: [{ id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B (local)', context_limit: 32_768, max_output: 8_192 }],
    },
    {
      id: 'mock',
      kind: 'mock',
      label: 'Mock provider (offline, deterministic)',
      enabled: true,
      models: [{ id: 'mock-1', label: 'Mock 1', context_limit: 32_768, max_output: 4_096 }],
    },
  ];
}

export function defaultConfig(): LowContextConfig {
  return {
    version: CONFIG_VERSION,
    active_provider: undefined,
    active_model: undefined,
    providers: defaultProviders(),
    generation: {
      max_output_tokens: 8_192,
    },
    embedding: {
      enabled: false,
      mode: 'local',
      dimensions: 512,
    },
    retrieval: {
      mode: 'hybrid',
      top_k: 12,
      adaptive: true,
      sufficient_verified: 5,
      verify_sources: true,
      max_candidates: 240,
      weights: { ...DEFAULT_WEIGHTS },
    },
    context: {
      strategy: 'balanced',
      reserve_output_tokens: 8_192,
      compaction_threshold: 0.7,
      keep_recent_messages: 12,
      auto_compact: true,
      max_retrieved_file_bytes: 128 * 1024,
    },
    memory: {
      enabled: true,
      auto_capture: true,
      min_importance: 'normal',
      retention_days: 0, // 0 = keep forever
      consolidate_after_messages: 40,
    },
    index: {
      enabled: true,
      max_file_bytes: 512 * 1024,
      follow_symlinks: false,
      extra_ignore: [],
      refresh_on_start: true,
    },
    permissions: {
      mode: 'ask',
      allow: [],
      deny: [],
      timeout_ms: 120_000,
      max_output_bytes: 512 * 1024,
      allow_outside_project: false,
      env_allowlist: [],
      require_confirmation_for_destructive: true,
    },
    ui: {
      response_mode: 'normal',
      color: 'auto',
      stream: true,
      show_retrieval: true,
      show_token_usage: true,
      show_context_bar: true,
      spinner: true,
    },
    storage: {
      project_local: true,
    },
    privacy: {
      telemetry: false,
      redact_secrets: true,
      log_prompts: false,
    },
    security: {
      injection_defense: true,
      tag_untrusted_content: true,
      max_retrieved_file_bytes: 128 * 1024,
      scan_for_injection_patterns: true,
    },
    web: {
      enabled: false,
      max_results: 5,
    },
    verification: {
      enabled: true,
      paths: [],
    },
    tools: {
      enabled: [],
      disabled: [],
    },
  };
}

/* -------------------------------- merging --------------------------------- */

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge plain objects. Arrays are replaced, not concatenated — that makes
 * `providers` and `allow` lists predictable.
 */
export function mergeConfig<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  if (!isPlainObject(base)) return override as T;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) out[key] = mergeConfig(current, value);
    else out[key] = value;
  }
  return out as T;
}

/* ------------------------------- validation -------------------------------- */

const STRATEGIES = new Set<ContextStrategy>(['minimal', 'balanced', 'deep', 'maximum']);
const RETRIEVAL_MODES = new Set(['keyword', 'hybrid', 'semantic']);
const PERMISSION_MODES = new Set<PermissionMode>(['safe', 'ask', 'trusted']);
const RESPONSE_MODES = new Set(['normal', 'verbose', 'quiet', 'debug']);

export function validateConfig(config: LowContextConfig): string[] {
  const problems: string[] = [];
  if (typeof config.version !== 'number') problems.push('version must be a number');
  if (!Array.isArray(config.providers)) problems.push('providers must be an array');
  for (const provider of config.providers ?? []) {
    if (!provider.id) problems.push('provider without id');
    if (!provider.kind) problems.push(`provider ${provider.id} has no kind`);
    if (!Array.isArray(provider.models)) problems.push(`provider ${provider.id} models must be an array`);
  }
  if (!STRATEGIES.has(config.context?.strategy)) {
    problems.push(`context.strategy must be one of ${[...STRATEGIES].join(', ')}`);
  }
  if (!RETRIEVAL_MODES.has(config.retrieval?.mode)) {
    problems.push(`retrieval.mode must be one of ${[...RETRIEVAL_MODES].join(', ')}`);
  }
  if (!PERMISSION_MODES.has(config.permissions?.mode)) {
    problems.push(`permissions.mode must be one of ${[...PERMISSION_MODES].join(', ')}`);
  }
  if (!RESPONSE_MODES.has(config.ui?.response_mode)) {
    problems.push(`ui.response_mode must be one of ${[...RESPONSE_MODES].join(', ')}`);
  }
  if ((config.retrieval?.top_k ?? 0) < 1) problems.push('retrieval.top_k must be >= 1');
  if ((config.context?.reserve_output_tokens ?? 0) < 0) problems.push('context.reserve_output_tokens must be >= 0');
  return problems;
}

/* --------------------------------- loading --------------------------------- */

export interface ConfigLoadResult {
  config: LowContextConfig;
  globalPath: string;
  projectPath?: string;
  /** Files that actually contributed to the result. */
  sources: string[];
  problems: string[];
}

export function globalConfigPath(): string {
  return join(globalPaths().config, 'config.json');
}

export function projectConfigPath(projectRoot: string, projectLocal = true): string {
  return join(projectPaths(projectRoot, { local: projectLocal }).dir, PROJECT_CONFIG_FILE);
}

/** Apply LOW_CONTEXT_* environment overrides. */
export function applyEnvOverrides(config: LowContextConfig): LowContextConfig {
  const env = process.env;
  const out: LowContextConfig = {
    ...config,
    generation: { ...config.generation },
    retrieval: { ...config.retrieval },
    context: { ...config.context },
    permissions: { ...config.permissions },
    ui: { ...config.ui },
    index: { ...config.index },
  };

  if (env.LOW_CONTEXT_PROVIDER) out.active_provider = env.LOW_CONTEXT_PROVIDER;
  if (env.LOW_CONTEXT_MODEL) out.active_model = env.LOW_CONTEXT_MODEL;
  if (env.LOW_CONTEXT_FALLBACK_PROVIDER) out.fallback_provider = env.LOW_CONTEXT_FALLBACK_PROVIDER;
  if (env.LOW_CONTEXT_FALLBACK_MODEL) out.fallback_model = env.LOW_CONTEXT_FALLBACK_MODEL;

  if (env.LOW_CONTEXT_TEMPERATURE) {
    const value = Number(env.LOW_CONTEXT_TEMPERATURE);
    if (Number.isFinite(value)) out.generation.temperature = value;
  }
  if (env.LOW_CONTEXT_MAX_OUTPUT_TOKENS) {
    const value = Number(env.LOW_CONTEXT_MAX_OUTPUT_TOKENS);
    if (Number.isFinite(value) && value > 0) out.generation.max_output_tokens = value;
  }
  if (env.LOW_CONTEXT_CONTEXT_STRATEGY && STRATEGIES.has(env.LOW_CONTEXT_CONTEXT_STRATEGY as ContextStrategy)) {
    out.context.strategy = env.LOW_CONTEXT_CONTEXT_STRATEGY as ContextStrategy;
  }
  if (env.LOW_CONTEXT_RETRIEVAL_MODE && RETRIEVAL_MODES.has(env.LOW_CONTEXT_RETRIEVAL_MODE)) {
    out.retrieval.mode = env.LOW_CONTEXT_RETRIEVAL_MODE as LowContextConfig['retrieval']['mode'];
  }
  if (env.LOW_CONTEXT_PERMISSION_MODE && PERMISSION_MODES.has(env.LOW_CONTEXT_PERMISSION_MODE as PermissionMode)) {
    out.permissions.mode = env.LOW_CONTEXT_PERMISSION_MODE as PermissionMode;
  }
  if (env.LOW_CONTEXT_RESPONSE_MODE && RESPONSE_MODES.has(env.LOW_CONTEXT_RESPONSE_MODE)) {
    out.ui.response_mode = env.LOW_CONTEXT_RESPONSE_MODE as LowContextConfig['ui']['response_mode'];
  }
  if (env.LOW_CONTEXT_COLOR) out.ui.color = env.LOW_CONTEXT_COLOR as LowContextConfig['ui']['color'];
  if (env.LOW_CONTEXT_NO_COLOR === '1') out.ui.color = 'never';
  if (env.LOW_CONTEXT_INDEX_MAX_FILE_BYTES) {
    const value = Number(env.LOW_CONTEXT_INDEX_MAX_FILE_BYTES);
    if (Number.isFinite(value) && value > 0) out.index.max_file_bytes = value;
  }
  if (env.LOW_CONTEXT_PROJECT_LOCAL === '0') out.storage.project_local = false;
  if (env.LOW_CONTEXT_TELEMETRY === '1') out.privacy.telemetry = true;
  return out;
}

export async function loadConfig(
  options: { projectRoot?: string; skipProject?: boolean; skipEnv?: boolean } = {},
): Promise<ConfigLoadResult> {
  const sources: string[] = [];
  let config = defaultConfig();

  const gPath = globalConfigPath();
  const globalRaw = await readJsonIfExists<Json>(gPath);
  if (globalRaw) {
    config = mergeConfig(config, globalRaw);
    sources.push(gPath);
  }

  let projectPath: string | undefined;
  if (options.projectRoot && !options.skipProject) {
    projectPath = projectConfigPath(options.projectRoot, config.storage.project_local);
    const projectRaw = await readJsonIfExists<Json>(projectPath);
    if (projectRaw) {
      // A project file may only touch a safe subset; provider definitions are
      // global so a cloned repo cannot silently repoint your API traffic.
      const allowed = pickProjectScoped(projectRaw);
      config = mergeConfig(config, allowed);
      sources.push(projectPath);
    }
  }

  if (!options.skipEnv) config = applyEnvOverrides(config);

  const problems = validateConfig(config);
  return { config, globalPath: gPath, projectPath, sources, problems };
}

/** Strip fields a project-local config is not allowed to override. */
export function pickProjectScoped(raw: Json): Json {
  const allowedKeys = new Set([
    'active_provider',
    'active_model',
    'generation',
    'retrieval',
    'context',
    'memory',
    'index',
    'permissions',
    'ui',
    'security',
    'tools',
  ]);
  const out: Json = {};
  for (const [key, value] of Object.entries(raw)) if (allowedKeys.has(key)) out[key] = value;
  if (isPlainObject(out.permissions)) {
    // A project may tighten permissions but never loosen them silently beyond
    // what the user configured globally: only additive deny rules and mode
    // downgrades are accepted.
    const p = { ...out.permissions };
    delete p.allow;
    out.permissions = p;
  }
  return out;
}

export async function saveGlobalConfig(config: LowContextConfig): Promise<void> {
  await atomicWrite(globalConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export async function saveProjectConfig(projectRoot: string, partial: Json): Promise<string> {
  const path = projectConfigPath(projectRoot, true);
  const existing = (await readJsonIfExists<Json>(path)) ?? {};
  const merged = mergeConfig(existing, partial);
  await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
  return path;
}

/** Write a starter global config if none exists. Returns true when created. */
export async function ensureGlobalConfig(): Promise<boolean> {
  const path = globalConfigPath();
  const existing = await readJsonIfExists<Json>(path);
  if (existing) return false;
  await saveGlobalConfig(defaultConfig());
  return true;
}

/* ------------------------------- resolution -------------------------------- */

export function findProvider(config: LowContextConfig, id: string | undefined): ProviderConfig | undefined {
  if (!id) return undefined;
  return config.providers.find((p) => p.id === id);
}

export function resolveActiveProvider(config: LowContextConfig): ProviderConfig | undefined {
  return findProvider(config, config.active_provider);
}

export function findModel(
  config: LowContextConfig,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelConfigEntry | undefined {
  const provider = findProvider(config, providerId);
  if (!provider) return undefined;
  if (!modelId) return provider.models[0];
  return provider.models.find((m) => m.id === modelId);
}

/** Throw a helpful error when nothing is configured yet (§75). */
export function requireActiveModel(config: LowContextConfig): { provider: ProviderConfig; model: ModelConfigEntry } {
  const provider = resolveActiveProvider(config);
  if (!provider) {
    throw new LowContextError('CONFIG_MISSING', 'No provider is configured', {
      fix: 'Run `low-context init` or `low-context provider add <kind>`',
    });
  }
  const model = findModel(config, provider.id, config.active_model);
  if (!model) {
    throw new LowContextError('MODEL_UNKNOWN', `Provider ${provider.id} has no model ${config.active_model}`, {
      fix: `Run \`low-context model list --provider ${provider.id}\``,
    });
  }
  return { provider, model };
}

export function configPathForDisplay(config: LowContextConfig): string {
  return firstDefined(config.active_provider, '(unset)') ?? '(unset)';
}
