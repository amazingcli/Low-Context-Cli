/**
 * Verification pipeline (§21, §22, §51).
 *
 * Low Context refuses to equate "the write succeeded" with "the change is
 * correct". After any mutation the agent:
 *
 *   1. re-reads the changed files and confirms they still exist and are
 *      non-empty, computing their hash so the index can be refreshed;
 *   2. reports the actual changed region so the model reasons about real code;
 *   3. optionally runs the project's configured check command and records its
 *      exit code — and only a real exit code counts.
 *
 * A verification result is `verified` only when the check ran and passed. If no
 * check is configured, the state is `indexed`, never `verified` (§51: no false
 * confidence).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { executeCommand } from '../tools/terminal.js';
import { contentHash, formatBytes, truncate } from '../core/util.js';
import { isInside } from '../core/paths.js';
import { OutputManager } from '../tools/output.js';
import type { LowContextConfig } from '../core/config.js';
import type { VerificationState } from '../core/types.js';
import type { Logger } from '../core/logger.js';

export interface FileVerification {
  path: string;
  exists: boolean;
  bytes: number;
  lines: number;
  hash: string;
  /** First few non-blank lines after the change, for the model to sanity-check. */
  preview: string;
}

export interface VerificationReport {
  files: FileVerification[];
  /** undefined when no check command is configured. */
  command?: { command: string; exit_code: number | null; output: string; duration_ms: number; timed_out: boolean };
  passed: boolean;
  state: VerificationState;
  summary: string;
  artifactPath?: string;
}

export interface VerifyOptions {
  projectRoot: string;
  config: LowContextConfig;
  affectedFiles: readonly string[];
  logger: Logger;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Skip the check command even when one is configured. */
  skipCommand?: boolean;
  onNote?: (message: string) => void;
}

export async function verifyAfterAction(options: VerifyOptions): Promise<VerificationReport> {
  const files: FileVerification[] = [];
  for (const path of dedupe(options.affectedFiles)) {
    const abs = join(options.projectRoot, path);
    if (!isInside(options.projectRoot, abs)) continue;
    try {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const text = await readFile(abs, 'utf8');
      const nonBlank = text.split('\n').filter((line) => line.trim() !== '');
      files.push({
        path,
        exists: true,
        bytes: info.size,
        lines: text.split('\n').length,
        hash: contentHash(text),
        preview: truncate(nonBlank.slice(0, 6).join('\n'), 500),
      });
    } catch {
      files.push({ path, exists: false, bytes: 0, lines: 0, hash: '', preview: '(not readable after change)' });
    }
  }

  const command = options.config.verification.command;
  const shouldRun =
    options.skipCommand !== true &&
    options.config.verification.enabled &&
    typeof command === 'string' &&
    command.trim() !== '';

  if (!shouldRun) {
    return {
      files,
      passed: files.every((file) => file.exists),
      state: 'indexed',
      summary: summarizeWithoutCheck(files, command),
    };
  }

  options.onNote?.(`verifying with: ${command}`);
  const outcome = await executeCommand(command as string, {
    cwd: options.projectRoot,
    timeoutMs: options.timeoutMs ?? Math.max(options.config.permissions.timeout_ms, 120_000),
    maxOutputBytes: options.config.permissions.max_output_bytes,
    env: sanitizedEnv(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const combined = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n');
  const manager = new OutputManager(`${options.projectRoot}/.low-context/artifacts`);
  const processed = await manager.process({ text: combined, label: 'verify' });
  const exitCode = outcome.exit_code ?? -1;
  const passed = exitCode === 0 && !outcome.timed_out;

  options.logger.info('verification.run', {
    command,
    exit_code: exitCode,
    timed_out: outcome.timed_out,
    duration_ms: outcome.duration_ms,
    files: files.map((f) => f.path),
  });

  return {
    files,
    command: { command: command as string, exit_code: outcome.exit_code, output: processed.inline, duration_ms: outcome.duration_ms, timed_out: outcome.timed_out },
    passed,
    state: passed ? 'verified' : 'stale',
    summary: [
      `check: ${command}`,
      `result: ${passed ? 'PASSED' : outcome.timed_out ? 'TIMED OUT' : `FAILED (exit ${exitCode})`}`,
      `files re-read: ${files.filter((f) => f.exists).length}/${files.length}`,
      processed.errors.length > 0 ? `diagnostics:\n${processed.errors.slice(0, 8).join('\n')}` : '',
    ]
      .filter((line) => line !== '')
      .join('\n'),
    ...(processed.artifactPath === undefined ? {} : { artifactPath: processed.artifactPath }),
  };
}

function summarizeWithoutCheck(files: readonly FileVerification[], command: string | undefined): string {
  const lines = [`files re-read: ${files.filter((f) => f.exists).length}/${files.length}`];
  const missing = files.filter((f) => !f.exists).map((f) => f.path);
  if (missing.length > 0) lines.push(`missing after change: ${missing.join(', ')}`);
  lines.push(
    command
      ? 'no automatic check ran (verification disabled). Treat the change as unverified.'
      : 'no verification command configured. Treat the change as unverified and say so.',
  );
  return lines.join('\n');
}

/** Environment for verification commands: no credentials, stable locale. */
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(API[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    out[key] = value;
  }
  out.CI = '1';
  out.LOW_CONTEXT_VERIFY = '1';
  return out;
}

/** Include the changed region in the model's observation, not the whole file. */
export function renderVerification(report: VerificationReport): string {
  const parts: string[] = [report.summary];
  for (const file of report.files) {
    if (!file.exists) continue;
    parts.push(`--- ${file.path} (${file.lines} lines, ${formatBytes(file.bytes)}, hash ${file.hash.slice(0, 12)}) ---`);
    parts.push(file.preview);
  }
  return parts.join('\n');
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.filter((item) => item.trim() !== ''))];
}
