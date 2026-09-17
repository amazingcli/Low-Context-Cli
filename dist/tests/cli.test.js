import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { PermissionEngine } from '../src/tools/permissions.js';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import { filterCommands, matchScore, SLASH_COMMANDS } from '../src/cli/slash-menu.js';
import { parseKeys, visibleLength } from '../src/cli/prompt.js';
import { defaultConfig } from '../src/core/config.js';
/** Capture outbound requests instead of hitting the network. */
function captureFetch(payload) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
        const headers = {};
        for (const [key, value] of Object.entries((init?.headers ?? {})))
            headers[key.toLowerCase()] = value;
        calls.push({ url: String(input), headers });
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return { calls, restore: () => { globalThis.fetch = original; } };
}
test('Gemini authenticates with x-goog-api-key and never sends a Bearer token', async () => {
    const capture = captureFetch({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Flash', inputTokenLimit: 1_000_000 }] });
    try {
        // A `?key=` suffix must be stripped: it leaks the key into URLs and logs.
        const provider = new GeminiProvider('gemini', { baseUrl: 'https://example.test/v1beta?key=stale', apiKey: 'gem-key' });
        const models = await provider.listModels();
        assert.equal(capture.calls.length, 1);
        const call = capture.calls[0];
        assert.equal(call.headers['x-goog-api-key'], 'gem-key');
        assert.equal(call.headers.authorization, undefined, 'Bearer would make Google reject the key with HTTP 401');
        assert.ok(!call.url.includes('stale'), 'the baseUrl query key must be removed');
        assert.equal(models[0]?.id, 'gemini-2.5-flash');
        assert.equal(models[0]?.context_limit, 1_000_000);
    }
    finally {
        capture.restore();
    }
});
test('Anthropic authenticates with x-api-key, not Bearer', async () => {
    const capture = captureFetch({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] });
    try {
        const provider = new AnthropicProvider('anthropic', { baseUrl: 'https://example.test/v1', apiKey: 'ant-key' });
        const models = await provider.listModels();
        const call = capture.calls[0];
        assert.equal(call.headers['x-api-key'], 'ant-key');
        assert.equal(call.headers.authorization, undefined);
        assert.equal(call.headers['anthropic-version'], '2023-06-01');
        assert.equal(models[0]?.id, 'claude-sonnet-4-5');
    }
    finally {
        capture.restore();
    }
});
test('OpenAI-compatible providers use Bearer and tolerate both /models shapes', async () => {
    const capture = captureFetch({ data: [{ id: 'gpt-4o' }] });
    try {
        const provider = new OpenAIProvider('gateway', { baseUrl: 'https://example.test/v1', apiKey: 'gw-key' });
        const models = await provider.listModels();
        const call = capture.calls[0];
        assert.equal(call.headers.authorization, 'Bearer gw-key');
        assert.equal(call.url, 'https://example.test/v1/models');
        assert.equal(models[0]?.id, 'gpt-4o');
    }
    finally {
        capture.restore();
    }
    // Ollama-style servers answer with `models` instead of `data`.
    const second = captureFetch({ models: [{ name: 'qwen2.5-coder:7b' }] });
    try {
        const provider = new OpenAIProvider('local', { baseUrl: 'http://127.0.0.1:11434/v1' });
        const models = await provider.listModels();
        assert.equal(models[0]?.id, 'qwen2.5-coder:7b');
    }
    finally {
        second.restore();
    }
});
/* ------------------------------ permissions ------------------------------- */
const policy = {
    mode: 'ask',
    allow: [],
    deny: ['command:rm -rf /important'],
    allow_outside_project: false,
    require_confirmation_for_destructive: true,
};
test('the permission bypass removes prompts but never unlocks catastrophic commands', () => {
    const engine = new PermissionEngine(policy);
    const write = { summary: 'write file', resource: 'path', subject: 'src/a.ts', destructive: true };
    const bomb = { summary: 'wipe root', resource: 'command', subject: 'rm -rf /', destructive: true };
    const denied = { summary: 'denied path', resource: 'command', subject: 'rm -rf /important', destructive: true };
    assert.equal(engine.decide(write).prompt, true, 'ask mode prompts for a destructive write');
    engine.setBypass(true);
    assert.equal(engine.bypassing, true);
    assert.equal(engine.decide(write).prompt, false);
    assert.equal(engine.decide(write).allowed, true);
    assert.equal(engine.decide({ ...write, subject: 'src/b.ts' }).allowed, true, 'bypass is not per-subject');
    // The two safety floors stay in place (§20, §80).
    assert.equal(engine.decide(bomb).allowed, false, 'catastrophic commands stay refused');
    assert.equal(engine.decide(denied).allowed, false, 'deny rules still win');
    engine.setBypass(false);
    assert.equal(engine.decide(write).prompt, true);
});
/* ------------------------------- slash menu ------------------------------- */
test('the slash menu filters, ranks and never returns nothing useful', () => {
    const commands = SLASH_COMMANDS.map((spec) => spec.name);
    for (const expected of ['help', 'models', 'providers', 'history', 'nopermission', 'memory', 'context', 'doctor']) {
        assert.ok(commands.includes(expected), `${expected} must be discoverable in the menu`);
    }
    assert.equal(filterCommands(SLASH_COMMANDS, '')[0]?.name, 'clear', 'empty query lists the first commands alphabetically');
    assert.equal(filterCommands(SLASH_COMMANDS, 'pro')[0]?.name, 'providers', 'prefix beats substring');
    assert.equal(filterCommands(SLASH_COMMANDS, 'noperm')[0]?.name, 'nopermission');
    assert.equal(filterCommands(SLASH_COMMANDS, 'mem')[0]?.name, 'memory');
    assert.equal(filterCommands(SLASH_COMMANDS, 'model')[0]?.name, 'model');
    assert.ok(filterCommands(SLASH_COMMANDS, 'zzz').length === 0);
    assert.equal(matchScore({ name: 'exit', description: '', group: 'session' }, 'quit'), Number.POSITIVE_INFINITY);
});
/* --------------------------------- prompt --------------------------------- */
test('key parsing splits escape sequences, pastes and control keys', () => {
    assert.deepEqual(parseKeys('\u001b[A'), ['\u001b[A']);
    assert.deepEqual(parseKeys('\u001b[1;5C'), ['\u001b[1;5C']);
    assert.deepEqual(parseKeys('ab\u007f\r'), ['a', 'b', '\u007f', '\r']);
    assert.deepEqual(parseKeys('npm test'), ['n', 'p', 'm', ' ', 't', 'e', 's', 't']);
    // Width maths must ignore colour codes, or padding breaks.
    assert.equal(visibleLength('\u001b[36mhello\u001b[0m'), 5);
    assert.equal(visibleLength('plain'), 5);
});
/* ----------------------------- system prompt ------------------------------ */
test('the context-discipline rules scale with the model window', () => {
    const base = {
        config: defaultConfig(),
        projectRoot: '/tmp/project',
        projectName: 'demo',
        model: 'test-model',
        provider: 'test',
        toolNames: ['read_file', 'grep'],
    };
    const small = buildSystemPrompt({ ...base, contextLimit: 32_768 });
    assert.match(small, /Context discipline/);
    assert.match(small, /roughly 20k tokens/);
    assert.match(small, /This window is small/);
    assert.match(small, /do not keep/);
    const large = buildSystemPrompt({ ...base, contextLimit: 1_048_576 });
    assert.match(large, /roughly 629k tokens/);
    assert.match(large, /not permission to fill it/);
    assert.ok(!large.includes('This window is small'));
    // Memory is described as storage, never as training (§52).
    assert.match(large, /NOT model training/);
});
//# sourceMappingURL=cli.test.js.map