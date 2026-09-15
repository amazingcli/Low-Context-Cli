/**
 * Core domain types for Low Context (see §83 "Important internal objects").
 *
 * These are the stable vocabulary that every subsystem shares. Two invariants
 * are encoded here on purpose:
 *
 *  1. Every durable record can point back at its *source* (`SourceReference`).
 *     A summary or index entry never replaces the original (§8, §50).
 *  2. Every durable record carries `confidence` and `status`, so retrieval can
 *     tell a verified fact apart from an old inference (§36, §51).
 *
 * Nothing here implies model training. Memory is external storage that is
 * indexed and retrieved (§3, §52).
 */

/* --------------------------------- scopes --------------------------------- */

export type MemoryScope = 'global' | 'project' | 'module' | 'session' | 'task';

export type MemoryType =
  | 'FACT'
  | 'DECISION'
  | 'PREFERENCE'
  | 'TASK'
  | 'PROJECT_KNOWLEDGE'
  | 'ARCHITECTURE'
  | 'BUG'
  | 'FIX'
  | 'FILE_KNOWLEDGE'
  | 'COMMAND_RESULT'
  | 'CONVERSATION_SUMMARY'
  | 'USER_INSTRUCTION';

export type Confidence = 'verified' | 'high' | 'medium' | 'low' | 'unknown';

export type MemoryStatus = 'current' | 'superseded' | 'retracted';

export type Importance = 'temporary' | 'normal' | 'important' | 'critical';

/** How much Low Context trusts what it currently knows about a thing. */
export type VerificationState = 'indexed' | 'inferred' | 'verified' | 'stale' | 'unknown';

/* ------------------------------ source refs ------------------------------- */

export type SourceKind = 'message' | 'file' | 'commit' | 'tool_result' | 'symbol' | 'session' | 'external';

/**
 * A route back to the original material behind a memory or index entry.
 * Retaining one of these is what keeps summaries honest (§8).
 */
export interface SourceReference {
  kind: SourceKind;
  project_id?: string;
  conversation_id?: string;
  message_id?: string;
  session_id?: string;
  file_path?: string;
  line_start?: number;
  line_end?: number;
  symbol?: string;
  commit?: string;
  tool_call_id?: string;
  url?: string;
  /** Short literal excerpt for display. Explicitly *not* a substitute for reading the source. */
  excerpt?: string;
}

/* --------------------------------- memory --------------------------------- */

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Populated for every scope except `global`. */
  project_id?: string;
  session_id?: string;
  task_id?: string;
  /** Present for `module` scope. */
  module_path?: string;

  summary: string;
  /** Optional fuller statement. Still not a replacement for `source_refs`. */
  detail?: string;
  tags: string[];

  source_refs: SourceReference[];
  confidence: Confidence;
  status: MemoryStatus;
  importance: Importance;
  /** id of the record that replaced this one, when status === 'superseded'. */
  superseded_by?: string;
  supersedes?: string[];
  verification_state: VerificationState;

  /** Retrieval bookkeeping — never used as evidence on its own. */
  access_count: number;
  last_accessed_at?: string;

  created_at: string;
  updated_at: string;
}

export interface MemorySearchQuery {
  text?: string;
  types?: MemoryType[];
  scopes?: MemoryScope[];
  tags?: string[];
  project_id?: string;
  session_id?: string;
  task_id?: string;
  module_path?: string;
  include_superseded?: boolean;
  /** Minimum importance filter, ordered temporary < normal < important < critical. */
  min_importance?: Importance;
  limit?: number;
  /** Weighting profile; retrieval supplies this so the store stays dumb. */
  weights?: RankingWeights;
}

export interface RankingWeights {
  lexical: number;
  semantic: number;
  recency: number;
  importance: number;
  confidence: number;
  /** Positive bonus for exact symbol/path matches. */
  exact: number;
  /** Positive bonus for hits in the current task/scope. */
  task: number;
  /** Penalty multiplier applied to staleness and redundancy. */
  staleness: number;
  redundancy: number;
}

export const DEFAULT_WEIGHTS: RankingWeights = {
  lexical: 1,
  semantic: 0.8,
  recency: 0.25,
  importance: 0.35,
  confidence: 0.3,
  exact: 0.6,
  task: 0.4,
  staleness: 0.5,
  redundancy: 0.7,
};

export const IMPORTANCE_ORDER: Record<Importance, number> = {
  temporary: 0,
  normal: 1,
  important: 2,
  critical: 3,
};

export const CONFIDENCE_SCORE: Record<Confidence, number> = {
  verified: 1,
  high: 0.8,
  medium: 0.55,
  low: 0.3,
  unknown: 0.15,
};

/* ---------------------------------- index --------------------------------- */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'route'
  | 'struct'
  | 'trait'
  | 'module'
  | 'decorator'
  | 'test';

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  file_id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  signature?: string;
  exported: boolean;
  /** Names this symbol references (best-effort static analysis). */
  references?: string[];
}

export interface IndexedFile {
  id: string;
  project_id: string;
  path: string;
  language: string;
  size: number;
  lines: number;
  hash: string;
  modified_at: string;
  indexed_at: string;

  /** One-line description derived from doc comments/heading structure. */
  summary?: string;
  symbols: string[];
  imports: string[];
  exports: string[];
  dependencies: string[];
  /** Resolved project-relative paths this file depends on. */
  depends_on_files: string[];
  /** Files that depend on this one (filled during graph build). */
  depended_on_by?: string[];
  routes?: string[];
  tests?: string[];
  tags?: string[];
  verification_state: VerificationState;
  /** Set when the file changed on disk after `hash` was computed. */
  stale?: boolean;
}

export interface IndexedModule {
  id: string;
  project_id: string;
  path: string;
  name: string;
  summary?: string;
  file_count: number;
  /** Aggregated from member files. */
  languages: string[];
  top_symbols: string[];
  entry_points: string[];
  updated_at: string;
}

export interface ProjectIndex {
  id: string;
  project_id: string;
  root: string;
  /** Schema/format version so old indexes can be upgraded or refused. */
  format: number;
  /** Version of the source analyser that produced the entries. Bumping it
   *  forces a re-analysis, so improving symbol extraction does not require the
   *  user to know they must run a full rebuild. */
  analyzer: number;
  created_at: string;
  updated_at: string;
  git_head?: string;
  git_branch?: string;
  /** path -> file id, kept in the manifest for fast incremental scans. */
  files: Record<string, string>;
  modules: Record<string, string>;
  stats: IndexStats;
}

export interface IndexStats {
  files: number;
  symbols: number;
  modules: number;
  bytes: number;
  languages: Record<string, number>;
  /** Files skipped because they were too large, binary, or ignored. */
  skipped: number;
  duration_ms: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  created_at: string;
  last_opened_at: string;
  git_remote?: string;
  default_model?: string;
  /** Per-project overrides applied on top of global config (§24). */
  settings?: Record<string, unknown>;
}

/* ------------------------------ conversations ------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  conversation_id: string;
  session_id?: string;
  timestamp: string;
  role: Role;
  content: string;
  /** Tool calls requested by the assistant. */
  tool_calls?: ToolCall[];
  /** Present on role === 'tool'. */
  tool_call_id?: string;
  name?: string;
  /** Conversation-level metadata used by retrieval (§7). */
  importance?: Importance;
  topic?: string;
  summary?: string;
  references?: SourceReference[];
  tokens_estimate?: number;
  /** Marks messages produced by compaction rather than the user/model. */
  synthetic?: boolean;
}

export interface Conversation {
  id: string;
  project_id?: string;
  session_id?: string;
  title?: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** Byte offset of the end of the log, so appends need no rescan. */
  byte_length: number;
  last_message_id?: string;
  topics?: string[];
  /** Cached summary of compacted-away history; always paired with source refs. */
  summary?: string;
  summary_through_message_id?: string;
}

export interface Session {
  id: string;
  project_id?: string;
  project_root?: string;
  conversation_id?: string;
  task_id?: string;
  created_at: string;
  updated_at: string;
  ended_at?: string;
  title?: string;
  provider?: string;
  model?: string;
  message_count: number;
  /** Compact task state restored on resume, instead of replaying the log (§27). */
  task_state?: TaskState;
  status: 'active' | 'idle' | 'ended' | 'corrupt';
}

/* ---------------------------------- tasks --------------------------------- */

export interface TaskState {
  id: string;
  project_id?: string;
  session_id?: string;
  title: string;
  goal: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'abandoned';
  decisions: TaskDecision[];
  pending: string[];
  completed: string[];
  relevant_files: string[];
  relevant_symbols: string[];
  open_questions: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskDecision {
  id: string;
  statement: string;
  rationale?: string;
  made_at: string;
  source_refs: SourceReference[];
  /** Memory record created for this decision, when one exists. */
  memory_id?: string;
}

/* --------------------------------- retrieval -------------------------------- */

export type CandidateSource =
  | 'project_map'
  | 'index_lexical'
  | 'index_vector'
  | 'memory_lexical'
  | 'memory_vector'
  | 'conversation'
  | 'recent_context'
  | 'task_state'
  | 'dependency'
  | 'git'
  | 'filesystem';

export interface RetrievalCandidate {
  id: string;
  source: CandidateSource;
  /** Why the candidate was surfaced, for the retrieval trace (§40). */
  reason: string;
  score: number;
  /** Raw lexical score before normalisation, when applicable. */
  lexical?: number;
  semantic?: number;
  /** True once actual source content has been inspected (§16). */
  verified: boolean;

  file_path?: string;
  symbol?: string;
  line_start?: number;
  line_end?: number;
  memory_id?: string;
  message_id?: string;
  conversation_id?: string;

  /** Populated only after verification / content loading. */
  content?: string;
  excerpt?: string;
  verification_state?: VerificationState;
}

export interface RetrievalTraceStep {
  stage: string;
  detail: string;
  candidates: number;
  kept: number;
  duration_ms: number;
}

export interface RetrievalTrace {
  query: string;
  intent: QueryIntent;
  steps: RetrievalTraceStep[];
  candidates: RetrievalCandidate[];
  effective_limit: number;
  duration_ms: number;
  /** True when adaptive retrieval stopped early because evidence was sufficient. */
  stopped_early: boolean;
}

export type IntentKind = 'code_change' | 'question' | 'analysis' | 'memory_query' | 'command' | 'chat';

export interface QueryIntent {
  kind: IntentKind;
  /** Literal search terms after normalisation. */
  terms: string[];
  /** Paths the user named, or that were resolved from the project map. */
  paths: string[];
  symbols: string[];
  /** Subsystems implicated: payments, auth, database, ... */
  modules: string[];
  /** True for "analyze the whole app" style requests (§31, §60). */
  whole_project: boolean;
  /** True for "what did we decide last month" style requests (§33). */
  historical: boolean;
  confidence: number;
}

/* ---------------------------------- context -------------------------------- */

export type ContextItemKind =
  | 'system'
  | 'task'
  | 'project_map'
  | 'memory'
  | 'code'
  | 'symbol'
  | 'tool_result'
  | 'conversation_summary'
  | 'recent'
  | 'retrieval_trace';

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  /** Higher priority survives trimming first. */
  priority: number;
  tokens: number;
  content: string;
  /** Provenance used for deduplication and display. */
  label: string;
  source_refs?: SourceReference[];
  /** Set when content came from outside the trusted instruction set (§81). */
  untrusted?: boolean;
  verification_state?: VerificationState;
  /** Every item must be able to justify its presence. */
  reason?: string;
}

export interface ContextBudgetReport {
  strategy: ContextStrategy;
  model_context_limit: number;
  reserved_output_tokens: number;
  usable_tokens: number;
  used_tokens: number;
  utilization: number;
  slices: { kind: ContextItemKind; tokens: number; items: number }[];
  dropped: { label: string; tokens: number; reason: string }[];
  estimated: boolean;
}

export type ContextStrategy = 'minimal' | 'balanced' | 'deep' | 'maximum';

export const STRATEGY_SHARE: Record<ContextStrategy, { memory: number; code: number; tool: number; map: number }> = {
  minimal: { memory: 0.08, code: 0.3, tool: 0.08, map: 0.04 },
  balanced: { memory: 0.12, code: 0.42, tool: 0.14, map: 0.07 },
  deep: { memory: 0.18, code: 0.5, tool: 0.18, map: 0.09 },
  maximum: { memory: 0.24, code: 0.55, tool: 0.22, map: 0.12 },
};

/* ----------------------------------- tools --------------------------------- */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Raw argument text as emitted by the model, kept for debugging bad JSON. */
  raw_arguments?: string;
}

export interface ToolResult {
  id: string;
  tool_call_id: string;
  tool: string;
  ok: boolean;
  /** Summary shown to the model — never the whole output for big results (§56). */
  summary: string;
  /** Path to the full artifact on disk, when output was large. */
  artifact_path?: string;
  bytes: number;
  truncated: boolean;
  duration_ms: number;
  error?: string;
  /** Files touched, used by index/memory update after the action (§22). */
  affected_files?: string[];
  verification_state?: VerificationState;
  exit_code?: number;
}

export type PermissionMode = 'safe' | 'ask' | 'trusted';

export interface PermissionDecision {
  allowed: boolean;
  needs_confirmation: boolean;
  reason: string;
  /** Set when the decision came from config rather than interactive prompt. */
  rule?: string;
}

/* --------------------------------- providers -------------------------------- */

export interface ProviderCapabilities {
  streaming: boolean;
  tool_calling: boolean;
  embeddings: boolean;
  vision: boolean;
  json_mode: boolean;
  reasoning: boolean;
  /** Exact token accounting from the API. */
  exact_usage: boolean;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  label: string;
  context_limit: number;
  max_output: number;
  capabilities: ProviderCapabilities;
  cost?: { input_per_mtok?: number; output_per_mtok?: number; currency?: string };
}

export interface GenerationRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderToolSpec[];
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** Provider-specific reasoning/thinking budget, when supported. */
  reasoning?: { effort?: 'low' | 'medium' | 'high'; budget_tokens?: number };
}

export interface ProviderMessage {
  role: Role;
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  tool_call_id?: string;
  name?: string;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: UsageReport }
  | { type: 'done'; stop_reason: string; message: ProviderMessage };

export interface UsageReport {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  estimated: boolean;
  cost_estimate?: { amount: number; currency: string };
}

/* ----------------------------------- misc ---------------------------------- */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A single observable action, used for logging and memory extraction (§46). */
export interface AgentEvent {
  id: string;
  at: string;
  kind:
    | 'request'
    | 'retrieval'
    | 'tool_call'
    | 'tool_result'
    | 'edit'
    | 'verification'
    | 'memory_write'
    | 'index_update'
    | 'error'
    | 'compaction';
  summary: string;
  data?: Record<string, unknown>;
}
