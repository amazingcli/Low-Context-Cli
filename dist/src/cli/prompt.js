/**
 * Interactive input line (§28).
 *
 * A raw-mode line editor with a live slash menu. As soon as the buffer starts
 * with `/`, matching commands are drawn under the prompt: typing filters,
 * arrows move the selection, Enter runs the highlighted command, Tab fills the
 * line, Esc closes the menu. Without the menu the same keys do the ordinary
 * things (history, cursor movement, clear line).
 *
 * Why this exists instead of readline: readline owns echo, so drawing a menu
 * *below* the line being typed means fighting its renderer, and it cannot show
 * a filtered command list at all. Here we control layout, so the redraw is one
 * erase-and-repaint per keystroke.
 *
 * Safety rules:
 *   - raw mode is only entered when stdin is a real TTY, and always restored
 *     in a `finally`;
 *   - any unexpected error falls back to a plain readline question, so a failed
 *     redraw can never wedge the session;
 *   - Ctrl-C returns `undefined` (cancel), Ctrl-D on an empty line returns
 *     `undefined` (end of session).
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { filterCommands, renderMenuLines } from './slash-menu.js';
import { visibleWidth } from './ui.js';
const ESC = '\u001b[';
/** Strip ANSI escapes so width maths uses visible characters. */
export const visibleLength = visibleWidth;
/** Split a raw stdin chunk into logical keys. */
export function parseKeys(input) {
    const keys = [];
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch === '\u001b') {
            const rest = input.slice(i);
            const match = /^\u001b\[[0-9;]*[A-Za-z~]|^\u001bO[A-Za-z]|^\u001b./.exec(rest);
            if (match) {
                keys.push(match[0]);
                i += match[0].length;
                continue;
            }
            keys.push(ch);
            i += 1;
            continue;
        }
        keys.push(ch);
        i += 1;
    }
    return keys;
}
const KEY = {
    up: (key) => key === `${ESC}A` || key === `${ESC}OA`,
    down: (key) => key === `${ESC}B` || key === `${ESC}OB`,
    right: (key) => key === `${ESC}C` || key === `${ESC}OC`,
    left: (key) => key === `${ESC}D` || key === `${ESC}OD`,
    home: (key) => key === `${ESC}H` || key === `${ESC}1~` || key === `${ESC}OH`,
    end: (key) => key === `${ESC}F` || key === `${ESC}4~` || key === `${ESC}OF`,
    delete: (key) => key === `${ESC}3~`,
};
function isPrintable(key) {
    if (key.length === 0)
        return false;
    const code = key.codePointAt(0);
    if (code < 0x20 || code === 0x7f)
        return false;
    return !key.startsWith('\u001b');
}
/**
 * Read one line. Falls back to a plain question when not a TTY or when the
 * redraw path throws.
 */
export async function readLine(options) {
    if (stdin.isTTY !== true)
        return plainReadLine(options.prompt);
    try {
        const line = await rawReadLine(options);
        return line;
    }
    catch {
        return plainReadLine(options.prompt);
    }
}
/**
 * Non-raw path. A TTY gets an ordinary question; a pipe or file gets a shared
 * line reader, so `echo "fix the bug" | lc` and scripted sessions keep working
 * exactly as they did before the menu existed.
 */
/**
 * The piped reader keeps its own queue. Readline emits every buffered line in
 * one burst, so a `once('line')` listener attached after the previous `await`
 * would miss everything that arrived in between — the queue makes scripted
 * input (`printf '/status\n/exit\n' | lc`) behave exactly like typing it.
 */
const pipedQueue = [];
const pipedWaiters = [];
let pipedDone = false;
let pipedStarted = false;
function startPiped() {
    const reader = createInterface({ input: stdin });
    reader.on('line', (line) => {
        const waiter = pipedWaiters.shift();
        if (waiter)
            waiter(line);
        else
            pipedQueue.push(line);
    });
    reader.on('close', () => {
        pipedDone = true;
        for (const waiter of pipedWaiters.splice(0))
            waiter(undefined);
    });
}
async function plainReadLine(prompt) {
    if (stdin.isTTY === true) {
        const rl = createInterface({ input: stdin, output: stdout, terminal: false });
        try {
            const answer = await rl.question(prompt);
            return { line: answer.trim(), ended: 'submitted' };
        }
        catch {
            return { line: undefined, ended: 'eof' };
        }
        finally {
            rl.close();
        }
    }
    if (!pipedStarted) {
        pipedStarted = true;
        startPiped();
    }
    const queued = pipedQueue.shift();
    if (queued !== undefined)
        return { line: queued.trim(), ended: 'submitted' };
    if (pipedDone)
        return { line: undefined, ended: 'eof' };
    const answer = await new Promise((resolve) => pipedWaiters.push(resolve));
    if (answer === undefined)
        return { line: undefined, ended: 'eof' };
    return { line: answer.trim(), ended: 'submitted' };
}
async function rawReadLine(options) {
    const columns = stdout.columns && stdout.columns > 20 ? stdout.columns : 80;
    const maxMenuRows = options.maxMenuRows ?? 9;
    const menuWidth = Math.min(columns, 78);
    let buffer = '';
    let cursor = 0;
    let menuOpen = false;
    let selected = 0;
    let filtered = [];
    const history = options.history ?? [];
    let historyIndex = history.length; // one past the end = "current draft"
    let draft = '';
    /**
     * Which row of the drawn block the caret currently sits on. Drawing parks
     * the caret on the input line (the menu is below it), so erasing must move
     * up by *that* offset — using the block height instead would climb into the
     * scrollback and eat the lines above the prompt.
     */
    let caretRow = 0;
    const out = (text) => stdout.write(text);
    /** Erase the block we drew last time, clearing everything below the caret. */
    const erase = () => {
        out(`\r${caretRow > 0 ? `${ESC}${caretRow}A` : ''}${ESC}0J`);
        caretRow = 0;
    };
    const refresh = () => {
        menuOpen = buffer.startsWith('/');
        const query = menuOpen ? buffer.slice(1) : '';
        filtered = menuOpen ? filterCommands(options.commands, query, maxMenuRows) : [];
        if (selected >= filtered.length)
            selected = Math.max(0, filtered.length - 1);
    };
    const draw = () => {
        const menuLines = menuOpen ? renderMenuLines(filtered, buffer.slice(1), selected, options.colors, menuWidth) : [];
        const text = options.prompt + buffer;
        const body = menuLines.length > 0 ? `${text}\n${menuLines.join('\n')}` : text;
        out(body);
        // Park the caret where the user is editing (menu sits below, so step back
        // over the menu rows first, then over the characters after the cursor).
        const menuRows = menuLines.length;
        if (menuRows > 0)
            out(`${ESC}${menuRows}A`);
        out('\r');
        const column = visibleLength(options.prompt) + cursor;
        const rowFromTop = Math.floor(column / columns);
        if (rowFromTop > 0)
            out(`${ESC}${rowFromTop}A`);
        const columnInRow = column % columns;
        out(columnInRow > 0 ? `${ESC}${columnInRow}C` : '');
        caretRow = rowFromTop;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return await new Promise((resolve) => {
        const finish = (result) => {
            stdin.off('data', onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            resolve(result);
        };
        /**
         * Leave the submitted line in the scrollback (menu erased) so the
         * transcript reads naturally, then hand the line to the caller.
         */
        const submit = (line) => {
            erase();
            out(`${options.prompt}${line}\n`);
            finish({ line: line.trim(), ended: 'submitted' });
        };
        const cancel = (ended) => {
            erase();
            out('\n');
            finish({ line: undefined, ended });
        };
        const acceptMenuSelection = () => {
            const spec = filtered[selected];
            if (!spec) {
                submit(buffer);
                return;
            }
            if (spec.args !== undefined && spec.args !== '') {
                // Needs an argument: complete the line and let the user type it.
                buffer = `/${spec.name} `;
                cursor = buffer.length;
                menuOpen = false;
                selected = 0;
                redraw();
                return;
            }
            submit(`/${spec.name}`);
        };
        const redraw = () => {
            erase();
            refresh();
            draw();
        };
        const replaceBuffer = (next) => {
            buffer = next;
            cursor = next.length;
            selected = 0;
            redraw();
        };
        const onData = (chunk) => {
            const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
            for (const key of parseKeys(text)) {
                if (key === '\u0003') {
                    // Ctrl-C: cancel this line, keep the session alive.
                    if (menuOpen) {
                        menuOpen = false;
                        redraw();
                        continue;
                    }
                    cancel('interrupted');
                    return;
                }
                if (key === '\u0004') {
                    if (buffer === '') {
                        cancel('eof');
                        return;
                    }
                    if (cursor < buffer.length) {
                        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
                        redraw();
                    }
                    continue;
                }
                if (key === '\r' || key === '\n') {
                    if (menuOpen && filtered.length > 0) {
                        acceptMenuSelection();
                        continue;
                    }
                    submit(buffer);
                    return;
                }
                if (key === '\t') {
                    const spec = filtered[selected];
                    if (menuOpen && spec)
                        replaceBuffer(`/${spec.name} `);
                    continue;
                }
                if (key === '\u001b') {
                    if (menuOpen) {
                        menuOpen = false;
                        redraw();
                    }
                    else {
                        buffer = '';
                        cursor = 0;
                        redraw();
                    }
                    continue;
                }
                if (KEY.up(key)) {
                    if (menuOpen) {
                        if (filtered.length > 0) {
                            selected = (selected - 1 + filtered.length) % filtered.length;
                            redraw();
                        }
                        continue;
                    }
                    if (history.length === 0)
                        continue;
                    if (historyIndex === history.length)
                        draft = buffer;
                    historyIndex = Math.max(0, historyIndex - 1);
                    buffer = history[historyIndex] ?? '';
                    cursor = buffer.length;
                    redraw();
                    continue;
                }
                if (KEY.down(key)) {
                    if (menuOpen) {
                        if (filtered.length > 0) {
                            selected = (selected + 1) % filtered.length;
                            redraw();
                        }
                        continue;
                    }
                    if (historyIndex >= history.length)
                        continue;
                    historyIndex = Math.min(history.length, historyIndex + 1);
                    buffer = historyIndex === history.length ? draft : history[historyIndex] ?? '';
                    cursor = buffer.length;
                    redraw();
                    continue;
                }
                if (KEY.left(key)) {
                    if (cursor > 0) {
                        cursor -= 1;
                        redraw();
                    }
                    continue;
                }
                if (KEY.right(key)) {
                    if (cursor < buffer.length) {
                        cursor += 1;
                        redraw();
                    }
                    continue;
                }
                if (KEY.home(key)) {
                    cursor = 0;
                    redraw();
                    continue;
                }
                if (KEY.end(key)) {
                    cursor = buffer.length;
                    redraw();
                    continue;
                }
                if (KEY.delete(key)) {
                    if (cursor < buffer.length) {
                        buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
                        redraw();
                    }
                    continue;
                }
                if (key === '\u007f' || key === '\b') {
                    if (cursor > 0) {
                        buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
                        cursor -= 1;
                        redraw();
                    }
                    continue;
                }
                if (key === '\u0015') {
                    // Ctrl-U: clear the line.
                    buffer = '';
                    cursor = 0;
                    redraw();
                    continue;
                }
                if (isPrintable(key)) {
                    // A pasted burst arrives as one chunk; insert it whole.
                    buffer = buffer.slice(0, cursor) + key + buffer.slice(cursor);
                    cursor += key.length;
                    selected = 0;
                    redraw();
                }
            }
        };
        stdin.on('data', onData);
        refresh();
        draw();
    });
}
//# sourceMappingURL=prompt.js.map