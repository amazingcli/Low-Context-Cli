/**
 * Interactive slash-command registry and menu rendering (§28).
 *
 * Typing `/` in the interactive session opens a live, filtered menu of every
 * slash command: each keystroke narrows the list, arrows move, Enter runs.
 * This is the discovery surface for the whole agent — nobody should have to
 * know a command exists before they can use it. `/help` remains for people who
 * prefer text.
 *
 * This module is deliberately pure: the command table, the matcher and the
 * line renderer. Key handling and terminal control live in `prompt.ts`, which
 * keeps both testable without a TTY.
 */
/** Score how well `query` matches a command; lower is better, ∞ = no match. */
export function matchScore(spec, query) {
    if (query === '')
        return 0;
    const name = spec.name.toLowerCase();
    const q = query.toLowerCase();
    if (name === q)
        return 0;
    if (name.startsWith(q))
        return 1;
    if (name.includes(q))
        return 2;
    // Subsequence match ("mc" → "memory clear") so partial typing still finds things.
    let i = 0;
    for (const char of name)
        if (char === q[i])
            i += 1;
    if (i === q.length)
        return 3;
    if (spec.description.toLowerCase().includes(q))
        return 4;
    return Number.POSITIVE_INFINITY;
}
export function filterCommands(specs, query, limit = 8) {
    return specs
        .map((spec) => ({ spec, score: matchScore(spec, query) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((a, b) => a.score - b.score || a.spec.name.localeCompare(b.spec.name))
        .slice(0, limit)
        .map((entry) => entry.spec);
}
/**
 * Render the menu as plain lines (no cursor control — the caller positions).
 * Returns exactly the lines to display below the input line.
 */
export function renderMenuLines(filtered, query, selected, colors, width = 72) {
    const lines = [];
    lines.push(`${colors.cyan('/')}${query}${colors.dim('▌')}`);
    if (filtered.length === 0) {
        lines.push(colors.dim('  (no matching command — Enter runs the text, Esc cancels)'));
        return lines;
    }
    let lastGroup = '';
    for (let i = 0; i < filtered.length; i += 1) {
        const spec = filtered[i];
        if (spec.group !== lastGroup) {
            lines.push(colors.dim(`  ${'─'.repeat(3)} ${spec.group}`));
            lastGroup = spec.group;
        }
        const isSelected = i === selected;
        const marker = isSelected ? colors.cyan('›') : ' ';
        const name = isSelected ? colors.bold(colors.cyan(`/${spec.name}`)) : `/${spec.name}`;
        const args = spec.args ? colors.dim(` ${spec.args}`) : '';
        const description = spec.description;
        const padded = `${name}${args}`.length;
        const pad = ' '.repeat(Math.max(1, 26 - padded));
        const line = ` ${marker} ${name}${args}${pad}${isSelected ? description : colors.dim(description)}`;
        lines.push(line.length > width ? line.slice(0, width) : line);
    }
    lines.push(colors.dim('  ↑↓ move · Enter run · Tab complete · Esc close · type to filter'));
    return lines;
}
/** The full registry of interactive slash commands (§30). */
export const SLASH_COMMANDS = [
    // session
    { name: 'help', description: 'list every command with what it does', group: 'session' },
    { name: 'clear', description: 'new conversation (history stays on disk)', group: 'session' },
    { name: 'history', args: '[n]', description: 'show recent turns of this conversation', group: 'session' },
    { name: 'sessions', description: 'list saved sessions', group: 'session' },
    { name: 'resume', args: '<id>', description: 'resume a saved session in place', group: 'session' },
    { name: 'exit', description: 'end the session (everything is saved)', group: 'session' },
    { name: 'quit', description: 'end the session (everything is saved)', group: 'session' },
    // project
    { name: 'status', description: 'project, model, index and memory summary', group: 'project' },
    { name: 'index', description: 'refresh the project index now', group: 'project' },
    { name: 'map', args: '[module]', description: 'show the project map', group: 'project' },
    { name: 'files', args: '[query]', description: 'list or search indexed files', group: 'project' },
    { name: 'search', args: '<query>', description: 'search files and symbols', group: 'project' },
    { name: 'diff', description: 'show the working-tree diff', group: 'project' },
    { name: 'explain', args: '<request>', description: 'run with the retrieval trace shown', group: 'project' },
    // memory
    { name: 'memory', args: '[query]', description: 'list or search stored memory', group: 'memory' },
    { name: 'remember', args: '<text>', description: 'store a memory record', group: 'memory' },
    { name: 'forget', args: '<query>', description: 'delete matching memory records', group: 'memory' },
    { name: 'context', description: 'inspect the next request context budget', group: 'memory' },
    { name: 'usage', description: 'token usage for this session', group: 'memory' },
    // model
    { name: 'model', description: 'show the active model', group: 'model' },
    { name: 'models', description: 'list models and switch', group: 'model' },
    { name: 'providers', description: 'list providers and credential status', group: 'model' },
    { name: 'permissions', description: 'show permission mode and rules', group: 'model' },
    { name: 'nopermission', description: 'bypass permission prompts for this session (toggle)', group: 'model' },
    // system
    { name: 'tools', description: 'list available tools', group: 'system' },
    { name: 'verbose', description: 'toggle verbose tool output', group: 'system' },
    { name: 'debug', description: 'toggle debug (traces, reasons, policy)', group: 'system' },
    { name: 'quiet', description: 'toggle quiet mode (answers only)', group: 'system' },
    { name: 'doctor', description: 'diagnose the whole installation', group: 'system' },
];
//# sourceMappingURL=slash-menu.js.map