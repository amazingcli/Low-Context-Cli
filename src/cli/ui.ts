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
import { formatBytes, formatCount } from '../core/util.js';

export type ColorMode = 'auto' | 'always' | 'never';
export type ResponseMode = 'normal' | 'verbose' | 'quiet' | 'debug';

export interface UiOptions {
  color: ColorMode;
  responseMode: ResponseMode;
  spinner: boolean;
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
} as const;

export type ColorName = keyof typeof CODES;

export class Ui {
  private readonly enabled: boolean;
  private readonly options: UiOptions;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private spinnerFrame = 0;
  private spinnerText = '';
  private readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private streaming = false;

  constructor(options: UiOptions) {
    this.options = options;
    this.enabled =
      options.color === 'always' || (options.color === 'auto' && stdout.isTTY === true && process.env.NO_COLOR === undefined);
  }

  get colorEnabled(): boolean {
    return this.enabled;
  }

  get quiet(): boolean {
    return this.options.responseMode === 'quiet';
  }

  get debug(): boolean {
    return this.options.responseMode === 'debug';
  }

  get verbose(): boolean {
    return this.options.responseMode === 'verbose' || this.debug;
  }

  get responseMode(): ResponseMode {
    return this.options.responseMode;
  }

  /**
   * Switch verbosity mid-session (`/verbose`, `/debug`, `/quiet`). The UI is
   * constructed once per process, so the mode has to be mutable for the slash
   * commands to mean anything.
   */
  setResponseMode(mode: ResponseMode): void {
    this.options.responseMode = mode;
  }

  color(name: ColorName, text: string): string {
    if (!this.enabled) return text;
    return `${CODES[name]}${text}${CODES.reset}`;
  }

  bold(text: string): string {
    return this.color('bold', text);
  }
  dim(text: string): string {
    return this.color('dim', text);
  }

  /** Standard output; suppressed entirely in quiet mode. */
  out(text = ''): void {
    if (this.quiet) return;
    this.stopSpinner();
    this.clearStreaming();
    stdout.write(`${text}\n`);
  }

  /** Always printed, even in quiet mode: results the user asked for. */
  result(text = ''): void {
    this.stopSpinner();
    this.clearStreaming();
    stdout.write(`${text}\n`);
  }

  info(text: string): void {
    this.out(`${this.color('cyan', '·')} ${text}`);
  }

  success(text: string): void {
    this.out(`${this.color('green', '✔')} ${text}`);
  }

  warn(text: string): void {
    this.stopSpinner();
    this.clearStreaming();
    stderr.write(`${this.color('yellow', '!')} ${text}\n`);
  }

  error(text: string): void {
    this.stopSpinner();
    this.clearStreaming();
    stderr.write(`${this.color('red', '✖')} ${text}\n`);
  }

  note(text: string): void {
    if (!this.verbose) return;
    this.stopSpinner();
    this.clearStreaming();
    stderr.write(`${this.color('gray', `[${text}]`)}\n`);
  }

  heading(text: string): void {
    this.out('');
    this.out(this.bold(text));
    this.out(this.dim('─'.repeat(Math.min(60, Math.max(12, text.length + 4)))));
  }

  keyValue(pairs: readonly [string, string][], indent = '  '): void {
    const width = Math.max(...pairs.map(([key]) => key.length), 0);
    for (const [key, value] of pairs) this.out(`${indent}${this.dim(key.padEnd(width))}  ${value}`);
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[]): void {
    if (rows.length === 0) {
      this.out(this.dim('  (nothing to show)'));
      return;
    }
    const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
    const render = (cells: readonly string[]): string =>
      cells.map((cell, i) => (cell ?? '').padEnd(widths[i] as number)).join('  ').trimEnd();
    this.out(`  ${this.dim(render(headers))}`);
    for (const row of rows) this.out(`  ${render(row)}`);
  }

  /** Streaming model output; keeps a single writer so chunks do not interleave. */
  stream(text: string): void {
    if (this.quiet) return;
    this.stopSpinner();
    this.streaming = true;
    stdout.write(text);
  }

  endStream(): void {
    if (this.streaming) {
      stdout.write('\n');
      this.streaming = false;
    }
  }

  private clearStreaming(): void {
    if (this.streaming) {
      stdout.write('\n');
      this.streaming = false;
    }
  }

  startSpinner(text: string): void {
    if (!this.options.spinner || !stdout.isTTY || this.quiet) return;
    this.spinnerText = text;
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      const frame = this.spinnerFrames[this.spinnerFrame % this.spinnerFrames.length] as string;
      this.spinnerFrame += 1;
      stdout.write(`\r${this.color('cyan', frame)} ${this.dim(this.spinnerText)}\u001b[K`);
    }, 90);
    this.spinnerTimer.unref?.();
  }

  updateSpinner(text: string): void {
    this.spinnerText = text;
  }

  stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      stdout.write('\r\u001b[K');
    }
  }

  /** Ask a yes/no question. Non-interactive streams default to "no". */
  async confirm(question: string, options: { detail?: string; defaultYes?: boolean } = {}): Promise<boolean> {
    this.stopSpinner();
    this.clearStreaming();
    if (!stdin.isTTY) {
      stderr.write(`${this.color('yellow', '!')} ${question} — not a terminal, assuming no\n`);
      return false;
    }
    if (options.detail) stderr.write(`${options.detail}\n`);
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      const answer = (await rl.question(`${this.color('yellow', '?')} ${question} ${this.dim(options.defaultYes ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
      if (answer === '') return options.defaultYes === true;
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  }

  async ask(question: string, fallback = ''): Promise<string> {
    this.stopSpinner();
    this.clearStreaming();
    if (!stdin.isTTY) return fallback;
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      const answer = (await rl.question(`${this.color('cyan', '?')} ${question} `)).trim();
      return answer === '' ? fallback : answer;
    } finally {
      rl.close();
    }
  }

  /** Ask for a secret without echoing it to the terminal or the scrollback. */
  async askSecret(question: string): Promise<string> {
    this.stopSpinner();
    this.clearStreaming();
    if (!stdin.isTTY) return '';
    const rl = createInterface({ input: stdin, output: stderr, terminal: true });
    const mutable = rl as unknown as { _writeToOutput?: (text: string) => void; output?: NodeJS.WriteStream };
    const original = mutable._writeToOutput;
    mutable._writeToOutput = () => {
      // Swallow the echo; the prompt itself is written before this is set.
    };
    try {
      const answer = await rl.question(`${this.color('cyan', '?')} ${question} `);
      stderr.write('\n');
      return answer.trim();
    } finally {
      mutable._writeToOutput = original;
      rl.close();
    }
  }
}

export function formatTokensShort(tokens: number): string {
  return formatCount(tokens);
}

export function describeSize(bytes: number): string {
  return formatBytes(bytes);
}

export function createUi(options: Partial<UiOptions> = {}): Ui {
  const env = process.env;
  const color: ColorMode =
    options.color ??
    (env.LOW_CONTEXT_NO_COLOR === '1' ? 'never' : env.LOW_CONTEXT_COLOR === 'always' ? 'always' : 'auto');
  const responseMode: ResponseMode =
    options.responseMode ??
    ((env.LOW_CONTEXT_RESPONSE_MODE as ResponseMode | undefined) ?? 'normal');
  return new Ui({ color, responseMode, spinner: options.spinner ?? true });
}
