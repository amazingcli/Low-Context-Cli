/**
 * Terminal UI (§28, §78).
 *
 * The interface has to communicate what the agent is retrieving without
 * drowning the user in noise, so the design rules are:
 *
 *  - model output streams plainly; tool activity is prefixed and dimmed so it
 *    reads as machinery, not as the answer;
 *  - context and retrieval information is available but off the main path —
 *    shown in `verbose`/`debug`, one line otherwise;
 *  - confirmations always show the exact command or path being approved, never a
 *    paraphrase (§20: "clear command preview");
 *  - nothing writes ANSI codes when output is not a TTY or colour is disabled.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { formatBytes, formatCount, truncate } from '../core/util.js';
/**
 * Width of a string as the terminal sees it: ANSI escapes are zero-width.
 * Every framed box, padded column and status line depends on this, so it lives
 * here next to the colour code that produces those escapes.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export function visibleWidth(text) {
    return text.replace(ANSI, '').length;
}
/**
 * Terminal width for layout, with two guards: `columns` is undefined when the
 * stream is not a TTY, and some pty wrappers report 0 — both would collapse a
 * box to its minimum width instead of filling the window.
 */
export function terminalWidth() {
    const columns = stdout.columns;
    return columns !== undefined && columns > 20 ? columns : 80;
}
const CODES = {
    reset: '\u001b[0m',
    bold: '\u001b[1m',
    dim: '\u001b[2m',
    italic: '\u001b[3m',
    red: '\u001b[31m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    blue: '\u001b[34m',
    magenta: '\u001b[35m',
    cyan: '\u001b[36m',
    gray: '\u001b[90m',
};
export class Ui {
    enabled;
    options;
    spinnerTimer;
    spinnerFrame = 0;
    spinnerText = '';
    spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    streaming = false;
    constructor(options) {
        this.options = options;
        this.enabled =
            options.color === 'always' || (options.color === 'auto' && stdout.isTTY === true && process.env.NO_COLOR === undefined);
    }
    get colorEnabled() {
        return this.enabled;
    }
    get quiet() {
        return this.options.responseMode === 'quiet';
    }
    get debug() {
        return this.options.responseMode === 'debug';
    }
    get verbose() {
        return this.options.responseMode === 'verbose' || this.debug;
    }
    get responseMode() {
        return this.options.responseMode;
    }
    /**
     * Switch verbosity mid-session (`/verbose`, `/debug`, `/quiet`). The UI is
     * constructed once per process, so the mode has to be mutable for the slash
     * commands to mean anything.
     */
    setResponseMode(mode) {
        this.options.responseMode = mode;
    }
    color(name, text) {
        if (!this.enabled)
            return text;
        return `${CODES[name]}${text}${CODES.reset}`;
    }
    bold(text) {
        return this.color('bold', text);
    }
    dim(text) {
        return this.color('dim', text);
    }
    /** Standard output; suppressed entirely in quiet mode. */
    out(text = '') {
        if (this.quiet)
            return;
        this.stopSpinner();
        this.clearStreaming();
        stdout.write(`${text}\n`);
    }
    /** Always printed, even in quiet mode: results the user asked for. */
    result(text = '') {
        this.stopSpinner();
        this.clearStreaming();
        stdout.write(`${text}\n`);
    }
    info(text) {
        this.out(`${this.color('cyan', '·')} ${text}`);
    }
    success(text) {
        this.out(`${this.color('green', '✔')} ${text}`);
    }
    warn(text) {
        this.stopSpinner();
        this.clearStreaming();
        stderr.write(`${this.color('yellow', '!')} ${text}\n`);
    }
    error(text) {
        this.stopSpinner();
        this.clearStreaming();
        stderr.write(`${this.color('red', '✖')} ${text}\n`);
    }
    note(text) {
        if (!this.verbose)
            return;
        this.stopSpinner();
        this.clearStreaming();
        stderr.write(`${this.color('gray', `[${text}]`)}\n`);
    }
    heading(text) {
        this.out('');
        this.out(this.bold(text));
        this.out(this.dim('─'.repeat(Math.min(60, Math.max(12, text.length + 4)))));
    }
    /** A full-width hairline, used to close a turn or separate sections. */
    divider(indent = 2, char = '─') {
        const width = Math.max(20, terminalWidth() - indent - 2);
        this.out(`${' '.repeat(indent)}${this.dim(char.repeat(width))}`);
    }
    /**
     * A titled box of label/value rows.
     *
     * Values are passed *plain* and truncated to fit, because padding a string
     * that contains colour codes is how terminal UIs end up ragged. Colours are
     * applied by this method, after the width maths.
     */
    box(title, rows, options = {}) {
        const indent = ' '.repeat(options.indent ?? 0);
        const labelWidth = options.labelWidth ?? Math.max(0, ...rows.map(([label]) => label.length));
        const maxWidth = options.maxWidth ?? Math.max(44, terminalWidth() - (options.indent ?? 0) - 2);
        const valueWidth = Math.max(10, maxWidth - labelWidth - 5);
        const prepared = rows.map(([label, value]) => [label.padEnd(labelWidth), truncate(value, valueWidth, '…')]);
        // +1 so the widest row keeps a space before the closing border.
        const inner = Math.max(title.length + 4, ...prepared.map(([, value]) => labelWidth + 3 + visibleWidth(value)));
        const rule = '─'.repeat(Math.max(0, inner - title.length - 3));
        this.out(`${indent}${this.dim(`╭─ ${this.boldNoReset(title)} ${rule}╮`)}`);
        for (const [label, value] of prepared) {
            const pad = ' '.repeat(Math.max(0, inner - labelWidth - 2 - visibleWidth(value)));
            this.out(`${indent}${this.dim('│')} ${this.dim(label)}  ${value}${pad}${this.dim('│')}`);
        }
        this.out(`${indent}${this.dim(`╰${'─'.repeat(inner + 1)}╯`)}`);
    }
    /** Bold text that does not reset the surrounding colour (used inside a line). */
    boldNoReset(text) {
        return this.enabled ? `${CODES.bold}${text}${CODES.reset}${CODES.dim}` : text;
    }
    /**
     * Attention block. Errors and warnings carry a `fix` line when the caller has
     * one, because "what do I type next" is the only useful part of a failure
     * (§45, §90).
     */
    alert(kind, message, lines = []) {
        const marker = kind === 'error' ? this.color('red', '✖') : kind === 'warn' ? this.color('yellow', '!') : this.color('cyan', '·');
        this.stopSpinner();
        this.clearStreaming();
        stderr.write(`${marker} ${kind === 'info' ? message : this.color(kind === 'error' ? 'red' : 'yellow', message)}\n`);
        for (const line of lines)
            stderr.write(`${this.dim(`  ${line}`)}\n`);
    }
    keyValue(pairs, indent = '  ') {
        const width = Math.max(...pairs.map(([key]) => key.length), 0);
        for (const [key, value] of pairs)
            this.out(`${indent}${this.dim(key.padEnd(width))}  ${value}`);
    }
    table(headers, rows) {
        if (rows.length === 0) {
            this.out(this.dim('  (nothing to show)'));
            return;
        }
        const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
        const render = (cells) => cells.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ').trimEnd();
        this.out(`  ${this.dim(render(headers))}`);
        for (const row of rows)
            this.out(`  ${render(row)}`);
    }
    /** Streaming model output; keeps a single writer so chunks do not interleave. */
    stream(text) {
        if (this.quiet)
            return;
        this.stopSpinner();
        this.streaming = true;
        stdout.write(text);
    }
    endStream() {
        if (this.streaming) {
            stdout.write('\n');
            this.streaming = false;
        }
    }
    clearStreaming() {
        if (this.streaming) {
            stdout.write('\n');
            this.streaming = false;
        }
    }
    startSpinner(text) {
        if (!this.options.spinner || !stdout.isTTY || this.quiet)
            return;
        this.spinnerText = text;
        if (this.spinnerTimer)
            return;
        this.spinnerTimer = setInterval(() => {
            const frame = this.spinnerFrames[this.spinnerFrame % this.spinnerFrames.length];
            this.spinnerFrame += 1;
            stdout.write(`\r${this.color('cyan', frame)} ${this.dim(this.spinnerText)}\u001b[K`);
        }, 90);
        this.spinnerTimer.unref?.();
    }
    updateSpinner(text) {
        this.spinnerText = text;
    }
    stopSpinner() {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = undefined;
            stdout.write('\r\u001b[K');
        }
    }
    /** Tool activity line: `⏺ tool args` (§28). */
    toolLine(name, detail, icon = '⏺') {
        this.out(`  ${this.color('magenta', icon)} ${this.bold(name)}${detail === '' ? '' : `  ${this.dim(detail)}`}`);
    }
    /** Result line under a tool call, the way Claude Code nests output. */
    toolResultLine(ok, text) {
        const badge = ok ? this.color('green', '✓') : this.color('red', '✗');
        this.out(`    ${this.dim('⎿')} ${badge} ${text}`);
    }
    /** Ask a yes/no question. Non-interactive streams default to "no". */
    async confirm(question, options = {}) {
        this.stopSpinner();
        this.clearStreaming();
        if (!stdin.isTTY) {
            stderr.write(`${this.color('yellow', '!')} ${question} — not a terminal, assuming no\n`);
            return false;
        }
        if (options.detail)
            stderr.write(`${options.detail}\n`);
        const rl = createInterface({ input: stdin, output: stderr });
        try {
            const answer = (await rl.question(`${this.color('yellow', '?')} ${question} ${this.dim(options.defaultYes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
            if (answer === '')
                return options.defaultYes === true;
            return answer === 'y' || answer === 'yes';
        }
        finally {
            rl.close();
        }
    }
    async ask(question, fallback = '') {
        this.stopSpinner();
        this.clearStreaming();
        if (!stdin.isTTY)
            return fallback;
        const rl = createInterface({ input: stdin, output: stderr });
        try {
            const answer = (await rl.question(`${this.color('cyan', '?')} ${question} `)).trim();
            return answer === '' ? fallback : answer;
        }
        finally {
            rl.close();
        }
    }
    /** Ask for a secret without echoing it to the terminal or the scrollback. */
    async askSecret(question) {
        this.stopSpinner();
        this.clearStreaming();
        if (!stdin.isTTY)
            return '';
        const rl = createInterface({ input: stdin, output: stderr, terminal: true });
        const mutable = rl;
        const original = mutable._writeToOutput;
        mutable._writeToOutput = () => {
            // Swallow the echo; the prompt itself is written before this is set.
        };
        try {
            const answer = await rl.question(`${this.color('cyan', '?')} ${question} `);
            stderr.write('\n');
            return answer.trim();
        }
        finally {
            mutable._writeToOutput = original;
            rl.close();
        }
    }
}
export function formatTokensShort(tokens) {
    return formatCount(tokens);
}
export function describeSize(bytes) {
    return formatBytes(bytes);
}
export function createUi(options = {}) {
    const env = process.env;
    const color = options.color ??
        (env.LOW_CONTEXT_NO_COLOR === '1' ? 'never' : env.LOW_CONTEXT_COLOR === 'always' ? 'always' : 'auto');
    const responseMode = options.responseMode ??
        (env.LOW_CONTEXT_RESPONSE_MODE ?? 'normal');
    return new Ui({ color, responseMode, spinner: options.spinner ?? true });
}
//# sourceMappingURL=ui.js.map