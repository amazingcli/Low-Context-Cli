/**
 * Terminal execution (§19, §20, §58).
 *
 * Execution is deliberately conservative:
 *
 *  - commands run through `/bin/sh -c` (or `cmd` on Windows) in the project
 *    root, never anywhere else unless the permission engine allowed it;
 *  - a hard timeout kills the process group, so a hung build cannot wedge the
 *    agent;
 *  - stdout and stderr are captured up to a byte cap and then truncated, with
 *    the full text still available through the artifact the OutputManager
 *    writes;
 *  - the child environment drops anything that looks like a credential unless
 *    the user explicitly allow-listed it (§80).
 *
 * The tool itself never decides whether running is allowed — that is the
 * permission engine's job, asked before `run` is called.
 */
import { spawn } from 'node:child_process';
import { buildChildEnv } from '../security/redact.js';
import { formatBytes } from '../core/util.js';
import { asNumber, asOptionalString, asString, numberProp, objectSchema, stringProp } from './types.js';
import { commandIsMutating } from './permissions.js';
/** Run a shell command, resolving with a complete outcome rather than throwing. */
export function executeCommand(command, options) {
    return new Promise((resolve) => {
        const started = Date.now();
        const isWindows = process.platform === 'win32';
        const shell = options.shell ?? (isWindows ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh');
        const args = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const child = spawn(shell, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            detached: !isWindows,
        });
        const finish = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            resolve({ stdout, stderr, exit_code: exitCode, signal, timed_out: timedOut, duration_ms: Date.now() - started, truncated });
        };
        const append = (chunk, stream) => {
            const target = stream === 'stdout' ? stdout : stderr;
            const next = target + chunk;
            if (target.length >= options.maxOutputBytes) {
                truncated = true;
            }
            else if (next.length > options.maxOutputBytes) {
                truncated = true;
                const cut = `${next.slice(0, options.maxOutputBytes)}\n…[${stream} truncated at ${formatBytes(options.maxOutputBytes)}]`;
                if (stream === 'stdout')
                    stdout = cut;
                else
                    stderr = cut;
            }
            else if (stream === 'stdout')
                stdout = next;
            else
                stderr = next;
            options.onData?.(chunk, stream);
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => append(chunk, 'stdout'));
        child.stderr?.on('data', (chunk) => append(chunk, 'stderr'));
        const killGroup = (signal) => {
            if (child.pid === undefined)
                return;
            try {
                if (isWindows)
                    child.kill(signal);
                else
                    process.kill(-child.pid, signal);
            }
            catch {
                try {
                    child.kill(signal);
                }
                catch {
                    // Already gone.
                }
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 2_000).unref?.();
        }, options.timeoutMs);
        timer.unref?.();
        const onAbort = () => {
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 1_000).unref?.();
            finish(null, 'SIGTERM');
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (error) => {
            stderr += `\n[spawn error] ${error.message}`;
            finish(null, null);
        });
        child.on('close', (code, signal) => finish(code, signal));
    });
}
const runCommandTool = {
    name: 'run_command',
    description: 'Run a shell command in the project root and return its exit code with stdout and stderr. Use it to build, test, inspect git state or reproduce a failure. Long output is truncated with the full text saved to an artifact.',
    category: 'terminal',
    mutating: true,
    parameters: objectSchema({
        command: stringProp('The command line to execute.'),
        cwd: stringProp('Project-relative working directory. Defaults to the project root.'),
        timeout_ms: numberProp('Kill the command after this many milliseconds.', { minimum: 100 }),
    }, ['command']),
    permission: (args) => {
        const command = asOptionalString(args, 'command') ?? '';
        return {
            summary: `run: ${command}`,
            resource: 'command',
            subject: command,
            destructive: commandIsMutating(command),
        };
    },
    async run(args, ctx) {
        const command = asString(args, 'command');
        if (command.trim() === '')
            return { ok: false, summary: 'empty command', error: 'empty command' };
        if (ctx.signal?.aborted)
            return { ok: false, summary: 'cancelled before execution', error: 'cancelled' };
        const relativeCwd = asOptionalString(args, 'cwd');
        const cwd = relativeCwd ? `${ctx.projectRoot.replace(/\/$/, '')}/${relativeCwd.replace(/^\.\//, '')}` : ctx.projectRoot;
        const timeoutMs = asNumber(args, 'timeout_ms', { fallback: ctx.config.permissions.timeout_ms });
        const maxOutputBytes = ctx.config.permissions.max_output_bytes;
        const env = buildChildEnv(process.env, {
            allow: ctx.config.permissions.env_allowlist,
            deny: [],
            extra: { LOW_CONTEXT: '1' },
        });
        ctx.note?.(`running: ${command}`);
        const outcome = await executeCommand(command, {
            cwd,
            timeoutMs,
            maxOutputBytes,
            env,
            signal: ctx.signal,
            onData: (chunk, stream) => {
                if (ctx.config.ui.response_mode === 'verbose' && stream === 'stderr')
                    ctx.note?.(chunk.trimEnd());
            },
        });
        const combined = [outcome.stdout, outcome.stderr].filter((part) => part.trim() !== '').join('\n');
        const status = outcome.timed_out
            ? `timed out after ${timeoutMs} ms`
            : outcome.exit_code === 0
                ? 'exit 0'
                : `exit ${outcome.exit_code ?? (outcome.signal ? `signal ${outcome.signal}` : 'unknown')}`;
        const header = `$ ${command}\n[${status} in ${outcome.duration_ms} ms${outcome.truncated ? ', output truncated' : ''}]`;
        return {
            summary: combined.trim() === '' ? `${header}\n(no output)` : `${header}\n${combined}`,
            output: combined,
            ok: outcome.exit_code === 0 && !outcome.timed_out,
            exit_code: outcome.exit_code ?? -1,
            verification_state: 'verified',
            affected_files: [],
            data: {
                timed_out: outcome.timed_out,
                truncated: outcome.truncated,
                stdout: outcome.stdout,
                stderr: outcome.stderr,
            },
            ...(outcome.exit_code === 0 && !outcome.timed_out
                ? {}
                : {
                    error: outcome.timed_out
                        ? `command timed out after ${timeoutMs} ms`
                        : `command exited with code ${outcome.exit_code ?? 'unknown'}`,
                }),
        };
    },
};
export const TERMINAL_TOOLS = [runCommandTool];
//# sourceMappingURL=terminal.js.map