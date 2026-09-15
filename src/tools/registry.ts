/**
 * Tool registry (§19, §20, §21, §22).
 *
 * The registry is the single choke point between the model and the machine.
 * Every tool call passes through it, which is what makes these guarantees
 * possible in one place:
 *
 *   1. unknown tools are rejected, not guessed;
 *   2. the permission engine decides *before* any side effect (§20);
 *   3. output is trimmed for context while the full text is kept as an artifact
 *      (§56);
 *   4. every call is recorded as an agent event, so memory extraction sees only
 *      things that actually happened (§35).
 */
import { OutputManager } from './output.js';
import { PermissionEngine } from './permissions.js';
import { FILESYSTEM_TOOLS } from './filesystem.js';
import { TERMINAL_TOOLS } from './terminal.js';
import { projectTools } from './project.js';
import { memoryTools } from './memory.js';
import { webTools } from './web.js';
import type { PermissionPolicy } from './permissions.js';
import type { PermissionRequest, ToolContext, ToolDefinition, ToolRunResult } from './types.js';
import { ToolArgumentError, toolResultFrom } from './types.js';
import type { ProviderToolSpec, ToolCall, ToolResult } from '../core/types.js';
import { LowContextError } from '../core/errors.js';
import { truncate } from '../core/util.js';

/** Tools that are always available, regardless of category configuration. */
export function defaultTools(): ToolDefinition[] {
  return [...FILESYSTEM_TOOLS, ...TERMINAL_TOOLS, ...projectTools(), ...memoryTools(), ...webTools()];
}

export interface InvokeOutcome {
  result: ToolResult;
  /** Text intended for the model, already trimmed. */
  forModel: string;
  /** Full raw output, when the tool produced any. */
  raw?: string;
  artifactPath?: string;
  /** True when the user or policy refused the call. */
  refused: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly engine: PermissionEngine;
  private readonly enabled: Set<string>;
  private readonly disabled: Set<string>;

  constructor(
    policy: PermissionPolicy,
    options: { enabled?: string[]; disabled?: string[]; tools?: ToolDefinition[] } = {},
  ) {
    for (const tool of options.tools ?? defaultTools()) this.tools.set(tool.name, tool);
    this.engine = new PermissionEngine(policy);
    this.enabled = new Set(options.enabled ?? []);
    this.disabled = new Set(options.disabled ?? []);
  }

  get permissions(): PermissionEngine {
    return this.engine;
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].filter((tool) => this.isEnabled(tool.name));
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  isEnabled(name: string): boolean {
    if (this.disabled.has(name)) return false;
    if (this.enabled.size > 0 && !this.enabled.has(name)) return false;
    return true;
  }

  /** Publish the tool catalogue to providers that support tool calling. */
  specs(): ProviderToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Ask the permission engine what would happen, without doing anything. Used
   * by the CLI to preview a call and by tests to assert policy behaviour.
   */
  preview(call: ToolCall, ctx: ToolContext) {
    const tool = this.tools.get(call.name);
    if (!tool) return { allowed: false, prompt: false, reason: `unknown tool: ${call.name}` };
    const request = requestFor(tool, call, ctx);
    const verdict = this.engine.decide(request);
    return { ...verdict, request };
  }

  async invoke(call: ToolCall, ctx: ToolContext): Promise<InvokeOutcome> {
    const started = Date.now();
    const tool = this.tools.get(call.name);

    if (!tool) {
      const result = toolResultFrom(call, { ok: false, summary: `Unknown tool "${call.name}".`, error: 'unknown tool' }, { bytes: 0, truncated: false, duration_ms: 0 });
      return { result, forModel: result.summary, refused: true };
    }
    if (!this.isEnabled(tool.name)) {
      const result = toolResultFrom(call, { ok: false, summary: `Tool "${call.name}" is disabled by configuration.`, error: 'tool disabled' }, { bytes: 0, truncated: false, duration_ms: 0 });
      return { result, forModel: result.summary, refused: true };
    }

    const request = requestFor(tool, call, ctx);
    const verdict = this.engine.decide(request);

    if (!verdict.allowed) {
      const result = toolResultFrom(
        call,
        { ok: false, summary: `Refused: ${verdict.reason}.`, error: verdict.reason },
        { bytes: 0, truncated: false, duration_ms: Date.now() - started },
      );
      ctx.events.record('tool_call', `refused ${tool.name}: ${verdict.reason}`, { tool: tool.name, call_id: call.id });
      return { result, forModel: result.summary, refused: true };
    }

    if (verdict.prompt) {
      const approver = ctx.confirm;
      const approved = approver ? await approver(request) : false;
      if (!approved) {
        const result = toolResultFrom(
          call,
          { ok: false, summary: `Not approved: ${request.summary}`, error: 'not approved by user' },
          { bytes: 0, truncated: false, duration_ms: Date.now() - started },
        );
        ctx.events.record('tool_call', `declined ${tool.name}: ${request.summary}`, { tool: tool.name, call_id: call.id });
        return { result, forModel: result.summary, refused: true };
      }
      this.engine.approve(request.subject);
    }

    ctx.events.record('tool_call', `invoked ${tool.name}`, { tool: tool.name, call_id: call.id, arguments: call.arguments });

    let run: ToolRunResult;
    try {
      run = await tool.run(call.arguments, ctx);
    } catch (error) {
      const message = error instanceof ToolArgumentError ? error.message : (error as Error).message;
      run = { ok: false, summary: `Tool ${tool.name} failed: ${message}`, error: message };
    }

    const text = run.output ?? run.summary;
    // A fixed inline ceiling: tool output entering context must stay small no
    // matter how much the terminal was allowed to capture (§56).
    const manager = new OutputManager(ctx.artifactsDir, { inline_limit: 8_000 });
    const processed = await manager.process({ text, label: call.name, ...(run.error === undefined ? {} : { error: run.error }) });

    const inline = processed.spilled
      ? `${run.summary.split('\n')[0]}\n\n${processed.inline}`
      : truncate(text, 16_000, '…[output truncated]');

    const result = toolResultFrom(call, run, {
      bytes: processed.bytes,
      truncated: processed.truncated,
      duration_ms: Date.now() - started,
      ...(processed.artifactPath === undefined ? {} : { artifactPath: processed.artifactPath }),
    });

    ctx.events.record('tool_result', `${tool.name} ${result.ok ? 'succeeded' : 'failed'}`, {
      tool: tool.name,
      call_id: call.id,
      ok: result.ok,
      exit_code: result.exit_code,
      affected_files: result.affected_files,
      artifact: processed.artifactPath,
    });

    if (!result.ok && processed.errors.length > 0) {
      return {
        result: { ...result, summary: `${result.summary}\n${processed.errors.slice(0, 10).join('\n')}` },
        forModel: `${inline}\n\n${truncate(processed.errors.join('\n'), 2_000)}`,
        ...(run.output === undefined ? {} : { raw: run.output }),
        ...(processed.artifactPath === undefined ? {} : { artifactPath: processed.artifactPath }),
        refused: false,
      };
    }

    return {
      result,
      forModel: inline,
      ...(run.output === undefined ? {} : { raw: run.output }),
      ...(processed.artifactPath === undefined ? {} : { artifactPath: processed.artifactPath }),
      refused: false,
    };
  }
}

function requestFor(tool: ToolDefinition, call: ToolCall, ctx: ToolContext): PermissionRequest {
  if (tool.permission) {
    try {
      return tool.permission(call.arguments, ctx);
    } catch {
      // A malformed argument set must not bypass the policy.
    }
  }
  return {
    summary: `${call.name}`,
    resource: tool.category === 'terminal' ? 'command' : 'tool',
    subject: call.name,
    destructive: tool.mutating,
  };
}

/** Convenience: build a registry from a full config. */
export function registryFromConfig(
  config: Parameters<typeof policyFromConfig>[0] & { tools: { enabled: string[]; disabled: string[] } },
  options: { disableAll?: boolean } = {},
): ToolRegistry {
  return new ToolRegistry(policyFromConfig(config), {
    enabled: options.disableAll === true ? ['__none__'] : config.tools.enabled,
    disabled: config.tools.disabled,
  });
}

export function policyFromConfig(config: {
  permissions: {
    mode: PermissionPolicy['mode'];
    allow: string[];
    deny: string[];
    allow_outside_project: boolean;
    require_confirmation_for_destructive: boolean;
  };
}): PermissionPolicy {
  return {
    mode: config.permissions.mode,
    allow: config.permissions.allow,
    deny: config.permissions.deny,
    allow_outside_project: config.permissions.allow_outside_project,
    require_confirmation_for_destructive: config.permissions.require_confirmation_for_destructive,
  };
}

/** Thrown internally when a tool name is requested that does not exist. */
export function assertKnownTool(registry: ToolRegistry, name: string): ToolDefinition {
  const tool = registry.get(name);
  if (!tool) {
    throw new LowContextError('TOOL_UNKNOWN', `Unknown tool: ${name}`, { fix: 'Run `low-context tools list` to see available tools' });
  }
  return tool;
}
