/**
 * Permission engine (§20, §80).
 *
 * Three modes, one decision function:
 *
 *   safe     read-only tools run; anything mutating is refused outright.
 *   ask      read-only runs; mutating operations need an explicit yes.
 *   trusted  everything allowed except hard denies.
 *
 * Deny rules always win over allow rules, and over the mode. That ordering is
 * deliberate: a project-local config can only *tighten* the policy, never
 * loosen it (§25), so cloning an untrusted repository cannot grant itself
 * shell access.
 *
 * The engine is also the layer that refuses obviously destructive commands
 * (rm -rf /, fork bombs, curl | sh) even in `trusted` mode unless the user
 * wrote an explicit allow rule for them.
 */
import { isInside, toPosix } from '../core/paths.js';
import type { PermissionDecision, PermissionMode } from '../core/types.js';
import type { PermissionRequest } from './types.js';

export interface PermissionPolicy {
  mode: PermissionMode;
  allow: string[];
  deny: string[];
  allow_outside_project: boolean;
  require_confirmation_for_destructive: boolean;
}

export interface PermissionVerdict extends PermissionDecision {
  /** True when the caller must prompt before proceeding. */
  prompt: boolean;
}

/** Patterns that are never run without an explicit allow rule. */
const CATASTROPHIC_COMMAND_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\/\s*($|[;&|])/, why: 'recursive delete of the filesystem root' },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(~|\$HOME)(\s|\/|$)/, why: 'recursive delete of the home directory' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/, why: 'filesystem format' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk)/, why: 'raw disk write' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'host shutdown' },
  { re: /\bchmod\s+-R\s+777\s+\//, why: 'world-writable filesystem root' },
  { re: /\bgit\s+push\b[^\n]*(--force|-f)\b/, why: 'force push' },
  { re: /\bDROP\s+(DATABASE|SCHEMA)\b/i, why: 'destructive database statement' },
  { re: /\bTRUNCATE\s+TABLE\b/i, why: 'destructive database statement' },
  { re: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'pipe remote script into a shell' },
  { re: /\bwget\b[^\n]*-O\s*-\s*\|/, why: 'pipe remote script into a shell' },
  { re: /\bnpm\s+publish\b/, why: 'publishing a package' },
  { re: /\bdocker\s+(rm|rmi|system\s+prune)\b/, why: 'removing containers or images' },
  { re: /\bkubectl\s+delete\b/, why: 'deleting cluster resources' },
];

/** Commands that are safe to run read-only. */
const READ_ONLY_COMMAND_PREFIXES = [
  'ls', 'cat', 'pwd', 'echo', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'fd',
  'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote',
  'node --version', 'npm --version', 'python --version', 'python3 --version',
  'go version', 'rustc --version', 'cargo --version', 'tsc --version',
  'which', 'whereis', 'file', 'stat', 'du', 'df', 'env', 'printenv', 'date',
  'node -e', 'npm ls', 'pnpm ls', 'yarn list', 'tree',
];

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  if (/[;&|><]/.test(trimmed.replace(/\|\|\s*(true|exit 0)$/, ''))) return false;
  return READ_ONLY_COMMAND_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}

/** Inspect a shell command for obvious danger. */
export function commandRisk(command: string): { dangerous: boolean; why?: string } {
  for (const pattern of CATASTROPHIC_COMMAND_PATTERNS) {
    if (pattern.re.test(command)) return { dangerous: true, why: pattern.why };
  }
  return { dangerous: false };
}

/** True when the command can change the working tree in a meaningful way. */
export function commandIsMutating(command: string): boolean {
  if (isReadOnlyCommand(command)) return false;
  const writeish = /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|install|tee|sed\s+-i|truncate|dd)\b/;
  const buildish = /\b(npm|pnpm|yarn|bun|pip|pip3|poetry|uv|cargo|go|make|gradle|mvn|dotnet)\b/;
  const gitWrite = /\bgit\s+(commit|add|checkout|switch|reset|rebase|merge|cherry-pick|stash|apply|clean|push|tag)\b/;
  return writeish.test(command) || buildish.test(command) || gitWrite.test(command);
}

/* ------------------------------- rule parsing ------------------------------ */

interface Rule {
  raw: string;
  target: 'tool' | 'command' | 'path' | 'any';
  pattern: RegExp;
}

function compileRule(raw: string): Rule {
  const negated = raw.startsWith('!');
  const body = negated ? raw.slice(1) : raw;
  const [prefix, ...rest] = body.split(':');
  const target = prefix === 'tool' || prefix === 'command' || prefix === 'path' ? prefix : 'any';
  const pattern = target === 'any' ? body : rest.join(':');
  return {
    raw,
    target,
    pattern: globToRegExp(pattern.trim()),
  };
}

/** Convert a small glob (`src/**`, `git *`) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '.';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

export class PermissionEngine {
  private readonly policy: PermissionPolicy;
  private readonly allowRules: Rule[];
  private readonly denyRules: Rule[];
  /** Resources approved during this run, so the user is asked once per thing. */
  private readonly sessionApprovals = new Set<string>();
  /**
   * Session-scoped bypass (§20), toggled by the explicit `/nopermission`
   * slash command. It removes confirmations and mode limits so a trusted user
   * is not interrupted mid-task. Two things still apply, on purpose: deny
   * rules, and the always-refused catastrophic command patterns. A bypass that
   * silently allowed `rm -rf /` would be a bug, not a convenience.
   */
  private bypass = false;

  constructor(policy: PermissionPolicy) {
    this.policy = policy;
    this.allowRules = policy.allow.map(compileRule);
    this.denyRules = policy.deny.filter((r) => !r.startsWith('!')).map(compileRule);
  }

  /** Turn confirmations off (or back on) for the rest of the session. */
  setBypass(on: boolean): void {
    this.bypass = on;
  }

  get bypassing(): boolean {
    return this.bypass;
  }

  /** Remember an approval so the same resource is not re-prompted. */
  approve(subject: string): void {
    this.sessionApprovals.add(subject);
  }

  decide(request: PermissionRequest): PermissionVerdict {
    const resource = request.resource === 'path' ? toPosix(request.subject) : request.subject;

    const denied = this.denyRules.find((rule) => matches(rule, request, resource));
    if (denied) {
      return { allowed: false, needs_confirmation: false, reason: `denied by rule "${denied.raw}"`, rule: denied.raw, prompt: false };
    }

    if (request.resource === 'command') {
      const risk = commandRisk(request.subject);
      if (risk.dangerous && !this.allowRules.some((rule) => matches(rule, request, resource))) {
        return {
          allowed: false,
          needs_confirmation: false,
          reason: `refused: ${risk.why}`,
          prompt: false,
        };
      }
    }

    const allowed = this.allowRules.find((rule) => matches(rule, request, resource));
    if (allowed) {
      return { allowed: true, needs_confirmation: false, reason: `allowed by rule "${allowed.raw}"`, rule: allowed.raw, prompt: false };
    }

    if (!request.destructive && request.resource !== 'command') {
      // Non-destructive tool use that a rule did not single out.
      if (this.policy.mode === 'safe') {
        return { allowed: true, needs_confirmation: false, reason: 'read-only tool in safe mode', prompt: false };
      }
    }

    if (this.sessionApprovals.has(request.subject)) {
      return { allowed: true, needs_confirmation: false, reason: 'approved earlier in this session', prompt: false };
    }

    // Bypass sits after deny rules and the catastrophic check, before the mode
    // switch: nothing dangerous becomes reachable just because the user turned
    // prompts off.
    if (this.bypass) {
      return { allowed: true, needs_confirmation: false, reason: 'permission bypass is on', prompt: false };
    }

    switch (this.policy.mode) {
      case 'trusted':
        return { allowed: true, needs_confirmation: false, reason: 'trusted mode', prompt: false };
      case 'safe':
        return {
          allowed: false,
          needs_confirmation: false,
          reason: 'safe mode refuses mutating operations',
          prompt: false,
        };
      case 'ask':
      default:
        return {
          allowed: true,
          needs_confirmation: this.policy.require_confirmation_for_destructive ? request.destructive : true,
          reason: 'needs confirmation',
          prompt: true,
        };
    }
  }

  /**
   * Resolve a filesystem path against the project root, rejecting traversal
   * and (unless explicitly allowed) writes outside the project (§80).
   */
  resolvePath(rawPath: string, projectRoot: string, options: { mustExist?: boolean } = {}): { ok: true; path: string } | { ok: false; reason: string } {
    const absolute = rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath);
    const resolved = absolute ? rawPath : `${projectRoot.replace(/\/$/, '')}/${rawPath}`;
    const normalized = normalizePath(resolved);
    if (!isInside(projectRoot, normalized) && !this.policy.allow_outside_project) {
      return { ok: false, reason: `path escapes the project root: ${rawPath}` };
    }
    void options;
    return { ok: true, path: normalized };
  }
}

function matches(rule: Rule, request: PermissionRequest, resource: string): boolean {
  if (rule.target !== 'any' && rule.target !== request.resource) return false;
  return rule.pattern.test(resource);
}

/** Collapse `.` and `..` segments without touching the filesystem. */
export function normalizePath(path: string): string {
  const isAbsolute = path.startsWith('/');
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  const joined = parts.join('/');
  return isAbsolute ? `/${joined}` : joined;
}
