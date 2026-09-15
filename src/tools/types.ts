/**
 * Tool system contracts (§19).
 *
 * A tool is a named, schema-described capability the agent may invoke. The
 * contracts here keep three concerns separate, which is what makes the rest of
 * the app safe:
 *
 *  - `ToolDefinition.run` only *does* the thing. It does not decide whether it
 *    is allowed to run, and it does not decide what enters the model's context.
 *  - `ToolDefinition.permission` declares what the tool needs, so the
 *    permission engine (§20) can answer before any side effect happens.
 *  - `OutputManager` (§56) decides what of the result becomes active context.
 *
 * Tools never construct context items directly. They return raw output plus a
 * short summary; the agent decides how much of it the model gets to see.
 */
import type { AgentEventLog, Logger } from '../core/logger.js';
import type { LowContextConfig } from '../core/config.js';
import type { ToolResult, VerificationState, WebSearchResult } from '../core/types.js';
import type { ConversationStore, IndexStore, MemoryStore } from '../storage/interfaces.js';

export type ToolCategory = 'filesystem' | 'terminal' | 'project' | 'search' | 'memory' | 'web';

/** A tool's declaration of what it would like to do. Never a side effect. */
export interface PermissionRequest {
  /** Human-readable one-liner shown in the confirmation prompt. */
  summary: string;
  /** `tool` for generic tools, `command` for shell, `path` for filesystem writes. */
  resource: 'tool' | 'command' | 'path';
  /** The concrete subject: the command text, the path, or the tool name. */
  subject: string;
  /** True when the operation destroys or overwrites something. */
  destructive: boolean;
}

export interface ToolRunResult {
  /** Compact, already-trimmed text for the model (§56). */
  summary: string;
  /** Full output; spilled to an artifact when larger than the inline limit. */
  output?: string;
  ok?: boolean;
  error?: string;
  affected_files?: string[];
  exit_code?: number;
  verification_state?: VerificationState;
  /** Structured payload for callers that need more than text (e.g. search hits). */
  data?: Record<string, unknown>;
}

export interface ToolContext {
  config: LowContextConfig;
  logger: Logger;
  events: AgentEventLog;
  projectRoot: string;
  artifactsDir: string;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  indexStore?: IndexStore;
  memoryStore?: MemoryStore;
  conversationStore?: ConversationStore;
  /** Injected so the core never hard-depends on one web provider (§19, §71). */
  webSearch?: (query: string, limit: number) => Promise<WebSearchResult[]>;
  signal?: AbortSignal;
  /** Progress notes surfaced in the UI (\"[tool] reading auth/service.ts\"). */
  note?: (message: string) => void;
  /** Ask the user to approve a mutating operation (§20). Absent means deny. */
  confirm?: (request: PermissionRequest) => Promise<boolean>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  /** JSON-schema object published to providers that support tool calling. */
  parameters: Record<string, unknown>;
  /** True when invoking the tool can change state on disk or elsewhere. */
  mutating: boolean;
  /** Declare the permission requirement for a specific invocation. */
  permission?: (args: Record<string, unknown>, ctx: ToolContext) => PermissionRequest;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolRunResult>;
}

/* ---------------------------- argument coercion ---------------------------- */

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function asString(args: Record<string, unknown>, key: string, options: { required?: boolean; fallback?: string } = {}): string {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (options.fallback !== undefined) return options.fallback;
  if (options.required === false) return '';
  throw new ToolArgumentError(`missing required string argument "${key}"`);
}

export function asOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function asNumber(args: Record<string, unknown>, key: string, options: { required?: boolean; fallback?: number } = {}): number {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (options.fallback !== undefined) return options.fallback;
  if (options.required === false) return 0;
  throw new ToolArgumentError(`missing required numeric argument "${key}"`);
}

export function asBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1' || value === 'yes';
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

export function asStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

/* ------------------------------- json schema ------------------------------- */

export function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

export function stringProp(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'string', description, ...extra };
}

export function numberProp(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'number', description, ...extra };
}

export function booleanProp(description: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'boolean', description, ...extra };
}

export function enumProp(description: string, values: readonly string[]): Record<string, unknown> {
  return { type: 'string', description, enum: [...values] };
}

/* -------------------------------- results --------------------------------- */

export function toolResultFrom(
  call: { id: string; name: string },
  result: ToolRunResult,
  extra: { bytes: number; truncated: boolean; artifactPath?: string; duration_ms: number },
): ToolResult {
  return {
    id: call.id,
    tool_call_id: call.id,
    tool: call.name,
    ok: result.ok !== false,
    summary: result.summary,
    bytes: extra.bytes,
    truncated: extra.truncated,
    duration_ms: extra.duration_ms,
    ...(extra.artifactPath === undefined ? {} : { artifact_path: extra.artifactPath }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.affected_files === undefined ? {} : { affected_files: result.affected_files }),
    ...(result.exit_code === undefined ? {} : { exit_code: result.exit_code }),
    ...(result.verification_state === undefined ? {} : { verification_state: result.verification_state }),
  };
}
