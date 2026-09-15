/**
 * Argument parsing (§29, §30).
 *
 * Deliberately tiny and dependency-free. The grammar is:
 *
 *   low-context [command] [subcommand] [positionals...] [--flags]
 *
 * Flags support `--flag`, `--flag=value`, `--flag value`, `-f value`,
 * `--no-flag` (boolean false) and repeated flags (collected into an array).
 * `--` stops flag parsing so a request containing dashes can be passed through.
 */
/** Commands that take a free-form second word rather than a subcommand. */
const VALUE_FLAGS = new Set([
    'provider',
    'model',
    'strategy',
    'mode',
    'limit',
    'type',
    'scope',
    'project',
    'home',
    'session',
    'conversation',
    'path',
    'depth',
    'since',
    'before',
    'format',
    'out',
    'timeout',
    'max',
    'api-key',
    'base-url',
    'name',
    'kind',
    'role',
    'id',
]);
export function parseArgs(argv) {
    const tokens = [...argv];
    const flags = {};
    const positionals = [];
    const restTokens = [];
    let sawSeparator = false;
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (sawSeparator) {
            restTokens.push(token);
            continue;
        }
        if (token === '--') {
            sawSeparator = true;
            continue;
        }
        if (token.startsWith('--')) {
            const body = token.slice(2);
            if (body.startsWith('no-')) {
                flags[body.slice(3)] = false;
                continue;
            }
            const eq = body.indexOf('=');
            if (eq !== -1) {
                setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
                continue;
            }
            const next = tokens[i + 1];
            const takesValue = VALUE_FLAGS.has(body) && next !== undefined && next !== '' && !next.startsWith('-');
            if (takesValue) {
                setFlag(flags, body, next);
                i += 1;
            }
            else {
                setFlag(flags, body, true);
            }
            continue;
        }
        if (token.startsWith('-') && token.length === 2) {
            const name = token.slice(1);
            const next = tokens[i + 1];
            const wantsValue = VALUE_FLAGS.has(longNameFor(name));
            if (wantsValue && next !== undefined && !next.startsWith('-')) {
                setFlag(flags, longNameFor(name), next);
                i += 1;
            }
            else {
                setFlag(flags, longNameFor(name), true);
            }
            continue;
        }
        positionals.push(token);
    }
    const command = positionals[0] ?? '';
    const knownSubcommands = SUBCOMMAND_COMMANDS.has(command);
    const subcommand = knownSubcommands ? positionals[1] : undefined;
    const restPositionals = knownSubcommands && isSubcommandWord(command, positionals[1]) ? positionals.slice(2) : positionals.slice(1);
    return {
        command,
        ...(subcommand === undefined ? {} : { subcommand }),
        positionals: restPositionals,
        flags,
        rest: restTokens.join(' '),
    };
}
const SUBCOMMAND_COMMANDS = new Set([
    'memory',
    'index',
    'session',
    'sessions',
    'provider',
    'providers',
    'model',
    'models',
    'config',
    'permissions',
    'logs',
    'map',
    'tools',
    'context',
]);
function isSubcommandWord(command, candidate) {
    if (candidate === undefined)
        return false;
    const table = {
        memory: ['list', 'search', 'show', 'delete', 'forget', 'rebuild', 'export', 'stats', 'supersede'],
        index: ['status', 'rebuild', 'refresh', 'drop'],
        session: ['list', 'resume', 'show', 'delete', 'end'],
        sessions: ['list', 'resume', 'show', 'delete', 'end'],
        provider: ['list', 'add', 'remove', 'test', 'enable', 'disable'],
        providers: ['list', 'add', 'remove', 'test', 'enable', 'disable'],
        model: ['list', 'use', 'show', 'test'],
        models: ['list', 'use', 'show', 'test'],
        config: ['show', 'get', 'set', 'path', 'edit', 'reset'],
        permissions: ['show', 'mode', 'allow', 'deny', 'reset'],
        logs: ['list', 'tail', 'path', 'prune'],
        map: ['file', 'module', 'tree'],
        tools: ['list', 'show'],
        context: ['show', 'explain'],
    };
    return (table[command] ?? []).includes(candidate);
}
function longNameFor(short) {
    const map = {
        h: 'help',
        v: 'version',
        q: 'quiet',
        d: 'debug',
        y: 'yes',
        m: 'model',
        p: 'provider',
        s: 'strategy',
        n: 'limit',
    };
    return map[short] ?? short;
}
function setFlag(flags, name, value) {
    const existing = flags[name];
    if (existing === undefined) {
        flags[name] = coerce(value);
        return;
    }
    if (Array.isArray(existing))
        existing.push(String(value));
    else
        flags[name] = [String(existing), String(value)];
}
function coerce(value) {
    if (typeof value === 'boolean')
        return value;
    if (/^-?\d+$/.test(value))
        return Number(value);
    return value;
}
export function flagString(flags, name) {
    const value = flags[name];
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    if (Array.isArray(value))
        return value[value.length - 1];
    return undefined;
}
export function flagNumber(flags, name) {
    const value = flags[name];
    if (typeof value === 'number')
        return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value))
        return Number(value);
    return undefined;
}
export function flagBool(flags, name) {
    const value = flags[name];
    if (value === undefined)
        return false;
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'string')
        return value === 'true' || value === '1' || value === 'yes';
    return false;
}
export function flagList(flags, name) {
    const value = flags[name];
    if (value === undefined)
        return [];
    if (Array.isArray(value))
        return value.map(String);
    return [String(value)];
}
//# sourceMappingURL=args.js.map